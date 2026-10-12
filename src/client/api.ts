/**
 * 宿主状态读取（Client 半边）。
 *
 * 前端只读一条**只读、脱敏**的宿主路由：`GET /oss-backup/state`。
 * 它绝不接收任何凭证 —— 端点、桶名、区域与「AK/SK 是否已设置」这类元信息而已。
 *
 * @module dsh-plugin-oss-backup/client/api
 */

/** 与宿主 `describeOssEnvironment()` 对应的环境自检结果。 */
export interface EnvironmentReport {
  /** 必需变量是否齐备。 */
  ready: boolean
  /** 缺失的变量名。 */
  missing: readonly string[]
  /** 已脱敏的端点。 */
  endpoint: string | null
  /** 存储桶。 */
  bucket: string | null
  /** 生效区域。 */
  region: string
  /** 生效的 provider（rustfs / aliyun / aws）。 */
  provider: string
  /** provider 的面向人的名字。 */
  providerLabel: string
  /** 是否 path-style 寻址。 */
  forcePathStyle: boolean
  /** 访问密钥 ID 是否已设置（**只有存在性**）。 */
  accessKeyConfigured: boolean
  /** 访问密钥密码是否已设置（**只有存在性**）。 */
  secretKeyConfigured: boolean
  /** 该设置哪些变量。 */
  variableNames: {
    readonly endpoint: string
    readonly accessKeyId: string
    readonly secretAccessKey: string
    readonly bucket: string
    readonly region: string
  }
  /**
   * 对象存储的可达性（宿主真发过一次 `HeadBucket` 探出来的）。
   *
   * **变量配齐 ≠ 服务在跑** —— 这一项才是"能不能用"。`null` 表示还没探过。
   */
  reachability: ReachabilityReport | null
  /**
   * 「云端备份」按钮要打开的网页控制台地址（宿主按 provider 推导）。
   *
   * RustFS/MinIO 是本机控制台（S3 端口 +1）；阿里云 / AWS 是对应的云控制台且直达当前桶。
   * 推导不出来时为 `null`。
   */
  consoleUrl: string | null
}

/** 一次可达性探测的结果。 */
export interface ReachabilityReport {
  /** 是否连得上（含凭证被接受、桶存在）。 */
  reachable: boolean
  /** 探测时刻（毫秒时间戳）。 */
  checkedAt: number
  /** 连不上时的原因（**已脱敏**）。 */
  error: string | null
}

/** 一条上传记录。 */
export interface UploadRecord {
  /** ISO 时刻。 */
  at: string
  /** 已脱敏的对象键。 */
  objectKey: string
  /** 字节数。 */
  bytes: number
}

/** 宿主状态快照。 */
export interface StateSnapshot {
  /** 宿主是否正常应答。 */
  ok: boolean
  /** 插件名。 */
  plugin: string
  /** 工具名。 */
  tool: string
  /** 是否正在上传（UI 据此弹出那张图）。 */
  busy: boolean
  /** 环境自检。 */
  environment: EnvironmentReport
  /** 自动备份（只读状态）。 */
  autoBackup: AutoBackupReport
  /** 设置（界面可改）。 */
  settings: PluginSettingsView
  /** 凭证来源（**只有变量名，没有值**）。 */
  credentials: CredentialReport
  /** `.env` 的加载情况（**只有变量名，没有值**）。 */
  dotenv: DotenvReport
  /** 定期全量备份的运行态。 */
  schedule: ScheduleReport
  /**
   * 现在能不能上传。
   *
   * 为 `false` 时宿主已从源头拦下所有上传入口，界面应把按钮禁用掉。
   */
  uploadAllowed: boolean
  /** 不能上传时的原因（**已脱敏**）；正常时为 `null`。 */
  uploadBlockedReason: string | null
  /** 手动备份运行态（没跑过为 null）。 */
  manual: ManualReport | null
  /** 最近一次上传。 */
  last: UploadRecord | null
  /** 最近若干次上传（新 → 旧）。 */
  history: readonly UploadRecord[]
}

