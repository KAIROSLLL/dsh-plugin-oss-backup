/**
 * 批量备份的单元测试：目录遍历、排除名单、限额裁剪、上传与失败隔离。
 *
 * 遍历用假的 fs 实现（不碰真实磁盘），上传用假的 upload。
 *
 * @module tests/manual-backup.spec
 */

import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LIMITS,
  SKIP_DIRS,
  collectBackupPlan,
  runManualBackup,
  type BackupPlan,
  type CollectDeps,
} from '../src/manual-backup.js'

/** 哨兵凭证（不是真值）：用来断言失败原因被脱敏。 */
const ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE'

/** 一棵假目录树：路径 → 条目。 */
interface Entry {
  readonly name: string
  readonly type: 'dir' | 'file'
  readonly size?: number
}

/**
 * 造一套假的 fs 依赖。
 *
 * @param tree - 目录树（键是绝对路径）。
 * @returns 可注入的 readdir / stat。
 */
function fakeFs(tree: Record<string, Entry[]>): CollectDeps {
  const sizeOf = (path: string): number | undefined => {
    for (const entries of Object.values(tree)) {
      for (const entry of entries) {
        if (entry.type === 'file' && path.endsWith(entry.name)) return entry.size ?? 0
      }
    }
    return undefined
  }
  return {
    readdir: async (path: string) => {
      // `join()` 在 Windows 上产出反斜杠，而这里的树键统一用正斜杠 —— 归一化后再查。
      const key = path.replace(/\\/g, '/')
      const entries = tree[key]
      if (entries === undefined) throw new Error(`ENOENT: ${path}`)
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: () => entry.type === 'dir',
        isFile: () => entry.type === 'file',
      }))
    },
    stat: async (path: string) => {
      const size = sizeOf(path)
      if (size === undefined) throw new Error(`ENOENT: ${path}`)
      return { size }
    },
  }
}

/** 一个典型的小目录树。 */
const TREE: Record<string, Entry[]> = {
  'D:/ws': [
    { name: 'src', type: 'dir' },
    { name: 'node_modules', type: 'dir' },
    { name: '.git', type: 'dir' },
    { name: 'README.md', type: 'file', size: 100 },
  ],
  'D:/ws/src': [
    { name: 'index.ts', type: 'file', size: 200 },
    { name: 'util.ts', type: 'file', size: 300 },
  ],
  'D:/ws/node_modules': [{ name: 'dep.js', type: 'file', size: 10_000 }],
  'D:/ws/.git': [{ name: 'HEAD', type: 'file', size: 40 }],
}

describe('collectBackupPlan', () => {
  it('默认限额足够覆盖一个中等项目（日常项目不该被截断）', () => {
    expect(DEFAULT_LIMITS.maxFiles).toBeGreaterThanOrEqual(2000)
    expect(DEFAULT_LIMITS.maxFileBytes).toBeGreaterThanOrEqual(256 * 1024 * 1024)
    expect(DEFAULT_LIMITS.maxTotalBytes).toBeGreaterThanOrEqual(2 * 1024 * 1024 * 1024)
  })

  it('递归收集文件，并整体跳过多拉黑名单的目录', async () => {
    const plan = await collectBackupPlan('D:/ws', DEFAULT_LIMITS, fakeFs(TREE))

    expect(plan.files).toHaveLength(3)
    expect(plan.files.some((file) => file.endsWith('README.md'))).toBe(true)
    expect(plan.files.some((file) => file.endsWith('index.ts'))).toBe(true)
    // node_modules / .git 里的东西一个都不该进来。
    expect(plan.files.some((file) => file.includes('node_modules'))).toBe(false)
    expect(plan.files.some((file) => file.includes('.git'))).toBe(false)
    expect(plan.skippedDirs).toHaveLength(2)
    expect(plan.totalBytes).toBe(600)
    expect(plan.truncated).toBe(false)
  })

  it('排除名单里确实有 node_modules 与 .git', () => {
    expect(SKIP_DIRS.has('node_modules')).toBe(true)
    expect(SKIP_DIRS.has('.git')).toBe(true)
    // 用户明确问过为什么会漏 __pycache__ —— 它就在这里，默认被跳过。
    expect(SKIP_DIRS.has('__pycache__')).toBe(true)
  })

  it('传空集合 = 一个目录都不跳过（__pycache__ 之类也会被收集）', async () => {
    const withCaches: Record<string, Entry[]> = {
      ...TREE,
      // 注意：新目录既要建自己的键，也要挂进父目录的条目列表，否则遍历进不去。
      'D:/ws': [...(TREE['D:/ws'] ?? []), { name: '__pycache__', type: 'dir' }],
      'D:/ws/__pycache__': [{ name: 'mod.cpython-312.pyc', type: 'file', size: 42 }],
    }
    const plan = await collectBackupPlan('D:/ws', DEFAULT_LIMITS, fakeFs(withCaches), new Set())

    expect(plan.skippedDirs).toHaveLength(0)
    expect(plan.files.some((file) => file.endsWith('mod.cpython-312.pyc'))).toBe(true)
    expect(plan.files.some((file) => file.endsWith('dep.js'))).toBe(true)
    expect(plan.files.some((file) => file.endsWith('HEAD'))).toBe(true)
  })

  it('触到文件数上限就停，并标记 truncated', async () => {
    const plan = await collectBackupPlan('D:/ws', { ...DEFAULT_LIMITS, maxFiles: 2 }, fakeFs(TREE))
    expect(plan.files).toHaveLength(2)
    expect(plan.truncated).toBe(true)
  })

  it('超过单文件上限的直接跳过（不是截断）', async () => {
    const plan = await collectBackupPlan('D:/ws', { ...DEFAULT_LIMITS, maxFileBytes: 250 }, fakeFs(TREE))
    expect(plan.files.some((file) => file.endsWith('util.ts'))).toBe(false)
    expect(plan.skippedFiles).toBe(1)
    expect(plan.truncated).toBe(false)
  })

  it('超过总量上限的后续文件被跳过', async () => {
    const plan = await collectBackupPlan('D:/ws', { ...DEFAULT_LIMITS, maxTotalBytes: 250 }, fakeFs(TREE))
    // README(100) 收下之后：index(200) 与 util(300) 都会让总量越过 250 → 两个都被跳过。
    expect(plan.files).toHaveLength(1)
    expect(plan.skippedFiles).toBe(2)
  })

  it('目录读不到时只记 unreadable，不抛异常', async () => {
    const deps: CollectDeps = {
      readdir: async (path: string) => {
        if (path === 'D:/ws') return [{ name: 'a.ts', isDirectory: () => false, isFile: () => true }]
        throw new Error('EACCES')
      },
      stat: async () => ({ size: 5 }),
    }
    const plan = await collectBackupPlan('D:/ws', DEFAULT_LIMITS, deps)
    expect(plan.files).toHaveLength(1)
    expect(plan.unreadable).toBe(0)
  })
})

