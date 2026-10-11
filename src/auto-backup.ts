/**
 * 自动备份（Host 半边）。
 *
 * 目标：工作区文件被 `write` / `edit` 工具改动后，自动上传到对象存储。**默认关闭**。
 *
 * 三个设计要点：
 *
 *   1. **防抖**（{@link DEFAULT_DEBOUNCE_MS}）：一次编辑往往连发多次写（工具重试、批量编辑），
 *      每个路径各挂一个定时器，文件"停止改动 2 秒"后才真正上传；同一路径的连续事件只留最后一个。
 *   2. **重试 + 指数退避**（{@link DEFAULT_RETRY_BACKOFF_MS}）：首次失败后等 1s、2s、4s 各重试一次，
 *      共 3 次重试；仍失败就放弃并记一条日志。
 *   3. **绝不阻塞主流程**：调用方（事件监听器）只做同步的"登记"，真正的上传在定时器里 fire-and-forget；
 *      所有异常都被吞进日志，且日志一律过 {@link safeErrorMessage} 脱敏（凭证不可能出现在这里）。
 *
 * @module dsh-plugin-oss-backup/auto-backup
 */

import { safeErrorMessage } from './redact.js'
import { uploadFileToOss, type UploadResult } from './upload.js'

/** 自动备份读取的环境变量名。 */
export const AUTO_BACKUP_ENV = {
  /** `true` 才启用；其它值（含未设置）都是关闭。 */
  enabled: 'OSS_AUTO_BACKUP',
  /** 对象键前缀。 */
  prefix: 'OSS_BACKUP_PREFIX',
} as const

/** 默认对象键前缀。 */
export const DEFAULT_BACKUP_PREFIX = 'workspace-backup/'

/** 默认防抖时长（毫秒）：文件停止修改这么久才上传。 */
export const DEFAULT_DEBOUNCE_MS = 2000

/** 默认指数退避表（毫秒）：1s / 2s / 4s，长度即重试次数。 */
export const DEFAULT_RETRY_BACKOFF_MS: readonly number[] = [1000, 2000, 4000]

/**
 * 连续失败多少次后**熔断**（暂停自动备份）。
 *
 * 服务没开的时候，每个改动的文件都要白等一轮退避（默认 1+2+4 = 7 秒）才放弃；
 * 模型连着改几个文件，观感就是"自动备份一直在跑，停不下来"。
 */
export const DEFAULT_FAILURE_THRESHOLD = 3

/** 熔断后的暂停时长（毫秒）。 */
export const DEFAULT_PAUSE_MS = 60_000

/**
 * 命中这些模式的失败**重试没有意义**，直接快速失败。
 *
 * 主要是连接类（服务没起、DNS 不对、网络不通）和凭证 / 桶类（配错了）：
 * 它们不会因为多等 4 秒就变好，只会让用户觉得插件卡住了。
 */
const FATAL_ERROR_PATTERNS: readonly RegExp[] = [
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /EHOSTUNREACH/i,
  /ENETUNREACH/i,
  /ECONNRESET/i,
  /EPIPE/i,
  /CredentialsError/i,
  /InvalidAccessKeyId/i,
  /SignatureDoesNotMatch/i,
  /AccessDenied/i,
  /NoSuchBucket/i,
]

/**
 * 判断一次失败是否**不值得重试**。
 *
 * @param reason - **已脱敏**的失败原因。
 * @returns 命中连接 / 凭证 / 桶类错误时为 `true`。
 */
export function isFatalUploadError(reason: string): boolean {
  return FATAL_ERROR_PATTERNS.some((pattern) => pattern.test(reason))
}

/** 自动备份配置。 */
export interface AutoBackupConfig {
  /** 是否启用。 */
  readonly enabled: boolean
  /** 对象键前缀（保证以 `/` 结尾）。 */
  readonly prefix: string
  /** 防抖时长（毫秒）。 */
  readonly debounceMs: number
  /** 退避表；`length` 就是重试次数。 */
  readonly backoffMs: readonly number[]
  /** 连续失败多少次后熔断（`0` = 不熔断）。 */
  readonly failureThreshold: number
  /** 熔断后的暂停时长（毫秒）。 */
  readonly pauseMs: number
}

/** 只用到两个方法的日志器（便于测试注入）。 */
export interface AutoBackupLogger {
  /**
   * 记一条信息。
   *
   * @param message - 文本。
   */
  info(message: string): void
  /**
   * 记一条告警。
   *
   * @param message - 文本。
   */
  warn(message: string): void
}

