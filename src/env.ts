/**
 * 对象存储配置的唯一来源：**进程环境变量**（Host 半边）。
 *
 * 为什么只认环境变量：
 *   · 密钥不落盘 —— 没有配置文件、没有 .env 解析、没有 UI 输入框，用户无从把 AK/SK 交给我们保管；
 *   · 密钥不进前端 —— Client 半边跑在浏览器沙箱里（只有 ctx/React/host/styles/console，没有 process），
 *     它连"读环境变量"这个能力都不存在，凭证天然不可能下发到页面；
 *   · 密钥不进日志 —— 本模块抛出的错误**只包含变量名**，从不回显变量的值。
 *
 * 三个 provider（`OSS_PROVIDER=rustfs|aliyun|aws`）的差异集中在下方的 {@link PROFILES}：
 * 变量名、寻址风格（path-style / 虚拟主机）、默认区域、端点是否必填。
 * 除此之外的代码路径完全共用 —— 都是 `@aws-sdk/client-s3`，没有第二套 SDK。
 *
 * @module dsh-plugin-oss-backup/env
 */

/** 支持的对象存储 provider。 */
export type OssProvider = 'rustfs' | 'aliyun' | 'aws'

/** 选择 provider 的环境变量名。 */
export const PROVIDER_ENV = 'OSS_PROVIDER'

/** provider 的配置档案。 */
export interface ProviderProfile {
  /** 标识。 */
  readonly provider: OssProvider
  /** 面向人的名字。 */
  readonly label: string
  /** 该 provider 使用的变量名。 */
  readonly env: {
    /** 端点。 */
    readonly endpoint: string
    /** 存储桶。 */
    readonly bucket: string
    /** 访问密钥 ID。 */
    readonly accessKeyId: string
    /** 访问密钥密码。 */
    readonly secretAccessKey: string
    /** 区域。 */
    readonly region: string
  }
  /** 允许的默认区域；`null` 表示区域必须显式提供（AWS 就是这种）。 */
  readonly defaultRegion: string | null
  /**
   * 是否强制 path-style 寻址。
   *
   * 自建端点（RustFS/MinIO）**必须** true —— 虚拟主机风格解析不了桶名；
   * 云厂商（阿里云 OSS / AWS）用默认的虚拟主机风格，设 true 反而会失败。
   */
  readonly forcePathStyle: boolean
  /** 端点是否必填。 */
  readonly endpointRequired: boolean
  /** 端点示例 / 留空时的行为（进文档与自检提示）。 */
  readonly endpointHint: string
  /** 由区域推导端点（阿里云：`oss-cn-hangzhou` → `https://oss-cn-hangzhou.aliyuncs.com`）。 */
  readonly endpointFromRegion?: (region: string) => string
}

/** 三个 provider 的档案表。 */
export const PROFILES: Readonly<Record<OssProvider, ProviderProfile>> = {
  rustfs: {
    provider: 'rustfs',
    label: 'RustFS / MinIO 等自建 S3 兼容端点',
    env: {
      endpoint: 'RUSTFS_ENDPOINT',
      bucket: 'RUSTFS_BUCKET',
      accessKeyId: 'RUSTFS_ACCESS_KEY',
      secretAccessKey: 'RUSTFS_SECRET_KEY',
      region: 'RUSTFS_REGION',
    },
    defaultRegion: 'us-east-1',
    forcePathStyle: true,
    endpointRequired: true,
    endpointHint: 'http://127.0.0.1:9000（必填）',
  },
  aliyun: {
    provider: 'aliyun',
    label: '阿里云 OSS',
    env: {
      endpoint: 'OSS_ENDPOINT',
      bucket: 'OSS_BUCKET',
      accessKeyId: 'OSS_ACCESS_KEY_ID',
      secretAccessKey: 'OSS_ACCESS_KEY_SECRET',
      region: 'OSS_REGION',
    },
    defaultRegion: 'oss-cn-hangzhou',
    // 阿里云走虚拟主机风格（`https://<bucket>.oss-cn-hangzhou.aliyuncs.com`）。
    forcePathStyle: false,
    endpointRequired: false,
    endpointHint: 'https://oss-cn-hangzhou.aliyuncs.com（留空则按区域推导）',
    endpointFromRegion: (region) => `https://${region}.aliyuncs.com`,
  },
  aws: {
    provider: 'aws',
    label: 'AWS S3',
    env: {
      endpoint: 'AWS_ENDPOINT',
      bucket: 'AWS_BUCKET',
      accessKeyId: 'AWS_ACCESS_KEY_ID',
      secretAccessKey: 'AWS_SECRET_ACCESS_KEY',
      region: 'AWS_REGION',
    },
    defaultRegion: null,
    forcePathStyle: false,
    endpointRequired: false,
    endpointHint: '留空即用 AWS 标准端点（常用 AWS_ENDPOINT 指向兼容实现）',
  },
}

