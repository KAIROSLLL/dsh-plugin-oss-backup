/**
 * 手动/批量备份（Host 半边）。
 *
 * 把用户指定的目录整棵上传到对象存储。三件事必须自己兜住，否则"点一下备份"很容易
 * 变成"把整块盘推上云"：
 *
 *   1. **排除目录**（{@link SKIP_DIRS}）：依赖与版本库元数据不该进备份；
 *   2. **三重限额**（{@link DEFAULT_LIMITS}）：文件数、单文件大小、总字节数 —— 任何一项越界就停；
 *   3. **逐个上传 + 失败不中断**：单个文件失败只记账，继续下一个（用户要的是"能备份多少算多少"）。
 *
 * 所有失败原因都过 {@link safeErrorMessage} 脱敏，凭证不可能出现在结果里。
 *
 * @module dsh-plugin-oss-backup/manual-backup
 */

import { readdir, stat } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { sanitizeObjectKeyTail } from './auto-backup.js'
import { safeErrorMessage } from './redact.js'
import type { FileFingerprint, UploadIndex } from './upload-index.js'

/** 遍历时整体跳过的目录名。 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.pnpm-store',
  '.npm-cache',
  '__pycache__',
  '.venv',
])

/** 限额。 */
export interface CollectLimits {
  /** 最多备份多少个文件。 */
  readonly maxFiles: number
  /** 单文件大小上限（字节）。 */
  readonly maxFileBytes: number
  /** 总字节数上限。 */
  readonly maxTotalBytes: number
}

/**
 * 默认限额。
 *
 * 刻意放得宽一些：手动备份的语义是"把整个文件夹传上去"，限额只用来防住
 * "误选了一个盘根目录"这种事故，不该在日常项目上截断
 * （早先的 400 文件 / 512 MB 对稍大的项目就偏紧了）。
 */
export const DEFAULT_LIMITS: CollectLimits = {
  maxFiles: 2000,
  maxFileBytes: 256 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
}

/** 一次遍历的结果。 */
export interface BackupPlan {
  /** 源目录（绝对路径）。 */
  readonly root: string
  /** 待上传文件的绝对路径（已按限额裁剪）。 */
  readonly files: readonly string[]
  /** 因命中排除名单而整体跳过的目录。 */
  readonly skippedDirs: readonly string[]
  /** 因限额被跳过的文件数。 */
  readonly skippedFiles: number
  /** 是否因为触到限额而提前停止。 */
  readonly truncated: boolean
  /** 待上传文件的总字节数。 */
  readonly totalBytes: number
  /** 遍历过程中读目录/取属性失败的文件数。 */
  readonly unreadable: number
  /**
   * 每个文件的指纹（`size` + `mtimeMs`），供上传阶段跳过"没变化"的文件。
   *
   * 遍历时本来就 `stat` 过一次，顺手记下来，省得上传阶段再 stat 一遍。
   * 取不到 `mtimeMs` 的文件**不会**出现在这里 —— 查重宁可漏跳，不能误跳。
   */
  readonly fingerprints: ReadonlyMap<string, FileFingerprint>
}

/** 可注入的遍历依赖（测试用）。 */
export interface CollectDeps {
  /** 读目录，默认 `node:fs/promises`。 */
  readonly readdir?: (path: string) => Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>>
  /** 取文件属性，默认 `node:fs/promises`。缺 `mtimeMs` 时该文件不参与查重。 */
  readonly stat?: (path: string) => Promise<{ size: number; mtimeMs?: number }>
}

/**
 * 遍历一个目录，算出"该备份哪些文件"。
 *
 * 不读文件内容、不建任何索引 —— 只把路径列出来，交给上传阶段逐个读。
 *
 * @param root - 源目录（绝对路径）。
 * @param limits - 限额。
 * @param deps - 可注入的 fs 实现。
 * @param skipDirs - 要整体跳过的目录名；传**空集合**就是"一个都不跳过"
 *   （设置里关掉"跳过缓存目录"时用，这样 `__pycache__` 之类也会被备份）。
 * @returns 备份计划。
 */
export async function collectBackupPlan(
  root: string,
  limits: CollectLimits = DEFAULT_LIMITS,
  deps: CollectDeps = {},
  skipDirs: ReadonlySet<string> = SKIP_DIRS,
): Promise<BackupPlan> {
  const list = deps.readdir ?? ((path: string) => readdir(path, { withFileTypes: true }))
  const statOf = deps.stat ?? ((path: string) => stat(path))

  const files: string[] = []
  const skippedDirs: string[] = []
  const fingerprints = new Map<string, FileFingerprint>()
  let skippedFiles = 0
  let unreadable = 0
  let totalBytes = 0
  let truncated = false

  /**
   * 递归遍历。
   *
   * @param dir - 当前目录。
   */
  const walk = async (dir: string): Promise<void> => {
    if (truncated) return
    let entries: Awaited<ReturnType<typeof list>>
    try {
      entries = await list(dir)
    } catch {
      unreadable += 1
      return
    }
    for (const entry of entries) {
      if (truncated) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) {
          skippedDirs.push(full)
          continue
        }
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      if (files.length >= limits.maxFiles) {
        truncated = true
        return
      }
      let size = 0
      let mtimeMs: number | undefined
      try {
        const info = await statOf(full)
        size = info.size
        mtimeMs = info.mtimeMs
      } catch {
        unreadable += 1
        continue
      }
      if (size > limits.maxFileBytes || totalBytes + size > limits.maxTotalBytes) {
        skippedFiles += 1
        continue
      }
      files.push(full)
      totalBytes += size
      // 顺手记下指纹：上传阶段据此判断"要不要跳过"。取不到 mtimeMs 就不记 ——
      // 查重宁可漏跳（多传一次），也不能误跳（漏掉一次真实的改动）。
      if (typeof mtimeMs === 'number' && Number.isFinite(mtimeMs)) {
        fingerprints.set(full, { size, mtimeMs })
      }
    }
  }

  await walk(root)
  return { root, files, skippedDirs, skippedFiles, truncated, totalBytes, unreadable, fingerprints }
}

