/**
 * dsh-plugin-oss-backup —— 宿主半边（Host half）。
 *
 * 职责：注册 `oss_backup` 工具，把工作区文件上传到 S3 兼容对象存储。
 * 它是**唯一**接触凭证的半边：AK/SK 从 `RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY`
 * 环境变量读取，只在建 `S3Client` 时用一次。
 *
 * 安全边界（三条都靠代码结构保证，而不是靠自觉）：
 *   1. Client 半边跑在浏览器沙箱（只有 ctx/React/host/styles/console，没有 process），
 *      它连读环境变量的能力都不存在 —— 凭证不可能下发到页面；
 *   2. 本文件与 env/upload/redact 都不写任何文件，凭证不落盘；
 *   3. 所有对外字符串（错误、状态路由、加载日志）都只含**变量名或存在性**，
 *      出口另有 {@link redactSecrets} 兜底替换。
 *
 * @module dsh-plugin-oss-backup
 */

import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  AutoBackup,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_PAUSE_MS,
  DEFAULT_RETRY_BACKOFF_MS,
  type AutoBackupConfig,
} from './auto-backup.js'
import {
  optionalService,
  type PluginContext,
  type ToolExecutionLike,
  type ToolExecutionOutcomeLike,
  type WebRequestLike,
  type WebResponseLike,
  type WebServerLike,
} from './context.js'
import {
  createCredentialStore,
  isCredentialStoreEnabled,
  type CredentialStore,
  type StoredCredentials,
} from './credential-store.js'
import { hydrateEnvironment } from './env-source.js'
import {
  describeOssEnvironment,
  ENV_NAMES,
  MissingEnvironmentError,
  PROVIDER_ENV,
  providerProfile,
  readProvider,
} from './env.js'
import {
  collectBackupPlan,
  runManualBackup,
  type ManualProgress,
  type ManualResult,
} from './manual-backup.js'
import { redactSecrets, safeErrorMessage } from './redact.js'
import { Reachability } from './reachability.js'
import { describeSchedule, nextRunAt } from './schedule.js'
import { DEFAULT_SETTINGS, dshHome, readSettings, writeSettings, type PluginSettings } from './settings.js'
import { uploadFileToOss } from './upload.js'

/** 插件名（与 npm 包名一致；cordis loader entry 也用它）。 */
export const name = 'dsh-plugin-oss-backup'

/**
 * 依赖工具注册表（注册 `oss_backup`）与 web 载体（脱敏状态路由 + 上传中那张图）。
 *
 * ⚠️ `webServer` 必须是**硬依赖**：早先用 `ctx.get('webServer')` 软取，
 * `apply` 阶段服务可能尚未就绪 → 静默走 warn 分支 → 两条路由一个都没注册、
 * 设置页永远显示"未连接"（curl `/oss-backup/state` 拿到 404 才发现）。
 * 写成 `inject` 后，cordis 会等服务就绪再调用 `apply`。
 */
export const inject = ['tools', 'webServer']

/** 注册给模型的工具名。 */
export const TOOL_NAME = 'oss_backup'

/** 供设置页/侧边栏读取脱敏状态的宿主路由。 */
export const STATE_ROUTE = '/oss-backup/state'

/** 上传中弹出那张图的宿主路由（直接吐包内 assets 的字节，不做 base64）。 */
export const SHOT_ROUTE = '/oss-backup/asset/shot'

/** 读写设置的路由：`GET` 读、`POST` 存。 */
export const SETTINGS_ROUTE = '/oss-backup/settings'

/** 触发一次手动备份的路由：`POST`，异步执行，进度靠 `/state` 轮询。 */
export const RUN_ROUTE = '/oss-backup/run'

/**
 * 从设置页注入凭证的路由：`POST`。
 *
 * 收到的 AK/SK 会被**立刻写进宿主的 `process.env`**（按当前 provider 的变量名），
 * 于是 `readOssConfig()` 等既有代码一行都不用改就生效。值不进磁盘、不进日志、不回显。
 */
export const CREDENTIALS_ROUTE = '/oss-backup/credentials'

/** 本文件所在目录（构建产物是 `lib/`）；包内素材在 `../assets`。 */
const HERE = dirname(fileURLToPath(import.meta.url))

/** 上传中那张图的绝对路径。 */
const SHOT_FILE = join(HERE, '..', 'assets', 'code-uploading.jpg')

/** 历史记录保留条数（滚动覆盖）。 */
const HISTORY_LIMIT = 20

/** 一条上传记录（**不含任何机密**）。 */
export interface UploadRecord {
  /** 上传时刻（ISO 字符串）。 */
  readonly at: string
  /** 已脱敏的对象键。 */
  readonly objectKey: string
  /** 字节数。 */
  readonly bytes: number
}