/** 凭证来源。 */
export interface CredentialReport {
  /** 本次会话通过设置页注入过的变量名（**只有名字**）。 */
  sessionVars: readonly string[]
  /** 是否至少注入过一个 —— 界面据此提示"重启后需重新填写"。 */
  sessionOnly: boolean
  /** 本次启动里从**系统环境**补读到的变量名（`setx` 过但进程没继承到的那种）。 */
  fromOs: readonly string[]
  /** 本次启动里由 `.env` 提供了值的变量名（`.env` 优先于系统环境）。 */
  fromDotenv: readonly string[]
  /** 是否允许"记住到本机"（由 `OSS_CREDENTIAL_STORE=os` 决定）。 */
  persistent: boolean
  /** 持久化后端说明；未启用为 null。 */
  storeLabel: string | null
}

/**
 * `.env` 的加载情况（**只有变量名，没有值**）。
 *
 * 让用户能确认"我放的那份 `.env` 到底被读到没、读的是哪一份"。
 */
export interface DotenvReport {
  /** 实际读取的文件路径；没读到任何候选文件时为 null。 */
  path: string | null
  /** 读入的变量名（只有名字）。 */
  loaded: readonly string[]
  /** 被 `.env` **覆盖掉**的变量名（只有名字）—— `.env` 优先于系统环境。 */
  overridden: readonly string[]
  /** 读取失败的原因（**已脱敏**）；正常为 null。 */
  error: string | null
}

/** 自动备份的只读状态。 */
export interface AutoBackupReport {
  /** 是否启用（默认关闭）。 */
  enabled: boolean
  /** 对象键前缀。 */
  prefix: string
  /** 防抖时长（毫秒）。 */
  debounceMs: number
  /** 失败重试次数。 */
  retries: number
  /** 当前排队中的文件数。 */
  pending: number
  /** 最近一次自动备份的结果（诊断靠它）。 */
  last: AutoBackupLast | null
  /** 是否处于**熔断暂停**中（连续失败太多，暂时不再尝试）。 */
  paused: boolean
  /** 熔断解除的时刻；未熔断为 `null`。 */
  pausedUntil: number | null
  /** 当前连续失败次数。 */
  failures: number
}

/** 最近一次自动备份的结果。 */
export interface AutoBackupLast {
  /** ISO 时刻。 */
  at: string
  /** 已脱敏的文件路径。 */
  filePath: string
  /** 已脱敏的对象键。 */
  objectKey: string
  /** 是否成功。 */
  ok: boolean
  /** 成功时的字节数。 */
  bytes: number
  /** 失败原因（**已脱敏**）。 */
  error: string | null
}

/** 界面可改的设置（**不含任何凭证**）。 */
export interface PluginSettingsView {
  /** 自动备份开关。 */
  autoBackup: boolean
  /** 备份源目录（绝对路径）。 */
  backupDir: string
  /** 对象键前缀。 */
  prefix: string
  /** 是否跳过依赖 / 缓存目录（`node_modules`、`__pycache__` 等）。 */
  skipCaches: boolean
  /** provider（空串表示跟随环境变量）。 */
  provider: string
  /** 端点（空串表示跟随环境变量 / provider 默认）。 */
  endpoint: string
  /** 存储桶（空串表示跟随环境变量）。 */
  bucket: string
  /** 区域（空串表示跟随环境变量 / provider 默认）。 */
  region: string
  /** 点击「立即备份」时是否先玩一局小游戏。 */
  gameEnabled: boolean
  /** 小游戏难度（`zayu` / `easy` / `normal` / `hard`）。 */
  gameDifficulty: string
  /** 定期全量备份的调度（与宿主同构）。 */
  schedule: ScheduleView
}