/** 上传进度。 */
export interface ManualProgress {
  /** 总文件数。 */
  readonly total: number
  /** 已处理数。 */
  readonly done: number
  /** 已失败数。 */
  readonly failed: number
  /** 因"没变化"被跳过的数。 */
  readonly skipped: number
  /** 当前文件的键尾部。 */
  readonly current: string
}

/** 一次批量备份的结果。 */
export interface ManualResult {
  /** 计划里的文件总数。 */
  readonly total: number
  /** 成功上传数。 */
  readonly uploaded: number
  /** 失败数。 */
  readonly failed: number
  /** 因"内容没变、已经传过"而跳过的文件数。 */
  readonly skippedUnchanged: number
  /** 成功的总字节数。 */
  readonly bytes: number
  /** 是否因限额被截断。 */
  readonly truncated: boolean
  /** 被跳过的文件数（限额）。 */
  readonly skippedFiles: number
  /** 前几条失败原因（**已脱敏**）。 */
  readonly errors: readonly string[]
}

/** 批量备份的依赖。 */
export interface ManualBackupDeps {
  /** 备份计划。 */
  readonly plan: BackupPlan
  /** 对象键前缀。 */
  readonly prefix: string
  /** 上传实现。 */
  readonly upload: (input: { filePath: string; objectKey: string }) => Promise<{ bytes: number }>
  /** 进度回调（每个文件一次）。 */
  readonly onProgress?: (progress: ManualProgress) => void
  /** 路径 → 键尾部；默认取相对 root 的路径。 */
  readonly toKeyTail?: (root: string, filePath: string) => string
  /** 已上传文件索引；给了它就默认开启查重。 */
  readonly index?: UploadIndex
  /** 是否跳过没变化的文件；默认 = 是否提供了 {@link UploadIndex}。 */
  readonly skipUnchanged?: boolean
}

/** 结果里最多保留几条失败原因。 */
const MAX_ERRORS = 5

/**
 * 默认的键尾部：**保留被备份目录自身的名字** + 相对路径。
 *
 * 为什么必须带上 root 的名字：只取相对路径的话，备份 `D:/projects/yy` 得到的是
 * `11/…`、`22/…` —— 桶里完全看不出这些文件属于 `yy`，恢复或排查时也对不回去
 * （实测用户就是这么反馈的：备份了 11、22，却没有 yy）。
 *
 * @param root - 备份根目录。
 * @param filePath - 文件绝对路径。
 * @returns 键尾部（未净化）。
 */
function defaultKeyTail(root: string, filePath: string): string {
  const relativePath = relative(root, filePath).replace(/\\/g, '/')
  const rootName = basename(root).replace(/\\/g, '/')
  // 盘根（`D:/`）之类的 basename 会是空串，这时只能退回相对路径。
  if (rootName === '' || rootName === '.' || rootName === '/') return relativePath
  return `${rootName}/${relativePath}`
}

/**
 * 逐个上传计划里的文件。单个失败不中断整体。
 *
 * **会跳过"没变化"的文件**：计划里带指纹（遍历时的 `size` + `mtimeMs`），
 * 和 {@link ManualBackupDeps.index} 里记的一比就知道传过没传过 ——
 * 批量备份每次都会把整个目录走一遍，不查重的话几千个没动过的文件会被一遍遍重传。
 *
 * @param deps - 计划、前缀、上传实现、可选索引。
 * @returns 汇总结果。
 */
export async function runManualBackup(deps: ManualBackupDeps): Promise<ManualResult> {
  const { plan } = deps
  const toKeyTail = deps.toKeyTail ?? defaultKeyTail
  const index = deps.index
  // 没给索引就没法查重；给了索引则默认查重（用户要的就是"别老传一样的"）。
  const skipUnchanged = deps.skipUnchanged ?? index !== undefined
  const errors: string[] = []
  let uploaded = 0
  let failed = 0
  let skippedUnchanged = 0
  let bytes = 0

  for (const [position, filePath] of plan.files.entries()) {
    const tail = sanitizeObjectKeyTail(toKeyTail(plan.root, filePath))
    const objectKey = `${deps.prefix}${tail}`
    const fingerprint = plan.fingerprints.get(filePath)

    // 指纹与索引都齐全、且完全一致 → 这份内容已经在桶里了，跳过。
    if (
      skipUnchanged &&
      index !== undefined &&
      fingerprint !== undefined &&
      index.isUnchanged(objectKey, fingerprint)
    ) {
      skippedUnchanged += 1
    } else {
      try {
        const result = await deps.upload({ filePath, objectKey })
        uploaded += 1
        bytes += result.bytes
        // 只有真正传成功了才记账 —— 失败的文件下次还得再试。
        if (fingerprint !== undefined) index?.remember(objectKey, fingerprint)
      } catch (error) {
        failed += 1
        if (errors.length < MAX_ERRORS) errors.push(safeErrorMessage(error))
      }
    }
    deps.onProgress?.({
      total: plan.files.length,
      done: position + 1,
      failed,
      skipped: skippedUnchanged,
      current: tail,
    })
  }

  return {
    total: plan.files.length,
    uploaded,
    failed,
    skippedUnchanged,
    bytes,
    truncated: plan.truncated,
    skippedFiles: plan.skippedFiles,
    errors,
  }
}