/**
 * `busy` 结束后的**最短可见时长**（毫秒）。
 *
 * 为什么需要它：上传由模型调用工具触发，界面事先并不知道，只能靠轮询发现。
 * 而一次本机回环上传可能只有几百毫秒 —— 等界面下一次轮询（2 秒）时 busy 早已复位，
 * 那张图就永远弹不出来（实测：400 MiB 上传 + 150ms 采样都没抓到 busy=true）。
 * 所以让 busy 结束后再对外"显示"这么久，界面必定采得到，图稳定可见而不是一闪而过。
 */
const BUSY_VISIBLE_MS = 2500

/** 最近一次自动备份的结果（**不含任何机密**，错误原因已脱敏）。 */
export interface AutoBackupRecord {
  /** 时刻（ISO）。 */
  readonly at: string
  /** 源文件路径（已脱敏）。 */
  readonly filePath: string
  /** 目标对象键（已脱敏）。 */
  readonly objectKey: string
  /** 是否成功。 */
  readonly ok: boolean
  /** 成功时的字节数。 */
  readonly bytes: number
  /** 失败原因（已脱敏）；成功时 null。 */
  readonly error: string | null
}

/** 插件运行期状态。 */
interface PluginState {
  /** 最近一次上传。 */
  last: UploadRecord | null
  /** 上传历史（新 → 旧）。 */
  history: UploadRecord[]
  /**
   * 是否有上传正在进行。
   *
   * 只服务界面：设置页/侧边栏据此弹出那张图、并把轮询间隔调快。
   * 它是纯展示状态，不参与任何鉴权或调度判断。
   */
  busy: boolean
  /**
   * busy 结束后继续对外报"上传中"的截止时刻（epoch ms）。
   *
   * 与 {@link BUSY_VISIBLE_MS} 配合，解决"上传太快、界面轮询采不到"的问题。
   */
  busyUntil: number
  /**
   * 最近一次**自动备份**的结果。
   *
   * 自动备份不走工具执行路径（它直接调 uploadFileToOss），所以不会经过
   * `busy` / `remember()` 那条线；没有这个字段，外界完全看不到它是成了还是失败了。
   */
  lastAuto: AutoBackupRecord | null
  /** 手动批量备份的运行态（没跑过时为 null）。 */
  manual: ManualRunState | null
}

/** 手动批量备份的运行态。 */
export interface ManualRunState {
  /** 是否正在跑。 */
  readonly running: boolean
  /** 开始时刻（ISO）。 */
  readonly startedAt: string
  /** 源目录。 */
  readonly root: string
  /** 当前进度。 */
  readonly progress: ManualProgress
  /** 结束后的汇总（运行中为 null）。 */
  readonly result: ManualResult | null
}

/**
 * 把记录写进内存状态。
 *
 * 对象键来自模型参数，理论上可能夹带机密串，所以入库前统一脱敏。
 *
 * @param state - 插件状态。
 * @param record - 待写入的记录（objectKey 会自动脱敏）。
 */
function remember(state: PluginState, record: UploadRecord): void {
  const safe: UploadRecord = { ...record, objectKey: redactSecrets(record.objectKey) }
  state.last = safe
  state.history = [safe, ...state.history].slice(0, HISTORY_LIMIT)
}

/**
 * 写一个 JSON 响应。
 *
 * @param response - 响应对象。
 * @param status - 状态码。
 * @param payload - 可序列化的值。
 */
function sendJson(response: WebResponseLike, status: number, payload: unknown): void {
  let body: string
  try {
    body = JSON.stringify(payload)
  } catch (error) {
    body = JSON.stringify({ ok: false, error: safeErrorMessage(error) })
  }
  // 保守做法：即使序列化出意外，也过一遍出口脱敏。
  body = redactSecrets(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body, 'utf8')),
  })
  response.end(body)
}

/**
 * 读一个 JSON 请求体（带字节上限）。
 *
 * @param request - 请求。
 * @param limit - 最大字节数。
 * @returns 解析后的值；空体给 `{}`。
 */
function readJsonBody(request: WebRequestLike, limit = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    request.on('error', (error) => reject(error instanceof Error ? error : new Error(String(error))))
  })
}

/**
 * 插件入口：注册工具，并挂上状态 / 设置 / 手动备份 / 上传中那张图四条路由。
 *
 * @param ctx - 宿主上下文。
 */
