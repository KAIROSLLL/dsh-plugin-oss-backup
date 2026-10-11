/**
 * 密钥脱敏（Host 半边）。
 *
 * 本插件的红线是「AK/SK 的值绝不出现在任何日志、错误消息或工具输出里」。
 * 光靠"我不主动打印"是不够的：异常对象、SDK 的 message、URL、签名头都可能
 * 顺带把凭证抄出来。所以这里做**出口脱敏**——任何要离开本模块的字符串都先过一遍
 * {@link redactSecrets}，把识别到的凭证形态替换成 `***`。
 *
 * 设计取舍：
 *   · 只替换「当前进程环境里确实存在、且长度足够」的值，避免把无关短串误伤成 `***`；
 *   · 同时按**形态**兜底（URL userinfo、AWS 签名相关 query/header），
 *     这样即使某个值不是从我们的环境变量来的（例如 SDK 自己拼的签名串），也不会漏。
 *
 * @module dsh-plugin-oss-backup/redact
 */

/** 替换后的占位符。刻意不含任何原文片段。 */
export const REDACTED = '***'

/** 被视为机密的凭证类环境变量名（只读名字，不读值之外的任何用途）。 */
export const SECRET_ENV_NAMES = [
  'RUSTFS_ACCESS_KEY',
  'RUSTFS_SECRET_KEY',
  'RUSTFS_SESSION_TOKEN',
  // 阿里云 OSS
  'OSS_ACCESS_KEY_ID',
  'OSS_ACCESS_KEY_SECRET',
  'OSS_SESSION_TOKEN',
  // AWS
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const

/**
 * 值短于这个长度就不作为替换目标：3 个字符以内的串在正常文本里太容易撞上
 * （例如 "S3"、"oss"），替换它会把可读的错误消息毁掉。真正的 AWS 凭证远长于此。
 */
const MIN_SECRET_LENGTH = 4

/**
 * 从环境中收集需要脱敏的值。
 *
 * 只返回值的副本用于替换，**不缓存到模块级**：环境变量可能在测试里被改写，
 * 而缓存会让"换了凭证但脱敏表没换"变成静默漏洞。
 *
 * @param env - 环境变量表，默认 `process.env`。
 * @returns 去重后的秘密值列表（短于 {@link MIN_SECRET_LENGTH} 的忽略）。
 */
export function collectSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = new Set<string>()
  for (const name of SECRET_ENV_NAMES) {
    const value = env[name]
    if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH) values.add(value)
  }
  return [...values]
}

/**
 * 抹掉 URL 里的 userinfo（`scheme://user:pass@host` → `scheme://***@host`）。
 *
 * RustFS/OSS 的 endpoint 允许写成带凭证的形式，一旦这种串进了错误消息就等于泄漏。
 *
 * @param text - 待处理文本。
 * @returns 处理后的文本。
 */
function redactUrlUserInfo(text: string): string {
  return text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s]+@/g, `$1${REDACTED}@`)
}

/**
 * 抹掉 AWS 签名体系里的敏感字段值。
 *
 * 覆盖两种写法：`X-Amz-Signature=...`（presigned URL / query）与
 * `Authorization: AWS4-HMAC-SHA256 Credential=...`（请求头）。
 *
 * @param text - 待处理文本。
 * @returns 处理后的文本。
 */
function redactSignatureFields(text: string): string {
  return text
    .replace(
      /((?:x-amz-signature|x-amz-credential|x-amz-security-token|aws_access_key_id|aws_secret_access_key|secret_access_key|access_key_id|session_token)\s*[=:]\s*)([^&\s,'")\]]+)/gi,
      `$1${REDACTED}`,
    )
    .replace(/(credential\s*=\s*)([^,\s]+)/gi, `$1${REDACTED}`)
    // 裸 `Signature=` —— `Authorization` 头里就是这个名字。
    // 早期只覆盖了 `X-Amz-Signature`（presigned URL 形态），于是 `Signature=deadbeef…`
    // 会原样漏进日志：实测拿假凭证打真实端点、让服务端回显签名串时才暴露出来。
    .replace(/(signature\s*[=:]\s*)([^,&\s'")\]]+)/gi, `$1${REDACTED}`)
}

/**
 * 出口脱敏：把文本里所有已知凭证值与凭证形态替换成 `***`。
 *
 * @param text - 待脱敏文本。
 * @param secrets - 要抹掉的字面量值；默认从当前环境现取（见 {@link collectSecretValues}）。
 * @returns 可安全写进日志/错误/工具输出的文本。
 */
export function redactSecrets(text: string, secrets: readonly string[] = collectSecretValues()): string {
  let output = text
  // 先按字面量长串替换（最长优先，避免一个值是另一个值的前缀时留下残尾）。
  const ordered = [...secrets].sort((left, right) => right.length - left.length)
  for (const secret of ordered) {
    if (secret.length < MIN_SECRET_LENGTH) continue
    output = output.split(secret).join(REDACTED)
  }
  return redactSignatureFields(redactUrlUserInfo(output))
}

/**
 * 把任意抛出物整理成一行可安全外传的消息。
 *
 * 注意：这里只取 `message`/`name`，**不序列化整个 error 对象**——
 * AWS SDK 的异常上挂着 `$metadata`、`$response` 等字段，整体 JSON 化极易夹带请求头。
 *
 * @param error - 捕获到的任意值。
 * @returns 脱敏后的单行消息。
 */
export function safeErrorMessage(error: unknown): string {
  let raw: string
  if (error instanceof Error) {
    raw = error.message === '' ? error.name : `${error.name}: ${error.message}`
  } else if (typeof error === 'string') {
    raw = error
  } else {
    try {
      raw = String(error)
    } catch {
      raw = 'unknown error'
    }
  }
  return redactSecrets(raw)
}