describe('runManualBackup', () => {
  /** 一份固定的计划。 */
  const plan: BackupPlan = {
    root: 'D:/ws',
    files: ['D:/ws/src/index.ts', 'D:/ws/README.md'],
    skippedDirs: [],
    skippedFiles: 0,
    truncated: false,
    totalBytes: 300,
    unreadable: 0,
  }

  it('逐个上传，统计成功数与字节数', async () => {
    const upload = vi.fn(async (input: { filePath: string; objectKey: string }) => ({ bytes: 10 }))
    const progress: number[] = []

    const result = await runManualBackup({
      plan,
      prefix: 'workspace-backup/',
      upload,
      onProgress: (p) => progress.push(p.done),
    })

    expect(upload).toHaveBeenCalledTimes(2)
    expect(result.uploaded).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.bytes).toBe(20)
    expect(progress).toEqual([1, 2])

    // 键：前缀 + **被备份目录自身的名字** + 相对路径（反斜杠转正斜杠、无冒号）。
    const keys = upload.mock.calls.map((call) => call[0].objectKey)
    expect(keys).toEqual(['workspace-backup/ws/src/index.ts', 'workspace-backup/ws/README.md'])
    for (const key of keys) expect(key).not.toContain(':')
  })

  it('键里保留被备份目录自身的名字（yy/11/… 而不是 11/…）', async () => {
    const upload = vi.fn(async (input: { filePath: string; objectKey: string }) => ({ bytes: 1 }))
    const nested: BackupPlan = {
      ...plan,
      root: 'D:/projects/yy',
      files: ['D:/projects/yy/11/a.txt', 'D:/projects/yy/22/b.txt'],
    }

    await runManualBackup({ plan: nested, prefix: 'workspace-backup/', upload })

    const keys = upload.mock.calls.map((call) => call[0].objectKey)
    expect(keys).toEqual(['workspace-backup/yy/11/a.txt', 'workspace-backup/yy/22/b.txt'])
  })

  it('单个文件失败只记账，不中断后面的文件', async () => {
    let call = 0
    const upload = vi.fn(async () => {
      call += 1
      if (call === 1) throw new Error('boom')
      return { bytes: 7 }
    })

    const result = await runManualBackup({ plan, prefix: 'bk/', upload })

    expect(upload).toHaveBeenCalledTimes(2)
    expect(result.uploaded).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.bytes).toBe(7)
    expect(result.errors).toHaveLength(1)
  })

  it('失败原因里的凭证值会被抹掉', async () => {
    const upload = vi.fn(async () => {
      throw new Error(`SignatureDoesNotMatch credential=${ACCESS_KEY}`)
    })
    const result = await runManualBackup({ plan, prefix: 'bk/', upload })
    expect(result.errors.join('\n')).not.toContain(ACCESS_KEY)
  })
})