/** 界面侧的调度视图。 */
export interface ScheduleView {
  /** 模式。 */
  mode: 'off' | 'interval' | 'daily' | 'monthly'
  /** `interval` 模式：间隔数值。 */
  every: number
  /** `interval` 模式：单位。 */
  unit: 'minute' | 'hour' | 'day'
  /** `daily` / `monthly` 模式：小时。 */
  hour: number
  /** `daily` / `monthly` 模式：分钟。 */
  minute: number
  /** `monthly` 模式：每月几号（1-28）。 */
  dayOfMonth: number
}

/** 定期全量备份的运行态。 */
export interface ScheduleReport {
  /** 模式。 */
  mode: string
  /** 人话描述（如「每天 03:00」）。 */
  description: string
  /** 下次实际触发时刻；未排期为 null。 */
  nextRunAt: number | null
}

/** 一次手动备份的汇总。 */
export interface ManualSummary {
  /** 计划里的文件总数。 */
  total: number
  /** 成功上传数。 */
  uploaded: number
  /** 失败数。 */
  failed: number
  /** 因"内容没变、已经传过"而跳过的文件数。 */
  skippedUnchanged: number
  /** 是否被用户**强行打断**。 */
  aborted: boolean
  /** 成功字节数。 */
  bytes: number
  /** 是否因限额被截断。 */
  truncated: boolean
  /** 被限额跳过的文件数。 */
  skippedFiles: number
  /** 失败原因（已脱敏）。 */
  errors: readonly string[]
}

/** 手动备份运行态。 */
export interface ManualReport {
  /** 是否正在跑。 */
  running: boolean
  /** 源目录。 */
  root: string
  /** 总文件数。 */
  total: number
  /** 已完成数。 */
  done: number
  /** 已失败数。 */
  failed: number
  /** 当前文件。 */
  current: string
  /** 因"没变化"跳过的数。 */
  skipped: number
  /** 是否还能强行打断（已经在收尾时为 false）。 */
  cancellable: boolean
  /** 结束后的汇总（运行中为 null）。 */
  result: ManualSummary | null
}

/** 宿主路由前缀（与 `src/index.ts` 的 `STATE_ROUTE` 同源）。 */
export const API_BASE = '/oss-backup'

/** 状态路由路径。 */
export const STATE_PATH = `${API_BASE}/state`

/** 设置路由路径（`GET` 读、`POST` 存）。 */
export const SETTINGS_PATH = `${API_BASE}/settings`

/** 手动备份触发路径（`POST`）。 */
export const RUN_PATH = `${API_BASE}/run`

/** 强行打断正在跑的手动备份（`POST`）。 */
export const CANCEL_PATH = `${API_BASE}/cancel`

/**
 * 凭证注入路径（`POST`）。
 *
 * 值只在"输入框 → 宿主"这一条路上出现一次，宿主立刻写进自己的 `process.env`；
 * 响应里只有变量名列表，**永远不回值**。
 */
export const CREDENTIALS_PATH = `${API_BASE}/credentials`

/**
 * 上传中弹出那张图的路径。
 *
 * 图由宿主路由直接吐字节（来自包内 `assets/`），**不 base64 内联进 client bundle** ——
 * 那张图 500 KB 出头，内联会让每个浏览器多下 700 KB 的 base64。
 */
export const SHOT_PATH = `${API_BASE}/asset/shot`

/** 游戏失败时那张图的地址（宿主直吐包内素材）。 */
export const FAIL_PATH = `${API_BASE}/asset/fail`

/** 一次拉取的结果。 */
export interface StateResult {
  /** 成功时的快照；失败为 null。 */
  snapshot: StateSnapshot | null
  /** 失败原因（面向人的短句，不含机密）。 */
  error: string | null
}

/**
 * 校验并收窄一个未知值。
 *
 * 浏览器侧的输入永远当不可信处理：字段缺失或类型不符时宁可退回 `null`，
 * 也不要让半个快照渲染出乱码。
 *
 * @param value - 解析后的 JSON。
 * @returns 结构化快照，或 null。
 */