/**
 * 取 provider 档案。
 *
 * @param provider - provider 标识。
 * @returns 档案。
 */
export function providerProfile(provider: OssProvider): ProviderProfile {
  return PROFILES[provider]
}

/** `OSS_PROVIDER` 取值无法识别时抛出。 */
export class UnsupportedProviderError extends Error {
  /**
   * 刻意**不回显用户填的值**：万一有人把 AK 误填进 `OSS_PROVIDER`，
   * 回显就等于把密钥写进日志（红线 2）。
   */
  constructor() {
    super(
      `环境变量 ${PROVIDER_ENV} 的取值无法识别（只支持 rustfs / aliyun / aws）。` +
        '请检查该变量的拼写；为避免泄漏，这里不会回显它的内容。',
    )
    this.name = 'UnsupportedProviderError'
  }
}

/**
 * 解析 provider。
 *
 * 未设置时默认 `rustfs` —— 保持既有用户的配置（他们此前用的是 `RUSTFS_*`）不受影响。
 * 另外接受几个常见别名，省得用户去查文档。
 *
 * @param env - 环境变量表。
 * @returns provider 与"非法原值"标记。
 */
export function readProvider(env: NodeJS.ProcessEnv = process.env): {
  provider: OssProvider
  unsupported: boolean
} {
  const raw = readNonEmpty(env, PROVIDER_ENV)
  if (raw === undefined) return { provider: 'rustfs', unsupported: false }
  switch (raw.toLowerCase()) {
    case 'rustfs':
    case 'minio':
      return { provider: 'rustfs', unsupported: false }
    case 'aliyun':
    case 'oss':
    case 'alibaba':
      return { provider: 'aliyun', unsupported: false }
    case 'aws':
    case 's3':
      return { provider: 'aws', unsupported: false }
    default:
      return { provider: 'rustfs', unsupported: true }
  }
}

/**
 * 本插件默认（rustfs）读取的环境变量名。
 *
 * 保留它是为了让文档、自检与既有测试共用一份真源；多 provider 场景请用
 * {@link providerProfile} 取对应档案。
 */
export const ENV_NAMES = PROFILES.rustfs.env

/** 默认区域（rustfs 档；S3 兼容实现通常不校验区域，但 SDK 签名必须带一个）。 */
export const DEFAULT_REGION = 'us-east-1'

/** 通过校验的对象存储配置。 */
export interface OssConfig {
  /** 生效的 provider。 */
  readonly provider: OssProvider
  /** provider 的变量名与说明（日志/自检用）。 */
  readonly profile: ProviderProfile
  /** 规范化后的端点；`null` 表示"不指定，用 SDK 默认端点"（AWS 的常态）。 */
  readonly endpoint: string | null
  /** 签名区域。 */
  readonly region: string
  /** 目标存储桶。 */
  readonly bucket: string
  /** 访问密钥 ID（机密，只在本进程内存中流转）。 */
  readonly accessKeyId: string
  /** 访问密钥密码（机密，只在本进程内存中流转）。 */
  readonly secretAccessKey: string
  /** 是否强制 path-style。 */
  readonly forcePathStyle: boolean
}

