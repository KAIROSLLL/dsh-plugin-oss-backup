/**
 * 对象存储的**可达性探测**（Host 半边）。
 *
 * 为什么需要它：`describeOssEnvironment()` 只检查"环境变量配没配齐"，
 * 于是「变量都填好了、但 RustFS 根本没启动」也会显示成**就绪**。用户看着绿色就绪，
 * 实际上每次上传都在连接被拒 —— 自动备份反复失败，表现为"一直在跑"。
 *
 * 这里用最轻的 `HeadBucket` 真发一次请求，并把结果缓存起来（默认 30 秒），
 * 免得界面每 2 秒轮询一次就把请求打爆。探测失败**不影响任何功能**，
 * 它只负责如实告诉用户"现在连不上"。
 *
 * @module dsh-plugin-oss-backup/reachability
 */

import { HeadBucketCommand } from '@aws-sdk/client-s3'
import { readOssConfig, type OssConfig } from './env.js'
import { safeErrorMessage } from './redact.js'
import { createS3Client, type S3ClientLike } from './upload.js'

/** 一次探测的结果。 */
export interface ReachabilityProbe {
  /** 是否可达（连得上 + 凭证被接受 + 桶存在）。 */
  readonly reachable: boolean
  /** 探测时刻（毫秒时间戳）。 */
  readonly checkedAt: number
  /** 不可达的原因（**已脱敏**）；可达时为 `null`。 */
  readonly error: string | null
}

/** 探测结果的缓存时长（毫秒）：界面轮询很密，但真实探测不必那么频繁。 */
export const DEFAULT_PROBE_TTL_MS = 30_000

/** 探测自身的超时（毫秒）—— 它绝不能把界面拖住。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 4_000

/** 可注入的依赖（测试用）。 */
export interface ReachabilityDeps {
  /** 环境变量表，默认 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv
  /** 缓存时长。 */
  readonly ttlMs?: number
  /** 探测超时。 */
  readonly timeoutMs?: number
  /** 时钟，默认 `Date.now`。 */
  readonly now?: () => number
  /** S3 客户端工厂，默认 {@link createS3Client}。 */
  readonly createClient?: (config: OssConfig) => S3ClientLike
  /** 自定义探测动作（测试用）；默认对桶打一次 `HeadBucket`。 */
  readonly probe?: () => Promise<void>
}

/**
 * 给一个 promise 加超时。
 *
 * @param task - 待执行的任务。
 * @param ms - 超时毫秒数。
 * @returns 任务结果。
 * @throws {Error} 超时时抛出（消息里只有毫秒数，不含任何凭据）。
 */
async function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        // ⚠️ 这里**绝不能** unref()：unref 过的定时器在事件循环没有别的句柄时
        // 根本不会触发 —— 超时形同虚设，await 会永久挂住（实测退出码 13）。
        // 它很短命，且 finally 里会 clearTimeout，不会拖住进程退出。
        timer = setTimeout(() => reject(new Error(`probe timeout after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 带缓存的对象存储可达性探测器。
 *
 * 探测本身不会抛异常 —— 失败会被折叠成 `{ reachable: false, error }`，
 * 因为"连不上"是**正常状态**，不是需要冒泡的错误。
 */
export class Reachability {
  private readonly probeFn: () => Promise<void>

  private readonly ttlMs: number

  /** 探测超时（毫秒）。**统一在 {@link runProbe} 里套**，注入的 probe 也受保护。 */
  private readonly timeoutMs: number

  private readonly now: () => number

  private cached: ReachabilityProbe | null = null

  /** 正在进行的探测；并发调用共享它，避免同时打出好几个请求。 */
  private inflight: Promise<ReachabilityProbe> | null = null

  /**
   * @param deps - 可注入依赖。
   */
  constructor(deps: ReachabilityDeps = {}) {
    const env = deps.env ?? process.env
    this.ttlMs = deps.ttlMs ?? DEFAULT_PROBE_TTL_MS
    this.now = deps.now ?? (() => Date.now())
    const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    const createClient = deps.createClient ?? createS3Client

    this.timeoutMs = timeoutMs
    this.probeFn =
      deps.probe ??
      (async () => {
        const config = readOssConfig(env)
        const client = createClient(config)
        // 超时**不在这里**包 —— 统一由 runProbe 套上，这样注入的 probe 也受超时保护。
        await client.send(new HeadBucketCommand({ Bucket: config.bucket }))
      })
  }

  /** 最近一次探测结果（`null` = 还没探过）。 */
  get last(): ReachabilityProbe | null {
    return this.cached
  }

  /**
   * 取一次探测结果；缓存未过期就直接复用。
   *
   * @param force - 忽略缓存，强制重探。
   * @returns 探测结果（永不抛异常）。
   */
  async check(force = false): Promise<ReachabilityProbe> {
    const at = this.now()
    if (!force && this.cached !== null && at - this.cached.checkedAt < this.ttlMs) {
      return this.cached
    }
    if (this.inflight !== null) return this.inflight

    const running = this.runProbe(at)
    this.inflight = running
    try {
      return await running
    } finally {
      this.inflight = null
    }
  }

  /**
   * 上传失败时调用：把"不可达"立刻反映到界面上，不用等下一次探测。
   *
   * @param error - **已脱敏**的失败原因。
   */
  markUnreachable(error: string): void {
    this.cached = { reachable: false, checkedAt: this.now(), error }
  }

  /** 上传成功时调用：清掉不可达状态。 */
  markReachable(): void {
    this.cached = { reachable: true, checkedAt: this.now(), error: null }
  }

  /**
   * 真跑一次探测，并把结果写进缓存。
   *
   * @param at - 本次探测的时刻。
   * @returns 探测结果。
   */
  private async runProbe(at: number): Promise<ReachabilityProbe> {
    let result: ReachabilityProbe
    try {
      // 超时在这里统一套上：注入的 probe 也必须是"最多等 timeoutMs"，
      // 否则探测一旦不回话就会把界面和备份一起挂住。
      await withTimeout(this.probeFn(), this.timeoutMs)
      result = { reachable: true, checkedAt: at, error: null }
    } catch (error) {
      // 出口脱敏：SDK 的连接错误里可能夹带端点与签名信息。
      result = { reachable: false, checkedAt: at, error: safeErrorMessage(error) }
    }
    this.cached = result
    return result
  }
}