function toSnapshot(value: unknown): StateSnapshot | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const environment = record.environment
  if (environment === null || typeof environment !== 'object') return null
  const env = environment as Record<string, unknown>
  const names = env.variableNames
  if (names === null || typeof names !== 'object') return null
  const variableNames = names as Record<string, unknown>
  return {
    ok: record.ok === true,
    plugin: typeof record.plugin === 'string' ? record.plugin : '',
    tool: typeof record.tool === 'string' ? record.tool : '',
    busy: record.busy === true,
    autoBackup: toAutoBackup(record.autoBackup),
    settings: toSettingsView(record.settings),
    manual: toManualReport(record.manual),
    environment: {
      ready: env.ready === true,
      missing: Array.isArray(env.missing) ? env.missing.filter((item): item is string => typeof item === 'string') : [],
      endpoint: typeof env.endpoint === 'string' ? env.endpoint : null,
      bucket: typeof env.bucket === 'string' ? env.bucket : null,
      region: typeof env.region === 'string' ? env.region : '',
      provider: typeof env.provider === 'string' ? env.provider : 'rustfs',
      providerLabel: typeof env.providerLabel === 'string' ? env.providerLabel : 'RustFS / MinIO 等自建 S3 兼容端点',
      forcePathStyle: env.forcePathStyle === true,
      accessKeyConfigured: env.accessKeyConfigured === true,
      secretKeyConfigured: env.secretKeyConfigured === true,
      variableNames: {
        endpoint: typeof variableNames.endpoint === 'string' ? variableNames.endpoint : 'RUSTFS_ENDPOINT',
        accessKeyId: typeof variableNames.accessKeyId === 'string' ? variableNames.accessKeyId : 'RUSTFS_ACCESS_KEY',
        secretAccessKey:
          typeof variableNames.secretAccessKey === 'string' ? variableNames.secretAccessKey : 'RUSTFS_SECRET_KEY',
        bucket: typeof variableNames.bucket === 'string' ? variableNames.bucket : 'RUSTFS_BUCKET',
        region: typeof variableNames.region === 'string' ? variableNames.region : 'RUSTFS_REGION',
      },
      reachability: toReachability(env.reachability),
      // 缺字段（旧版宿主）时为 null，界面会退回"推导不出来"的提示而不是崩掉。
      consoleUrl: typeof env.consoleUrl === 'string' ? env.consoleUrl : null,
    },
    credentials: toCredentialReport(record.credentials),
    dotenv: toDotenvReport(record.dotenv),
    schedule: toScheduleReport(record.schedule),
    // 缺字段时乐观放行（旧版宿主）：让操作自己去撞错误，比把按钮全锁死好。
    uploadAllowed: record.uploadAllowed !== false,
    uploadBlockedReason:
      record.uploadAllowed === false && typeof record.uploadBlockedReason === 'string'
        ? record.uploadBlockedReason
        : null,
    last: toRecord(record.last),
    history: Array.isArray(record.history) ? record.history.map(toRecord).filter((item): item is UploadRecord => item !== null) : [],
  }
}

/**
 * 收窄凭证来源。
 *
 * @param value - 未知值。
 * @returns 凭证来源；无效时表示"没有会话注入"。
 */
function toCredentialReport(value: unknown): CredentialReport {
  const record = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    sessionVars: Array.isArray(record.sessionVars)
      ? record.sessionVars.filter((item): item is string => typeof item === 'string')
      : [],
    sessionOnly: record.sessionOnly === true,
    fromOs: Array.isArray(record.fromOs)
      ? record.fromOs.filter((item): item is string => typeof item === 'string')
      : [],
    fromDotenv: Array.isArray(record.fromDotenv)
      ? record.fromDotenv.filter((item): item is string => typeof item === 'string')
      : [],
    persistent: record.persistent === true,
    storeLabel: typeof record.storeLabel === 'string' ? record.storeLabel : null,
  }
}