/**
 * 必需环境变量缺失时抛出。
 *
 * 安全约定：`message` 与 `missing` **只含变量名**。任何变量值都不会进入这里。
 */
export class MissingEnvironmentError extends Error {
  /** 缺失的变量名，按检查顺序排列。 */
  readonly missing: readonly string[]

  /**
   * @param missing - 缺失的变量名列表。
   */
  constructor(missing: readonly string[]) {
    super(
      `缺少必需的环境变量：${missing.join('、')}。` +
        '请在启动 dsh web 之前设置它们（AK/SK 只从环境变量读取，本插件不会写入任何文件，也不会把值放进日志）。',
    )
    this.name = 'MissingEnvironmentError'
    this.missing = [...missing]
  }
}

/**
 * 读取一个非空环境变量。
 *
 * @param env - 环境变量表。
 * @param name - 变量名。
 * @returns 去空白后的值；未设置或全空白时返回 `undefined`。
 */
function readNonEmpty(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 规范化端点：补 scheme、去掉尾部斜杠。
 *
 * RustFS 文档里 endpoint 写作 `http://IP:9000`，但用户常常只写 `IP:9000`。
 * 少一个 scheme 时 SDK 会报一个与真实原因毫无关系的协议错误，所以这里补全。
 *
 * 注意：补的默认 scheme 是 `http`，所以云厂商端点**务必带上 `https://`**。
 *
 * @param endpoint - 原始端点。
 * @returns 规范化后的端点。
 */
export function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '')
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed
  return `http://${trimmed}`
}

/**
 * 读取并校验对象存储配置。
 *
 * 一次性报告**所有**缺失变量（而不是撞到第一个就抛），避免用户改一个跑一次。
 *
 * @param env - 环境变量表，默认 `process.env`。
 * @returns 完整配置。
 * @throws {UnsupportedProviderError} `OSS_PROVIDER` 取值无法识别时。
 * @throws {MissingEnvironmentError} 任何必需变量缺失时。
 */
export function readOssConfig(env: NodeJS.ProcessEnv = process.env): OssConfig {
  const { provider, unsupported } = readProvider(env)
  if (unsupported) throw new UnsupportedProviderError()
  const profile = providerProfile(provider)

  const missing: string[] = []
  const take = (name: string): string => {
    const value = readNonEmpty(env, name)
    if (value === undefined) {
      missing.push(name)
      return ''
    }
    return value
  }

  const accessKeyId = take(profile.env.accessKeyId)
  const secretAccessKey = take(profile.env.secretAccessKey)
  const bucket = take(profile.env.bucket)

  const rawRegion = readNonEmpty(env, profile.env.region)
  let region = rawRegion
  if (region === undefined) {
    if (profile.defaultRegion !== null) region = profile.defaultRegion
    else missing.push(profile.env.region)
  }

  // 端点：必填的必须给；否则能推导就推导，推导不出就留 null（交给 SDK 默认端点）。
  const rawEndpoint = readNonEmpty(env, profile.env.endpoint)
  let endpoint: string | null = null
  if (rawEndpoint !== undefined) {
    endpoint = normalizeEndpoint(rawEndpoint)
  } else if (profile.endpointRequired) {
    missing.push(profile.env.endpoint)
  } else if (profile.endpointFromRegion !== undefined) {
    endpoint = profile.endpointFromRegion(region ?? profile.defaultRegion ?? '')
  }

  if (missing.length > 0) throw new MissingEnvironmentError(missing)

  return {
    provider,
    profile,
    endpoint,
    region: region ?? '',
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: profile.forcePathStyle,
  }
}