export function apply(ctx: PluginContext): void {
  const state: PluginState = {
    last: null,
    history: [],
    busy: false,
    busyUntil: 0,
    lastAuto: null,
    manual: null,
  }

  // 验收要求：加载时打印日志。这里只报变量**名**，不报任何值。
  ctx.logger.info(
    `[oss-backup] 已加载：注册工具 ${TOOL_NAME}；凭证只读环境变量 ${ENV_NAMES.accessKeyId} / ${ENV_NAMES.secretAccessKey}（不落盘、不进日志）`,
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool<{ filePath: string; objectKey: string }, string>({
          name: TOOL_NAME,
          description:
            '把本地文件上传到 S3 兼容对象存储（RustFS / 阿里云 OSS / AWS S3）。' +
            '凭证由宿主环境变量提供，不能也不需要通过参数传入。',
          parameters: {
            filePath: {
              type: 'string',
              required: true,
              description: '本地文件的绝对路径（例如 D:\\\\backup\\\\report.tar.gz）。',
            },
            objectKey: {
              type: 'string',
              required: true,
              description: '目标对象键：存储桶内的完整路径（例如 backups/2026/report.tar.gz）。',
            },
          },
          output: {
            schema: { type: 'string', description: '形如 `Uploaded: <objectKey> (<bytes> bytes)` 的单行结果。' },
            render: (_args, value) => [{ type: 'text', text: value }],
          },
          async execute(args) {
            // 已确认连不上时**直接拒绝**，不去白跑一趟上传（连接类错误本来也重试无意义）。
            if (!uploadAllowed()) {
              throw new Error(`${uploadBlockedReason()} —— 已暂停上传，请确认服务已启动、端点与桶名正确。`)
            }
            // busy 纯粹是界面信号：让设置页/侧边栏在上传期间弹出那张图。
            state.busy = true
            try {
              const result = await uploadFileToOss({
                filePath: args.filePath,
                objectKey: args.objectKey,
              })
              remember(state, {
                at: new Date().toISOString(),
                objectKey: result.objectKey,
                bytes: result.bytes,
              })
              // 只回显对象键与字节数：这里绝不带端点、更不带凭证。
              return result.message
            } finally {
              state.busy = false
              // 再多报"上传中"一小会儿：否则界面 2 秒一次的轮询根本采不到（实测踩过）。
              state.busyUntil = Date.now() + BUSY_VISIBLE_MS
            }
          },
        }),
      ),
    'oss-backup: 注册 oss_backup 工具',
  )

  // ── 设置与自动备份 ─────────────────────────────────────────────────────────
  // 开关与备份目录由**界面**控制（落盘在 ~/.dsh/oss-backup/config.json），
  // 不再靠环境变量下达开关命令。凭证仍然只从环境变量读，配置文件里没有任何机密。
  let settings: PluginSettings = DEFAULT_SETTINGS
  let autoBackup: AutoBackup | null = null

  /**
   * 对象存储的可达性探测器。
   *
   * 存在的理由：`describeOssEnvironment()` 只检查环境变量**配没配齐**，
   * 于是「变量都填了、但 RustFS 没启动」也会显示成就绪。用户看着绿色就绪，
   * 实际每次上传都在连接被拒。这个探测器真发一次 `HeadBucket` 来确认。
   */
  const reachability = new Reachability()

  /**
   * 现在是否允许上传。
   *
   * 可达性**还没探过**（`null`）时乐观放行 —— 否则插件一装好就把功能全锁住，
   * 连"第一次试一下"都做不到。让操作自己去撞错误，再由上传结果把状态修正过来。
   *
   * 一旦**确认连不上**，就从源头不给上传入口：工具、手动备份、自动备份、定期备份一并拦。
   */
  const uploadAllowed = (): boolean => {
    const last = reachability.last
    return last === null || last.reachable
  }

  /** 上传被拦下时的说明（**已脱敏**），供工具与路由共用。 */
  const uploadBlockedReason = (): string => {
    const last = reachability.last
    return last === null || last.error === null
      ? '对象存储当前不可用'
      : `对象存储连不上：${last.error}`
  }

  /**
   * 本次会话里通过设置页注入过值的环境变量名（**只记名字，不记值**）。
   *
   * 用来在界面上如实区分"凭证来自启动时的环境变量"还是"本次会话现填的"。
   */
  const sessionInjected = new Set<string>()

  /**
   * 可选的凭证持久化后端：**延后到"系统环境补读"之后再创建**。
   *
   * 顺序很关键 —— 用户可能是刚 `setx OSS_CREDENTIAL_STORE os` 的，而当前进程没继承到；
   * 先补读再判断，才能让"设完就生效"成立。
   */
  let credentialStore: CredentialStore | null = null

  /** 本次启动里从**系统环境**补读到的变量名（只有名字）—— `setx` 过但进程没继承到的那种。 */
  const fromOsEnv = new Set<string>()

  /**
   * 把已加密保存的凭证灌进环境变量。
   *
   * 解密失败（换了机器 / 换了 Windows 账户）时后端会自己清掉坏文件并返回 `null`，
   * 所以这里不必额外处理 —— 用户重填一次即可。
   */
  const loadStoredCredentials = async (): Promise<void> => {
    if (credentialStore === null) return
    try {
      const stored = await credentialStore.load()
      if (stored === null) return
      const { provider } = readProvider()
      const profile = providerProfile(provider)
      process.env[profile.env.accessKeyId] = stored.accessKeyId
      process.env[profile.env.secretAccessKey] = stored.secretAccessKey
      sessionInjected.add(profile.env.accessKeyId)
      sessionInjected.add(profile.env.secretAccessKey)
      // 只说"从哪来"，不说值 —— 后端标签本身不含机密。
      ctx.logger.info(`[oss-backup] 已从 ${credentialStore.label} 载入凭证（值不显示）`)
    } catch (error) {
      ctx.logger.warn(`[oss-backup] 读取已保存的凭证失败：${safeErrorMessage(error)}`)
    }
  }

  /**
   * 把设置里的**非机密**连接信息写进进程环境变量。
   *
   * 这么做的价值：设置页配置与环境变量配置**共用同一条读取路径**（`readOssConfig`），
   * 读取端一行都不用改，也不存在"两套配置谁生效"的分支代码。
   *
   * provider 与 endpoint/bucket/region 的优先级刻意不同：
   *   · `OSS_PROVIDER` **以设置页为准** —— 那是用户在界面上明确选的，必须生效；
   *   · endpoint / bucket / region **以环境变量为准** —— 已经设了就不覆盖，
   *     免得把用户刻意 `setx` 的值悄悄改掉。
   */
  const applySettingsToEnv = (): void => {
    const requested = settings.provider
    const explicit =
      requested === 'rustfs' || requested === 'aliyun' || requested === 'aws' ? requested : null
    if (explicit !== null) process.env[PROVIDER_ENV] = explicit

    const { provider } = readProvider()
    const profile = providerProfile(provider)
    const pairs: Array<[string, string]> = [
      [profile.env.endpoint, settings.endpoint],
      [profile.env.bucket, settings.bucket],
      [profile.env.region, settings.region],
    ]
    for (const [envName, value] of pairs) {
      if (value === '') continue
      const existing = process.env[envName]
      if (typeof existing === 'string' && existing.trim() !== '') continue
      process.env[envName] = value
    }
  }

  /** 按当前设置（重）建自动备份实例；开关是关的就把实例整个丢掉。 */
  const applyAutoBackup = (): void => {
    autoBackup?.dispose()
    autoBackup = null
    if (!settings.autoBackup) return
    // 已确认连不上就先不建实例：省得每次文件改动都白跑一趟，也免得刷一屏失败日志。
    // 连接恢复后这里会被重新调用（见 /state 里的探测回调）。
    if (!uploadAllowed()) return
    autoBackup = new AutoBackup({
      config: {
        enabled: true,
        prefix: settings.prefix,
        debounceMs: DEFAULT_DEBOUNCE_MS,
        backoffMs: DEFAULT_RETRY_BACKOFF_MS,
        // 连续失败到阈值就熔断：服务没开的时候不要一直空转重试。
        failureThreshold: DEFAULT_FAILURE_THRESHOLD,
        pauseMs: DEFAULT_PAUSE_MS,
      },
      logger: ctx.logger,
      // 尽量把对象键做成更好读的形式；净化由 AutoBackup 内部保证。
      toKeyTail: (filePath) => workspaceRelativePath(ctx, filePath),
      // 自动备份也要反映到 UI：上传期间点亮 busy（侧栏/面板会弹出那张图）。
      onStart: () => {
        state.busy = true
      },
      // 结束后落地：复位 busy、成功则写一条历史，并把结果（含脱敏后的失败原因）交给状态路由。
      onResult: (outcome) => {
        const at = new Date().toISOString()
        state.busy = false
        state.busyUntil = Date.now() + BUSY_VISIBLE_MS
        state.lastAuto = {
          at,
          filePath: redactSecrets(outcome.filePath),
          objectKey: redactSecrets(outcome.objectKey),
          ok: outcome.ok,
          bytes: outcome.bytes,
          error: outcome.error,
        }
        if (outcome.ok) {
          // 上传成功 —— 对象存储显然是可达的，顺手修正探测缓存。
          reachability.markReachable()
          remember(state, { at, objectKey: outcome.objectKey, bytes: outcome.bytes })
        } else if (outcome.error !== null) {
          // 失败也立刻反映到界面上：不用等下一次探测才知道"连不上"。
          reachability.markUnreachable(outcome.error)
        }
      },
    })
  }

  // 熔断状态的对外出口：界面据此提示"已暂停"。
  const autoBackupReport = (): {
    enabled: boolean
    prefix: string
    debounceMs: number
    retries: number
    pending: number
    last: typeof state.lastAuto
    paused: boolean
    pausedUntil: number | null
    failures: number
  } => ({
    enabled: settings.autoBackup,
    prefix: settings.prefix,
    debounceMs: DEFAULT_DEBOUNCE_MS,
    retries: DEFAULT_RETRY_BACKOFF_MS.length,
    pending: autoBackup?.pending ?? 0,
    last: state.lastAuto,
    paused: autoBackup?.paused ?? false,
    pausedUntil: autoBackup !== null && autoBackup.paused ? autoBackup.pausedUntilMs : null,
    failures: autoBackup?.failures ?? 0,
  })

  // 监听**始终**注册；开关只决定"要不要真的调度"。这样在界面上拨开关不需要动监听，
  // 也避免了"注册/注销监听"与"读设置"之间的时序竞态。
  ctx.effect(
    () =>
      ctx.on('tools/post-execute', (execution: ToolExecutionLike, result: ToolExecutionOutcomeLike, next) => {
        try {
          if (result.isError !== true && autoBackup !== null) {
            const filePath = filePathOfToolCall(execution)
            if (filePath !== null) autoBackup.schedule(filePath)
          }
        } catch (error) {
          // 旁观者出错既不能影响主流程，也不能让这次工具调用失败。
          ctx.logger.warn(`[oss-backup] 自动备份调度异常（已忽略）：${safeErrorMessage(error)}`)
        }
        // ⚠️ 无论如何都要把 next() 的结果返回回去：这是 waterfall，截断会改掉别人的决策。
        return next()
      }),
    'oss-backup: 自动备份监听（write/edit）',
  )

  ctx.effect(() => () => autoBackup?.dispose(), 'oss-backup: 自动备份定时器清理')

  /** 定期全量备份的定时器（`null` = 未排期 / 已关闭）。 */
  let scheduleTimer: ReturnType<typeof setTimeout> | null = null

  /** 下一次定期备份的**实际**触发时刻（供界面显示；未排期时为 `null`）。 */
  let scheduleAt: number | null = null

  /**
   * 定时触发的那一次全量备份：跑完再排下一次。
   *
   * 与手动备份共用 {@link runManualJob} —— 同一套遍历、限额与记账逻辑，
   * 只是触发源从"按钮"变成"时间表"。上一次还没跑完就跳过这一轮（不排队、不叠加）。
   */
  const runScheduledBackup = async (): Promise<void> => {
    if (state.manual?.running === true) {
      ctx.logger.warn('[oss-backup] 定期备份到点了，但上一次还在跑 —— 跳过这一轮')
    } else {
      await runManualJob(settings.backupDir)
    }
    // 无论这轮跑了还是跳了，都要接着排下一次。
    applySchedule()
  }

  /**
   * 按当前设置（重）排下一次定期全量备份。
   *
   * 刻意用"跑完再排下一次"的链式 `setTimeout`，而不是 `setInterval`：
   * 备份本身可能跑好几分钟，`setInterval` 会让后续触发点漂移、甚至堆叠起多次备份。
   */
  const applySchedule = (): void => {
    if (scheduleTimer !== null) {
      clearTimeout(scheduleTimer)
      scheduleTimer = null
    }
    scheduleAt = null
    if (settings.schedule.mode === 'off') return
    if (settings.backupDir === '') {
      ctx.logger.warn('[oss-backup] 定期全量备份已开启，但还没设置备份目录 —— 暂不排期')
      return
    }
    if (!uploadAllowed()) {
      ctx.logger.warn(`[oss-backup] 定期全量备份暂不排期：${uploadBlockedReason()}`)
      return
    }

    const at = nextRunAt(settings.schedule, Date.now())
    if (at === null) return
    // 兜底至少 1 秒，避免时钟回拨之类的极端情况下疯狂重排。
    const delay = Math.max(1_000, at - Date.now())
    scheduleAt = at
    ctx.logger.info(
      `[oss-backup] 定期全量备份：${describeSchedule(settings.schedule)}，下次约 ${new Date(at).toLocaleString()}`,
    )
    scheduleTimer = setTimeout(() => {
      scheduleTimer = null
      scheduleAt = null
      void runScheduledBackup()
    }, delay)
  }

  ctx.effect(
    () => () => {
      if (scheduleTimer !== null) clearTimeout(scheduleTimer)
      scheduleTimer = null
    },
    'oss-backup: 定期备份定时器清理',
  )

  // apply 是同步的，读设置是异步的：先读，读完再决定自动备份是否真的开跑。
  void readSettings().then(async (loaded) => {
    settings = loaded

    // ① 先补读系统环境变量：`setx` 写的是注册表，已经启动的 dsh web 未必继承到它。
    //    这一步让"配一次环境变量就永久生效、什么都不用填"真正成立。
    const hydrated = await hydrateEnvironment()
    for (const name of hydrated) fromOsEnv.add(name)

    // ② 再把设置里的非机密连接信息灌进去（已有值不覆盖）。
    applySettingsToEnv()

    // ③ 现在才判断要不要开持久化 —— 用户可能刚 setx 了 OSS_CREDENTIAL_STORE。
    credentialStore = isCredentialStoreEnabled() ? createCredentialStore(dshHome()) : null

    // ④ 最后尝试载入已加密保存的凭证（未开启持久化时这一步什么都不做）。
    await loadStoredCredentials()
    applyAutoBackup()
    applySchedule()

    ctx.logger.info(
      `[oss-backup] 设置已加载：自动备份=${settings.autoBackup ? '开' : '关'}，前缀 ${settings.prefix}，备份目录 ${settings.backupDir === '' ? '(未设置)' : settings.backupDir}`,
    )
    if (hydrated.length > 0) {
      // 只报变量名 —— 方便你确认"我 setx 的那个确实被读到了"。
      ctx.logger.info(`[oss-backup] 已从系统环境补读 ${hydrated.join('、')}（值不显示）`)
    }
  })

  const webServer = optionalService<WebServerLike>(
    ctx,
    'webServer',
    (value) => typeof (value as WebServerLike | undefined)?.register === 'function',
  )

  if (webServer === undefined) {
    ctx.logger.warn('[oss-backup] 未发现 webServer 服务：设置页/侧边栏将只显示静态说明（工具不受影响）')
    return
  }

  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: STATE_ROUTE,
        handler: (request: WebRequestLike, response: WebResponseLike) => {
          if (request.method !== undefined && request.method !== 'GET') {
            sendJson(response, 405, { ok: false, error: 'GET only' })
            return
          }
          // 顺手触发一次可达性探测（带缓存，命中就直接返回）——
          // 不阻塞这次响应，下一次轮询界面就能拿到结果。
          //
          // 顺带处理"从连不上恢复过来"：不可达时自动备份与定期排期是被主动停掉的，
          // 连接回来后得把它们重新拉起来，否则要等用户重启才生效。
          const wasReachable = reachability.last?.reachable
          void reachability.check().then((probe) => {
            if (wasReachable === false && probe.reachable) {
              ctx.logger.info('[oss-backup] 对象存储已恢复连接，重新启用自动备份与定期备份')
              applyAutoBackup()
              applySchedule()
            }
          })
          sendJson(response, 200, {
            ok: true,
            plugin: name,
            tool: TOOL_NAME,
            route: STATE_ROUTE,
            // busy 结束后还留一个最短可见窗口，界面必定采得到（见 BUSY_VISIBLE_MS）。
            busy: state.busy || Date.now() < state.busyUntil,
            // 设置：界面可改，且**不含任何凭证**。
            //
            // ⚠️ 这里**整体展开**，绝不要手写字段白名单 —— 原本写的是
            // `{ autoBackup, backupDir, prefix }` 三个字段，之后加的 skipCaches /
            // provider / endpoint / bucket / region / gameEnabled / gameDifficulty 全没跟上：
            // 保存是好的（确实写进了 config.json），但界面读回来永远是默认值，
            // 表现就是"小游戏的开关关不掉"、"跳过缓存关不了"。
            //
            // 安全性不受影响：settings 是 normalizeSettings() 的产物，
            // 它只回填那组已知字段，任何凭证字段在入口处就被丢弃了。
            settings: { ...settings },
            // 自动备份运行态：界面据此显示开关效果、排队数与**熔断状态**。
            autoBackup: autoBackupReport(),
            /**
             * 现在能不能上传。
             *
             * 为 `false` 时宿主已经**从源头拦下**所有上传入口（工具 / 手动 / 自动 / 定期），
             * 界面据此把按钮禁用掉，别让用户点了才发现不行。
             */
            uploadAllowed: uploadAllowed(),
            /** 不能上传时的原因（**已脱敏**）；正常时为 `null`。 */
            uploadBlockedReason: uploadAllowed() ? null : uploadBlockedReason(),
            // 手动备份运行态：进度 + 上次汇总。
            manual:
              state.manual === null
                ? null
                : {
                    running: state.manual.running,
                    root: state.manual.root,
                    progress: state.manual.progress,
                    result: state.manual.result,
                  },
            environment: {
              ...describeOssEnvironment(),
              // 可达性：**配好变量 ≠ 服务在跑**。这里报最近一次真探测的结果
              // （首次进来还没探过就是 null，下方会异步补一次探测）。
              reachability: reachability.last,
            },
            // 凭证来源：让界面能如实说明"这是启动时环境变量里的，还是本次会话现填的"。
            credentials: {
              /** 本次会话通过设置页注入过的变量名（只有名字，没有值）。 */
              sessionVars: [...sessionInjected],
              /** 本次启动里从系统环境补读到的变量名（`setx` 过但进程没继承到的那种）。 */
              fromOs: [...fromOsEnv],
              /** 是否至少注入过一个 —— 界面据此提示"重启后需重新填写"。 */
              sessionOnly: sessionInjected.size > 0,
              /** 是否允许"记住到本机"（由 `OSS_CREDENTIAL_STORE=os` 决定）。 */
              persistent: credentialStore !== null,
              /** 持久化后端说明；未启用为 null。 */
              storeLabel: credentialStore?.label ?? null,
            },
            // 定期全量备份：模式 / 人话描述 / 下次实际触发时刻（未排期为 null）。
            schedule: {
              mode: settings.schedule.mode,
              description: describeSchedule(settings.schedule),
              nextRunAt: scheduleAt,
            },
            last: state.last,
            history: state.history,
          })
        },
      }),
    'oss-backup: 状态路由（脱敏）',
  )

  /**
   * 手动备份的后台执行体：遍历 → 逐个上传 → 记账。
   *
   * 全程只改 `state.manual` / `state.busy`，失败也只在日志与结果里体现，
   * 不会把异常抛回 HTTP 处理器（那个早就回过 200 了）。
   *
   * @param root - 源目录。
   */
  const runManualJob = async (root: string): Promise<void> => {
    state.busy = true
    try {
      const plan = await collectBackupPlan(
        root,
        undefined,
        {},
        // 设置里关掉"跳过缓存目录"时传空集合 —— 一个目录都不跳过（__pycache__ 等也会备份）。
        settings.skipCaches ? undefined : new Set<string>(),
      )
      if (state.manual !== null) {
        state.manual = {
          ...state.manual,
          progress: { total: plan.files.length, done: 0, failed: 0, current: '' },
        }
      }
      const result = await runManualBackup({
        plan,
        prefix: settings.prefix,
        upload: (input) => uploadFileToOss(input),
        onProgress: (progress) => {
          if (state.manual !== null) state.manual = { ...state.manual, progress }
        },
      })
      if (state.manual !== null) state.manual = { ...state.manual, running: false, result }
      ctx.logger.info(
        `[oss-backup] 手动备份结束：成功 ${result.uploaded} / 失败 ${result.failed}，共 ${result.bytes} 字节${result.truncated ? '（触到文件数上限）' : ''}`,
      )
      // 失败原因在 manual-backup 里已经脱敏。
      for (const message of result.errors) ctx.logger.warn(`[oss-backup] 手动备份失败项：${message}`)
    } catch (error) {
      const reason = safeErrorMessage(error)
      if (state.manual !== null) {
        state.manual = {
          ...state.manual,
          running: false,
          result: {
            total: 0,
            uploaded: 0,
            failed: 0,
            bytes: 0,
            truncated: false,
            skippedFiles: 0,
            errors: [reason],
          },
        }
      }
      ctx.logger.warn(`[oss-backup] 手动备份中断：${reason}`)
    } finally {
      state.busy = false
      state.busyUntil = Date.now() + BUSY_VISIBLE_MS
    }
  }

  // 设置路由：GET 读、POST 存。字段收窄在 settings.ts 里做（只认三个非机密字段）。
  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: SETTINGS_ROUTE,
        handler: async (request: WebRequestLike, response: WebResponseLike) => {
          const method = request.method ?? 'GET'
          if (method === 'GET') {
            sendJson(response, 200, { ok: true, settings })
            return
          }
          if (method !== 'POST') {
            sendJson(response, 405, { ok: false, error: 'GET or POST only' })
            return
          }
          try {
            const body = await readJsonBody(request)
            settings = await writeSettings(body, dshHome())
            applySettingsToEnv()
            applyAutoBackup()
            // 调度改了要重排 —— 否则改了时间还得等重启才生效。
            applySchedule()
            ctx.logger.info(
              `[oss-backup] 设置已更新：自动备份=${settings.autoBackup ? '开' : '关'}，备份目录 ${settings.backupDir === '' ? '(未设置)' : settings.backupDir}`,
            )
            sendJson(response, 200, { ok: true, settings })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: safeErrorMessage(error) })
          }
        },
      }),
    'oss-backup: 设置路由',
  )

  // 凭证路由：把设置页填的 AK/SK **直接写进本进程的环境变量**。
  //
  // 为什么这样最安全：
  //   · 不落盘 —— 全程零文件写入，进程退出即消失（这是它相对 setx 的唯一代价）；
  //   · 不回显 —— 响应只回"注入了哪些变量名"，永远不回值；
  //   · 不进日志 —— 日志只记变量名，且提交后前端会立刻清空输入框；
  //   · 不动读取端 —— `readOssConfig()` 照旧只读 `process.env`，安全模型完全不变。
  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: CREDENTIALS_ROUTE,
        handler: async (request: WebRequestLike, response: WebResponseLike) => {
          if (request.method !== undefined && request.method !== 'POST') {
            sendJson(response, 405, { ok: false, error: 'POST only' })
            return
          }
          try {
            const raw = await readJsonBody(request)
            const record = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}

            // 当前生效的 provider 决定用哪一组变量名。
            const { provider } = readProvider()
            const profile = providerProfile(provider)
            const wanted: Array<[string, unknown]> = [
              [profile.env.accessKeyId, record.accessKeyId],
              [profile.env.secretAccessKey, record.secretAccessKey],
            ]

            const injected: string[] = []
            for (const [envName, value] of wanted) {
              if (typeof value !== 'string') continue
              const trimmed = value.trim()
              if (trimmed === '') continue
              process.env[envName] = trimmed
              sessionInjected.add(envName)
              injected.push(envName)
            }

            if (injected.length === 0) {
              sendJson(response, 400, { ok: false, error: '没有收到任何凭证值' })
              return
            }

            // 只有"用户显式开启了持久化"且"这次勾了记住"才写密文。
            let stored = false
            if (record.remember === true && credentialStore !== null) {
              const current: StoredCredentials = {
                accessKeyId: process.env[profile.env.accessKeyId] ?? '',
                secretAccessKey: process.env[profile.env.secretAccessKey] ?? '',
              }
              if (current.accessKeyId !== '' && current.secretAccessKey !== '') {
                await credentialStore.save(current)
                stored = true
              }
            }

            // 只记变量名与"是否落盘" —— 这条日志里每个字都是可以公开的。
            ctx.logger.info(
              `[oss-backup] 已从设置页注入 ${injected.join('、')}` +
                (stored
                  ? `，并用 ${credentialStore?.label ?? 'OS 密钥库'} 加密保存`
                  : '（仅本次会话，进程退出即失效）') +
                '；值不落盘明文、不回显',
            )
            sendJson(response, 200, { ok: true, injected, stored })
          } catch (error) {
            sendJson(response, 400, { ok: false, error: safeErrorMessage(error) })
          }
        },
      }),
    'oss-backup: 凭证注入路由',
  )

  // 手动备份：POST 触发，**立刻回响应**，实际备份在后台跑，进度靠 /state 轮询。
  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: RUN_ROUTE,
        handler: (request: WebRequestLike, response: WebResponseLike) => {
          if (request.method !== undefined && request.method !== 'POST') {
            sendJson(response, 405, { ok: false, error: 'POST only' })
            return
          }
          if (state.manual?.running === true) {
            sendJson(response, 409, { ok: false, error: '已有一次手动备份在跑' })
            return
          }
          if (settings.backupDir === '') {
            sendJson(response, 400, { ok: false, error: '还没设置备份目录' })
            return
          }
          if (!uploadAllowed()) {
            sendJson(response, 503, { ok: false, error: `${uploadBlockedReason()} —— 已暂停上传` })
            return
          }
          const root = settings.backupDir
          state.manual = {
            running: true,
            startedAt: new Date().toISOString(),
            root,
            progress: { total: 0, done: 0, failed: 0, current: '' },
            result: null,
          }
          sendJson(response, 200, { ok: true, started: true, root })
          void runManualJob(root)
        },
      }),
    'oss-backup: 手动备份路由',
  )

  // 上传中那张图：直接吐包内 assets 的字节。
  // 走宿主路由而不是内联进 client bundle —— 图 500 KB 出头，内联要白白多下 700 KB base64。
  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: SHOT_ROUTE,
        handler: async (request: WebRequestLike, response: WebResponseLike) => {
          const method = request.method
          if (method !== undefined && method !== 'GET' && method !== 'HEAD') {
            sendJson(response, 405, { ok: false, error: 'GET only' })
            return
          }
          try {
            const bytes = await readFile(SHOT_FILE)
            response.writeHead(200, {
              'content-type': 'image/jpeg',
              // 图不会变，缓存一天；真要换图就 bump 插件版本。
              'cache-control': 'public, max-age=86400',
              'content-length': String(bytes.length),
            })
            response.end(bytes)
          } catch (error) {
            // 缺素材时给一句可读的话（已脱敏）；前端会回退到内置 SVG，不会开天窗。
            response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            response.end(redactSecrets(`asset unavailable: ${safeErrorMessage(error)}`))
          }
        },
      }),
    'oss-backup: 上传中那张图',
  )
}