/**
 * 收窄 `.env` 的加载情况。
 *
 * @param value - 未知值。
 * @returns `.env` 报告；无效时表示"没读到任何 .env"。
 */
function toDotenvReport(value: unknown): DotenvReport {
  const record = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const names = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : []
  return {
    path: typeof record.path === 'string' ? record.path : null,
    loaded: names(record.loaded),
    overridden: names(record.overridden),
    error: typeof record.error === 'string' ? record.error : null,
  }
}

/**
 * 收窄设置（字段缺失时给出厂兜底，界面不会因为半个快照崩掉）。
 *
 * @param value - 未知值。
 * @returns 设置视图。
 */
function toSettingsView(value: unknown): PluginSettingsView {
  const record = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    autoBackup: record.autoBackup === true,
    backupDir: typeof record.backupDir === 'string' ? record.backupDir : '',
    prefix: typeof record.prefix === 'string' ? record.prefix : 'workspace-backup/',
    // 缺省视为"跳过"（与宿主默认一致）。
    skipCaches: record.skipCaches !== false,
    provider: typeof record.provider === 'string' ? record.provider : '',
    endpoint: typeof record.endpoint === 'string' ? record.endpoint : '',
    bucket: typeof record.bucket === 'string' ? record.bucket : '',
    region: typeof record.region === 'string' ? record.region : '',
    // 缺省视为"开启"（与宿主默认一致）。
    gameEnabled: record.gameEnabled !== false,
    gameDifficulty: typeof record.gameDifficulty === 'string' ? record.gameDifficulty : 'easy',
    schedule: toScheduleView(record.schedule),
  }
}

/**
 * 收窄调度设置。
 *
 * @param value - 未知值。
 * @returns 调度视图；无效时给"关闭"。
 */
function toScheduleView(value: unknown): ScheduleView {
  const record = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const mode =
    record.mode === 'interval' || record.mode === 'daily' || record.mode === 'monthly' ? record.mode : 'off'
  const unit = record.unit === 'minute' || record.unit === 'day' ? record.unit : 'hour'
  const int = (input: unknown, fallback: number): number =>
    typeof input === 'number' && Number.isFinite(input) ? Math.floor(input) : fallback
  return {
    mode,
    every: Math.max(1, int(record.every, 1)),
    unit,
    hour: Math.min(23, Math.max(0, int(record.hour, 3))),
    minute: Math.min(59, Math.max(0, int(record.minute, 0))),
    dayOfMonth: Math.min(28, Math.max(1, int(record.dayOfMonth, 1))),
  }
}

/**
 * 收窄定期备份运行态。
 *
 * @param value - 未知值。
 * @returns 运行态；无效时给"关闭"。
 */
function toScheduleReport(value: unknown): ScheduleReport {
  const record = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    mode: typeof record.mode === 'string' ? record.mode : 'off',
    description: typeof record.description === 'string' ? record.description : '关闭',
    nextRunAt:
      typeof record.nextRunAt === 'number' && Number.isFinite(record.nextRunAt) ? record.nextRunAt : null,
  }
}

/**
 * 收窄手动备份运行态。
 *
 * @param value - 未知值。
 * @returns 运行态；无效时为 null。
 */