/**
 * 规范化对象键前缀：去掉前导斜杠、补上结尾斜杠；空值回退默认值。
 *
 * 前缀直接拼在文件名前面，所以"以 `/` 结尾"这件事必须由这里保证，
 * 否则会拼出 `workspace-backupsrc/index.ts` 这种键。
 *
 * @param raw - 原始值。
 * @returns 规范化后的前缀。
 */
export function normalizeBackupPrefix(raw: string | undefined): string {
  if (typeof raw !== 'string') return DEFAULT_BACKUP_PREFIX
  const trimmed = raw.trim().replace(/^\/+/, '')
  if (trimmed === '') return DEFAULT_BACKUP_PREFIX
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

/**
 * 读取自动备份配置。
 *
 * `OSS_AUTO_BACKUP` **只有**显式写成 `true`（忽略大小写与首尾空白）才算启用 ——
 * 默认关闭是硬要求，所以 `1` / `yes` / 空串都不算。
 *
 * @param env - 环境变量表，默认 `process.env`。
 * @returns 自动备份配置。
 */
export function readAutoBackupConfig(env: NodeJS.ProcessEnv = process.env): AutoBackupConfig {
  const rawEnabled = env[AUTO_BACKUP_ENV.enabled]
  return {
    enabled: typeof rawEnabled === 'string' && rawEnabled.trim().toLowerCase() === 'true',
    prefix: normalizeBackupPrefix(env[AUTO_BACKUP_ENV.prefix]),
    debounceMs: DEFAULT_DEBOUNCE_MS,
    backoffMs: DEFAULT_RETRY_BACKOFF_MS,
    failureThreshold: DEFAULT_FAILURE_THRESHOLD,
    pauseMs: DEFAULT_PAUSE_MS,
  }
}

/**
 * 把任意路径整理成**可安全用作对象键**的尾部。
 *
 * 三条缺一不可，第 2 条是真机踩出来的：
 *
 *   1. 反斜杠统一成正斜杠，去掉前导斜杠、压掉重复斜杠；
 *   2. **去掉 Windows 盘符**（`D:/x` → `x`）：RustFS 跑在 Windows 主机上时会明确拒绝含 `:`
 *      的对象键 —— `InvalidArgument: object key contains characters unsupported on Windows hosts`，
 *      不处理的话**每一次自动备份都会失败**（实测：事件、防抖、重试全都正常，只有上传被拒）；
 *   3. 兜底把 `* ? " | < >` 换成 `_`（同一份 Windows 限制清单里的其它字符）。
 *
 * @param raw - 原始尾部（可能是宿主路径、也可能是相对路径）。
 * @returns 净化后的尾部（保证非空）。
 */
export function sanitizeObjectKeyTail(raw: string): string {
  let tail = raw.replace(/\\/g, '/')
  // 盘符：`D:/...` → `...`（只剥开头那一个，不动文件名里可能出现的冒号）
  tail = tail.replace(/^[A-Za-z]:\//, '')
  // 其它 Windows 非法字符 → 下划线
  tail = tail.replace(/[*?"|<>]/g, '_')
  tail = tail.replace(/\/{2,}/g, '/').replace(/^\/+/, '')
  return tail === '' ? 'unnamed' : tail
}

/** 一次自动备份的结局（供调用方记录与展示）。 */
export interface AutoBackupOutcome {
  /** 源文件路径。 */
  readonly filePath: string
  /** 目标对象键。 */
  readonly objectKey: string
  /** 是否成功。 */
  readonly ok: boolean
  /** 成功时的字节数；失败时 0。 */
  readonly bytes: number
  /** 失败原因（**已脱敏**）；成功时为 null。 */
  readonly error: string | null
}

/** 可注入的依赖（测试用）。 */
export interface AutoBackupDeps {
  /** 配置。 */
  readonly config: AutoBackupConfig
  /** 日志器。 */
  readonly logger: AutoBackupLogger
  /** 上传实现，默认 {@link uploadFileToOss}。 */
  readonly upload?: (input: { filePath: string; objectKey: string }) => Promise<UploadResult>
  /** 路径 → 对象键尾部（默认取文件名）。 */
  readonly toKeyTail?: (filePath: string) => string
  /**
   * 一次上传开始前的回调（调用方据此点亮 UI 的"上传中"）。
   *
   * 抛错会被吞掉：调度器不能因为观察者出问题而中断。
   */
  readonly onStart?: () => void
  /**
   * 一次自动备份结束时的回调（成功与放弃都会调用）。
   *
   * 这是外界**唯一**能看到自动备份结果的出口：自动备份不走工具执行路径，
   * 因此不会经过宿主的 `busy` / `history`。回调抛错同样被吞掉。
   */
  readonly onResult?: (outcome: AutoBackupOutcome) => void
}

/**
 * 自动备份调度器：防抖 + 重试。
 *
 * 生命周期由插件 fiber 持有（`dispose()` 清掉所有待触发的定时器）。
 */
export class AutoBackup {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly inflight = new Set<string>()
  private readonly config: AutoBackupConfig
  private readonly logger: AutoBackupLogger
  private readonly upload: (input: { filePath: string; objectKey: string }) => Promise<UploadResult>
  private readonly toKeyTail: (filePath: string) => string
  private readonly onStart: (() => void) | undefined
  private readonly onResult: ((outcome: AutoBackupOutcome) => void) | undefined
  private disposed = false
  /** 连续失败次数（成功一次就清零）。 */
  private failureStreak = 0
  /** 熔断解除时刻；`0` = 未熔断。 */
  private pausedUntil = 0

  /**
   * @param deps - 配置、日志与可注入实现。
   */
  constructor(deps: AutoBackupDeps) {
    this.config = deps.config
    this.logger = deps.logger
    this.upload = deps.upload ?? ((input) => uploadFileToOss(input))
    // 默认键尾 = **完整路径**：交给 sanitizeObjectKeyTail 剥盘符、统一斜杠，
    // 这样能保留目录结构，与手动备份的规则一致。
    //
    // ⚠️ 这里绝不能用 path.basename：它在不同平台上对同一输入给出**不同结果** ——
    //   · Windows：'D:\ws\src\index.ts' → 'index.ts'，**整个目录结构丢了**，
    //     于是 D:/a/src/x.ts 与 D:/b/src/x.ts 会撞成同一个对象键、**互相覆盖**（数据丢失）；
    //   · Linux：反斜杠不是分隔符，basename 反而原样返回、结构得以保留。
    // 这个跨平台不一致是 CI（Linux）把一个在 Windows 上通过的测试跑挂之后才暴露出来的。
    this.toKeyTail = deps.toKeyTail ?? ((filePath) => filePath)
    this.onStart = deps.onStart
    this.onResult = deps.onResult
  }

  /** 待触发 + 正在上传的路径数量（供测试与 UI 观察）。 */
  get pending(): number {
    return this.timers.size + this.inflight.size
  }

  /** 是否处于熔断暂停中（服务连不上时会短暂为 `true`）。 */
  get paused(): boolean {
    return this.pausedUntil > Date.now()
  }

  /** 熔断解除的时刻；未熔断为 `0`。 */
  get pausedUntilMs(): number {
    return this.pausedUntil
  }

  /** 当前连续失败次数。 */
  get failures(): number {
    return this.failureStreak
  }

  /**
   * 登记一次文件变更。
   *
   * **同步返回**：调用方（事件监听器）不会被上传拖住。同一路径重复调用只重置防抖计时。
   *
   * @param filePath - 被改动的文件路径。
   */
  schedule(filePath: string): void {
    if (this.disposed || !this.config.enabled) return
    // 熔断期间直接丢弃，**不排队**：服务没开的时候把变更堆起来，只会让
    // "一直在跑"的观感更糟；等恢复后补传一堆过期文件也没有意义。
    if (this.paused) return
    const normalized = filePath.trim()
    if (normalized === '') return

    const existing = this.timers.get(normalized)
    if (existing !== undefined) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.timers.delete(normalized)
      void this.run(normalized)
    }, this.config.debounceMs)
    // unref：待触发的自动备份不该拖住宿主进程退出。
    if (typeof timer.unref === 'function') timer.unref()
    this.timers.set(normalized, timer)
  }

  /** 清掉所有待触发的定时器（插件卸载时调用）。 */
  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /**
   * 真正跑一次上传（含重试）。
   *
   * @param filePath - 文件路径。
   */
  private async run(filePath: string): Promise<void> {
    const objectKey = this.buildObjectKey(filePath)
    this.inflight.add(filePath)
    this.notifyStart()
    try {
      const result = await this.uploadWithRetry(filePath, objectKey)
      if (result.ok) {
        this.failureStreak = 0
        this.logger.info(`[oss-backup] 自动备份完成：${objectKey}（${result.bytes} 字节）`)
      } else {
        this.noteFailure(result.error)
      }
      this.notifyResult({
        filePath,
        objectKey,
        ok: result.ok,
        bytes: result.ok ? result.bytes : 0,
        error: result.ok ? null : result.error,
      })
    } finally {
      this.inflight.delete(filePath)
    }
  }

  /**
   * 记一次失败，必要时**熔断**。
   *
   * 连续失败到阈值就暂停一段时间，期间新来的变更会被 {@link schedule} 直接丢掉 ——
   * 这是"服务没开时自动备份一直在跑"的根治手段。
   *
   * @param reason - **已脱敏**的失败原因。
   */
  private noteFailure(reason: string): void {
    this.failureStreak += 1
    const { failureThreshold, pauseMs } = this.config
    if (failureThreshold <= 0 || this.failureStreak < failureThreshold || this.paused) return
    this.pausedUntil = Date.now() + pauseMs
    this.logger.warn(
      `[oss-backup] 自动备份连续失败 ${this.failureStreak} 次，已暂停 ${Math.round(pauseMs / 1000)} 秒（期间的文件改动会被跳过）—— ${reason}`,
    )
  }

  /** 安全地调用 `onStart`（观察者出错不能影响调度器）。 */
  private notifyStart(): void {
    try {
      this.onStart?.()
    } catch {
      /* 观察者异常一律吞掉 */
    }
  }

  /**
   * 安全地调用 `onResult`。
   *
   * @param outcome - 本次结局。
   */
  private notifyResult(outcome: AutoBackupOutcome): void {
    try {
      this.onResult?.(outcome)
    } catch {
      /* 观察者异常一律吞掉 */
    }
  }

  /**
   * 拼对象键：前缀 + **已净化**的尾部。
   *
   * @param filePath - 文件路径。
   * @returns 对象键。
   */
  private buildObjectKey(filePath: string): string {
    return `${this.config.prefix}${sanitizeObjectKeyTail(this.toKeyTail(filePath))}`
  }

  /**
   * 带指数退避的上传。
   *
   * 尝试次数 = 退避表长度 + 1（首次 + 每次退避后的重试）；全部失败返回失败结局并记日志。
   *
   * **连接 / 凭证 / 桶类错误不重试**（见 {@link isFatalUploadError}）：服务没开的时候，
   * 每个文件都白等 7 秒才放弃，模型连着改几个文件就会让人觉得"插件卡住了"。
   *
   * @param filePath - 文件路径。
   * @param objectKey - 目标对象键。
   * @returns 结局：成功带字节数，失败带**已脱敏**的原因。
   */
  private async uploadWithRetry(
    filePath: string,
    objectKey: string,
  ): Promise<{ ok: true; bytes: number } | { ok: false; error: string }> {
    const backoff = this.config.backoffMs
    let reason = 'unknown error'
    for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
      try {
        const result = await this.upload({ filePath, objectKey })
        return { ok: true, bytes: result.bytes }
      } catch (error) {
        // 出口脱敏：失败原因里可能夹带 SDK 的签名串，绝不能原样进日志。
        reason = safeErrorMessage(error)
        // 连不上 / 凭证错 / 桶不存在：重试只是白白拖时间，直接失败。
        if (isFatalUploadError(reason)) {
          this.logger.warn(`[oss-backup] 自动备份失败（不可重试，不再重试）：${objectKey} —— ${reason}`)
          return { ok: false, error: reason }
        }
        const wait = backoff[attempt]
        if (wait === undefined) {
          this.logger.warn(
            `[oss-backup] 自动备份失败，已重试 ${backoff.length} 次后放弃：${objectKey} —— ${reason}`,
          )
          return { ok: false, error: reason }
        }
        this.logger.warn(
          `[oss-backup] 自动备份失败（第 ${attempt + 1} 次尝试，${wait}ms 后重试）：${objectKey} —— ${reason}`,
        )
        await this.sleep(wait)
      }
    }
    return { ok: false, error: reason }
  }

  /**
   * 等待一段时间。
   *
   * @param ms - 毫秒。
   * @returns 到点后 resolve。
   */
  private sleep(ms: number): Promise<void> {
    // ⚠️ 不要 unref()：unref 过的定时器在事件循环没有别的句柄时不会触发，
    // 退避重试会静默地变成"永不重试"。这里是短命等待，到点即清。
    return new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  }
}