/**
 * 从一次工具调用里取出被改动的文件路径。
 *
 * 只认 `write` / `edit`（两者的路径参数都是 `file_path`），其余工具一律不参与自动备份。
 *
 * @param execution - 已归一化的工具调用。
 * @returns 文件路径；不是目标工具、或参数不可用时为 null。
 */
function filePathOfToolCall(execution: ToolExecutionLike): string | null {
  if (execution.name !== 'write' && execution.name !== 'edit') return null
  const args = execution.arguments
  if (args === null || typeof args !== 'object') return null
  const value = (args as { file_path?: unknown }).file_path
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 尽量把宿主路径转成更好读的形式；拿不到就退化成文件名。
 *
 * ⚠️ 实测 `fs.processPathFromHostPath()` 返回的是**带盘符的宿主路径**（`D:/projects/...`），
 * 而不是"工作区相对路径" —— 而冒号会被 RustFS 直接拒绝（Windows 主机限制，实测报
 * `InvalidArgument: object key contains characters unsupported on Windows hosts`）。
 * 所以不管这里返回什么，下游都会过一遍 `sanitizeObjectKeyTail()` 净化；
 * 保留这个软取只是为了尽量少丢目录结构。
 *
 * @param ctx - 插件上下文。
 * @param filePath - 文件路径。
 * @returns 对象键尾部（**未净化**）。
 */
function workspaceRelativePath(ctx: PluginContext, filePath: string): string {
  try {
    const fsService = optionalService<{ processPathFromHostPath?(hostPath: string): string | undefined }>(
      ctx,
      'fs',
      (value) =>
        typeof (value as { processPathFromHostPath?: unknown } | undefined)?.processPathFromHostPath === 'function',
    )
    const relative = fsService?.processPathFromHostPath?.(filePath)
    if (typeof relative === 'string' && relative.trim() !== '') return relative
  } catch {
    /* 软依赖失败 → 退化成文件名 */
  }
  return basename(filePath)
}

/** 供测试引用：把缺失环境变量的错误类型再导出一次，避免测试依赖深层路径。 */
export { MissingEnvironmentError }