function toManualReport(value: unknown): ManualReport | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const progress = record.progress !== null && typeof record.progress === 'object' ? (record.progress as Record<string, unknown>) : {}
  const rawResult = record.result !== null && typeof record.result === 'object' ? (record.result as Record<string, unknown>) : null
  const number = (input: unknown): number => (typeof input === 'number' && Number.isFinite(input) ? input : 0)
  return {
    running: record.running === true,
    root: typeof record.root === 'string' ? record.root : '',
    total: number(progress.total),
    done: number(progress.done),
    failed: number(progress.failed),
    current: typeof progress.current === 'string' ? progress.current : '',
    skipped: number(progress.skipped),
    cancellable: record.cancellable === true,
    result:
      rawResult === null
        ? null
        : {
            total: number(rawResult.total),
            uploaded: number(rawResult.uploaded),
            failed: number(rawResult.failed),
            skippedUnchanged: number(rawResult.skippedUnchanged),
            aborted: rawResult.aborted === true,
            bytes: number(rawResult.bytes),
            truncated: rawResult.truncated === true,
            skippedFiles: number(rawResult.skippedFiles),
            errors: Array.isArray(rawResult.errors)
              ? rawResult.errors.filter((item): item is string => typeof item === 'string')
              : [],
          },
  }
}

/**
 * 收窄自动备份状态。
 *
 * 字段缺失（旧版宿主）时给一份"已关闭"的兜底值，界面不会因为半个快照崩掉。
 *
 * @param value - 未知值。
 * @returns 自动备份状态。
 */
function toAutoBackup(value: unknown): AutoBackupReport {
  const record = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const last = toLastAuto(record.last)
  return {
    enabled: record.enabled === true,
    prefix: typeof record.prefix === 'string' ? record.prefix : 'workspace-backup/',
    debounceMs: typeof record.debounceMs === 'number' && Number.isFinite(record.debounceMs) ? record.debounceMs : 2000,
    retries: typeof record.retries === 'number' && Number.isFinite(record.retries) ? record.retries : 3,
    pending: typeof record.pending === 'number' && Number.isFinite(record.pending) ? record.pending : 0,
    last,
    paused: record.paused === true,
    pausedUntil:
      typeof record.pausedUntil === 'number' && Number.isFinite(record.pausedUntil) ? record.pausedUntil : null,
    failures: typeof record.failures === 'number' && Number.isFinite(record.failures) ? record.failures : 0,
  }
}

/**
 * 收窄"最近一次自动备份的结果"。
 *
 * @param value - 未知值。
 * @returns 结果或 null。
 */
function toLastAuto(value: unknown): AutoBackupLast | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  return {
    at: typeof record.at === 'string' ? record.at : '',
    filePath: typeof record.filePath === 'string' ? record.filePath : '',
    objectKey: typeof record.objectKey === 'string' ? record.objectKey : '',
    ok: record.ok === true,
    bytes: typeof record.bytes === 'number' && Number.isFinite(record.bytes) ? record.bytes : 0,
    error: typeof record.error === 'string' ? record.error : null,
  }
}

/**
 * 收窄可达性探测结果。
 *
 * @param value - 未知值。
 * @returns 探测结果；没探过（或字段缺失）时为 null。
 */
function toReachability(value: unknown): ReachabilityReport | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  return {
    reachable: record.reachable === true,
    checkedAt: typeof record.checkedAt === 'number' && Number.isFinite(record.checkedAt) ? record.checkedAt : 0,
    error: typeof record.error === 'string' ? record.error : null,
  }
}

/**
 * 收窄一条上传记录。
 *
 * @param value - 未知值。
 * @returns 记录或 null。
 */
function toRecord(value: unknown): UploadRecord | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.objectKey !== 'string' || typeof record.at !== 'string') return null
  return {
    at: record.at,
    objectKey: record.objectKey,
    bytes: typeof record.bytes === 'number' && Number.isFinite(record.bytes) ? record.bytes : 0,
  }
}

/**
 * 拉取一次宿主状态。
 *
 * @param timeoutMs - 超时（毫秒）。宿主没应答时按钮不该永远卡住。
 * @returns 快照或错误短句。
 */