/** 供 UI 展示的环境自检结果。**不含任何机密值。** */
export interface OssEnvironmentReport {
  /** 所有必需变量是否齐备。 */
  readonly ready: boolean
  /** 缺失的变量名（空数组表示齐备）。 */
  readonly missing: readonly string[]
  /** 生效的 provider。 */
  readonly provider: OssProvider
  /** provider 的面向人的名字。 */
  readonly providerLabel: string
  /** 是否强制 path-style（UI 用来解释寻址风格）。 */
  readonly forcePathStyle: boolean
  /** 端点（已脱敏；未设置时为 null）。 */
  readonly endpoint: string | null
  /** 存储桶（未设置时为 null）。 */
  readonly bucket: string | null
  /** 生效区域。 */
  readonly region: string
  /** 访问密钥 ID 是否已设置——**只报存在性，不报值**。 */
  readonly accessKeyConfigured: boolean
  /** 访问密钥密码是否已设置——**只报存在性，不报值**。 */
  readonly secretKeyConfigured: boolean
  /** 实际读取的变量名，便于设置页直接展示"该设哪些"。 */
  readonly variableNames: {
    readonly endpoint: string
    readonly accessKeyId: string
    readonly secretAccessKey: string
    readonly bucket: string
    readonly region: string
  }
  /** 端点提示（示例 / 留空行为）。 */
  readonly endpointHint: string
}

/**
 * 生成脱敏的环境自检报告，供设置页/侧边栏展示。
 *
 * 这里刻意不调用 {@link readOssConfig}：环境不全时也要能告诉用户"缺哪些"，
 * 而不是抛异常让 UI 只剩一句"未就绪"。
 *
 * @param env - 环境变量表，默认 `process.env`。
 * @returns 不含机密值的报告。
 */
export function describeOssEnvironment(env: NodeJS.ProcessEnv = process.env): OssEnvironmentReport {
  const { provider } = readProvider(env)
  const profile = providerProfile(provider)

  const missing: string[] = []
  const check = (name: string, optional = false): boolean => {
    const present = readNonEmpty(env, name) !== undefined
    if (!present && !optional) missing.push(name)
    return present
  }

  check(profile.env.endpoint, !profile.endpointRequired || profile.endpointFromRegion !== undefined)
  const hasAccessKey = check(profile.env.accessKeyId)
  const hasSecretKey = check(profile.env.secretAccessKey)
  const hasBucket = check(profile.env.bucket)
  // 这一行只为把缺失项收进 missing；展示用的是下面算出的"生效区域"（有默认值就不算缺）。
  check(profile.env.region, profile.defaultRegion !== null)

  // 端点可能写成 http://ak:sk@host 这种带凭证形式 —— 外传前按形态脱敏。
  const rawEndpoint = readNonEmpty(env, profile.env.endpoint)
  const region = readNonEmpty(env, profile.env.region) ?? profile.defaultRegion ?? ''
  const derived =
    rawEndpoint ??
    (profile.endpointFromRegion === undefined ? null : profile.endpointFromRegion(region))

  return {
    ready: missing.length === 0,
    missing,
    provider,
    providerLabel: profile.label,
    forcePathStyle: profile.forcePathStyle,
    endpoint: derived === null ? null : redactEndpointForDisplay(derived),
    bucket: hasBucket ? (readNonEmpty(env, profile.env.bucket) ?? null) : null,
    // 生效区域：显式值优先，其次 provider 的默认值（AWS 没有默认值 → 空串）。
    region,
    accessKeyConfigured: hasAccessKey,
    secretKeyConfigured: hasSecretKey,
    variableNames: {
      endpoint: profile.env.endpoint,
      accessKeyId: profile.env.accessKeyId,
      secretAccessKey: profile.env.secretAccessKey,
      bucket: profile.env.bucket,
      region: profile.env.region,
    },
    endpointHint: profile.endpointHint,
  }
}

/**
 * 端点脱敏：抹掉 URL userinfo 与任何凭证形态的 query。
 *
 * @param endpoint - 原始端点。
 * @returns 可安全展示的端点。
 */
function redactEndpointForDisplay(endpoint: string): string {
  return endpoint
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s]+@/g, '$1***@')
    .replace(/((?:signature|credential|token|access_key_id|secret_access_key)\s*[=:]\s*)([^&\s]+)/gi, '$1***')
}
