/**
 * 上传实现（Host 半边）。
 *
 * 只使用 `@aws-sdk/client-s3` —— 没有别家 OSS SDK，也没有自研签名。
 * S3 兼容端点（RustFS / MinIO）必须走 path-style 寻址，所以 `forcePathStyle` 固定为 true。
 *
 * 依赖注入的口子（{@link UploadDeps}）只为测试服务：单测里换上假的 S3 客户端，
 * 就能在不联网、不碰真实凭证的前提下验证命令参数与错误脱敏。
 *
 * @module dsh-plugin-oss-backup/upload
 */

import { readFile } from 'node:fs/promises'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { readOssConfig, type OssConfig } from './env.js'
import { safeErrorMessage } from './redact.js'

/** 一次上传请求。 */
export interface UploadInput {
  /** 本地文件绝对路径。 */
  readonly filePath: string
  /** 目标对象键。 */
  readonly objectKey: string
}

/** 只用到 `send` 的最小 S3 客户端接口，便于测试替身。 */
export interface S3ClientLike {
  /**
   * 发送一条 S3 命令。
   *
   * @param command - SDK 命令实例。
   * @returns SDK 响应。
   */
  send(command: unknown): Promise<unknown>
}

/** 可注入的依赖（测试用；生产路径全部走默认实现）。 */
export interface UploadDeps {
  /** 环境变量表，默认 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv
  /** 读文件实现，默认 `node:fs/promises` 的 `readFile`。 */
  readonly readFile?: (path: string) => Promise<Uint8Array>
  /** S3 客户端工厂，默认 {@link createS3Client}。 */
  readonly createClient?: (config: OssConfig) => S3ClientLike
}

/** 上传结果（同时也是工具返回的规范值）。 */
export interface UploadResult {
  /** 目标对象键。 */
  readonly objectKey: string
  /** 实际写入的字节数。 */
  readonly bytes: number
  /** 面向模型的单行文本，格式固定为 `Uploaded: <key> (<n> bytes)`。 */
  readonly message: string
}

/**
 * 按配置构造 S3 客户端。
 *
 * @param config - 已校验的对象存储配置。
 * @returns 新的 S3 客户端。
 */
export function createS3Client(config: OssConfig): S3Client {
  return new S3Client({
    region: config.region,
    // 寻址风格由 provider 决定：自建端点（RustFS/MinIO）必须 path-style，
    // 云厂商（阿里云 OSS / AWS）走虚拟主机风格，设 true 反而会失败。
    forcePathStyle: config.forcePathStyle,
    // AWS 不指定 endpoint（用 SDK 默认端点）；RustFS 与阿里云都会显式给一个。
    ...(config.endpoint === null ? {} : { endpoint: config.endpoint }),
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  })
}

/**
 * 把本地文件上传到对象存储。
 *
 * 失败路径全部经过 {@link safeErrorMessage} 脱敏；成功路径只回显对象键与字节数。
 *
 * @param input - 本地路径与对象键。
 * @param deps - 可注入依赖（测试用）。
 * @returns 上传结果。
 * @throws {MissingEnvironmentError} 必需环境变量缺失时（消息只含变量名）。
 * @throws {Error} 读文件失败或上传失败时（消息已脱敏）。
 */
export async function uploadFileToOss(input: UploadInput, deps: UploadDeps = {}): Promise<UploadResult> {
  const env = deps.env ?? process.env
  // 先取配置：缺变量时立刻失败，不浪费一次文件读取。
  const config = readOssConfig(env)

  const read = deps.readFile ?? ((path: string) => readFile(path))
  let body: Uint8Array
  try {
    body = await read(input.filePath)
  } catch (error) {
    throw new Error(`无法读取本地文件 ${input.filePath}：${safeErrorMessage(error)}`)
  }

  const createClient = deps.createClient ?? createS3Client
  const client = createClient(config)

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: input.objectKey,
        Body: body,
        ContentLength: body.byteLength,
      }),
    )
  } catch (error) {
    throw new Error(
      `上传到对象存储失败（bucket=${config.bucket}，key=${input.objectKey}）：${safeErrorMessage(error)}`,
    )
  }

  return {
    objectKey: input.objectKey,
    bytes: body.byteLength,
    message: `Uploaded: ${input.objectKey} (${body.byteLength} bytes)`,
  }
}