export async function fetchState(timeoutMs = 8000): Promise<StateResult> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller === null ? 0 : setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(STATE_PATH, {
      cache: 'no-store',
      ...(controller === null ? {} : { signal: controller.signal }),
    })
    if (!response.ok) return { snapshot: null, error: `宿主返回 ${response.status}` }
    const snapshot = toSnapshot(await response.json())
    return snapshot === null ? { snapshot: null, error: '状态格式无法识别' } : { snapshot, error: null }
  } catch (error) {
    const aborted = error !== null && error !== undefined && (error as { name?: string }).name === 'AbortError'
    return { snapshot: null, error: aborted ? '宿主没应答（超时）' : '宿主还没装上这个插件' }
  } finally {
    if (timer !== 0) clearTimeout(timer)
  }
}

/** 一次写操作的结果。 */
export interface ActionResult {
  /** 是否成功。 */
  ok: boolean
  /** 失败原因（面向人的短句）。 */
  error: string | null
}

/**
 * 往宿主 POST 一个 JSON 并收结果。
 *
 * @param path - 路由路径。
 * @param body - 请求体（省略则不发送）。
 * @param timeoutMs - 超时（毫秒）。
 * @returns 结果。
 */
async function postJson(path: string, body: unknown, timeoutMs: number): Promise<ActionResult> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller === null ? 0 : setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(path, {
      method: 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      ...(controller === null ? {} : { signal: controller.signal }),
    })
    const payload = (await response.json().catch(() => ({}))) as { ok?: unknown; error?: unknown }
    if (!response.ok || payload.ok !== true) {
      return { ok: false, error: typeof payload.error === 'string' ? payload.error : `宿主返回 ${response.status}` }
    }
    return { ok: true, error: null }
  } catch (error) {
    const aborted = error !== null && error !== undefined && (error as { name?: string }).name === 'AbortError'
    return { ok: false, error: aborted ? '宿主没应答（超时）' : '请求失败' }
  } finally {
    if (timer !== 0) clearTimeout(timer)
  }
}

/**
 * 保存设置（开关 / 备份目录 / 前缀）。
 *
 * 只发送这三个字段 —— 界面上根本没有凭证输入框，也不该有。
 *
 * @param settings - 完整设置。
 * @param timeoutMs - 超时（毫秒）。
 * @returns 结果。
 */
export function saveSettings(settings: PluginSettingsView, timeoutMs = 8000): Promise<ActionResult> {
  return postJson(SETTINGS_PATH, settings, timeoutMs)
}

/**
 * 把设置页填的凭证交给宿主，由宿主写进自己的 `process.env`。
 *
 * 发出去的两个值**不回显、不保存、不进日志**：宿主响应只有
 * `{ ok, injected: ['RUSTFS_ACCESS_KEY', ...] }`（变量名列表）。
 * 调用方拿到结果后应当**立刻清空输入框**。
 *
 * @param accessKeyId - 访问密钥 ID。
 * @param secretAccessKey - 访问密钥密码。
 * @param timeoutMs - 超时（毫秒）。
 * @returns 结果。
 */
export function saveCredentials(
  accessKeyId: string,
  secretAccessKey: string,
  remember = false,
  timeoutMs = 8000,
): Promise<ActionResult> {
  return postJson(CREDENTIALS_PATH, { accessKeyId, secretAccessKey, remember }, timeoutMs)
}

/**
 * 触发一次手动备份（宿主异步执行，进度靠轮询 `/state`）。
 *
 * @param timeoutMs - 超时（毫秒）。
 * @returns 结果。
 */
export function startManualBackup(timeoutMs = 8000): Promise<ActionResult> {
  return postJson(RUN_PATH, undefined, timeoutMs)
}

/**
 * 强行打断正在跑的手动备份。
 *
 * 宿主收到后会把取消信号打上：循环在下一个文件边界停下，**正在传的那个文件**
 * 也会被立刻掐断（分片上传的在途请求一并中止）。
 *
 * @param timeoutMs - 超时（毫秒）。
 * @returns 结果。
 */
export function cancelManualBackup(timeoutMs = 8000): Promise<ActionResult> {
  return postJson(CANCEL_PATH, undefined, timeoutMs)
}
