/**
 * 上传实现（Host 半边）。
 *
 * 只使用 AWS 官方的 S3 SDK 家族：`@aws-sdk/client-s3`（命令与客户端）
 * 与 `@aws-sdk/lib-storage`（分片上传）。没有别家 OSS SDK，也没有自研签名。
 * S3 兼容端点（RustFS / MinIO）必须走 path-style 寻址，所以 `forcePathStyle` 由 provider 决定。
 *
 * **按文件大小自动选上传方式**：
 *
 *   · ≤ {@link MULTIPART_THRESHOLD_BYTES}：一次性 `PutObject`，少一次往返；
 *   · 更大：`Upload` **分片并行**传 —— 内存占用恒定（每片 {@link PART_SIZE_BYTES} ×
 *     {@link PART_CONCURRENCY} 并发），不再随文件大小增长。
 *
 * 之前是"整个文件读进内存再 PUT"，一个几百 MB 的文件就够把 Node 的堆吃掉；
 * 分片之后上传上限由 S3 协议决定（单对象 5 TB），与插件内存无关。
 *
 * 依赖注入的口子（{@link UploadDeps}）只为测试服务：单测里换上假的 S3 客户端，
 * 就能在不联网、不碰真实凭证的前提下验证命令参数与错误脱敏。
 *
 * @module dsh-plugin-oss-backup/upload
 */

import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
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
  /** 读整个文件（小文件路径用），默认 `node:fs/promises` 的 `readFile`。 */
  readonly readFile?: (path: string) => Promise<Uint8Array>
  /** 取文件大小（决定走哪条路），默认 `node:fs/promises` 的 `stat`。 */
  readonly statFile?: (path: string) => Promise<{ size: number }>
  /** 打开读流（分片路径用），默认 `node:fs` 的 `createReadStream`。 */
  readonly openStream?: (path: string) => Readable
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
 * 超过这个大小就改用分片上传。
 *
 * 8 MB：小文件走单次 `PutObject` 能少一次往返，而分片的收益要到几十 MB 才明显。
 */
export const MULTIPART_THRESHOLD_BYTES = 8 * 1024 * 1024

/** 每片大小。S3 要求除最后一片外每片至少 5 MB，这里取 8 MB。 */
export const PART_SIZE_BYTES = 8 * 1024 * 1024

/** 同时上传的分片数。峰值内存 ≈ 片大小 × 这个数。 */
export const PART_CONCURRENCY = 4

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
 * 按大小自动选单次 PUT 或分片上传；失败路径全部经过 {@link safeErrorMessage} 脱敏，
 * 成功路径只回显对象键与字节数。
 *
 * @param input - 本地路径与对象键。
 * @param deps - 可注入依赖（测试用）。
 * @returns 上传结果。
 * @throws {MissingEnvironmentError} 必需环境变量缺失时（消息只含变量名）。
 * @throws {Error} 取文件信息失败、读文件失败或上传失败时（消息已脱敏）。
 */
export async function uploadFileToOss(input: UploadInput, deps: UploadDeps = {}): Promise<UploadResult> {
  const env = deps.env ?? process.env
  // 先取配置：缺变量时立刻失败，不浪费一次文件访问。
  const config = readOssConfig(env)

  // 先 stat 拿大小：决定走哪条路，也顺带确认文件确实在（比读一遍内容便宜得多）。
  const statFile = deps.statFile ?? ((path: string) => stat(path))
  let size: number
  try {
    size = (await statFile(input.filePath)).size
  } catch (error) {
    throw new Error(`无法读取本地文件 ${input.filePath}：${safeErrorMessage(error)}`)
  }

  const createClient = deps.createClient ?? createS3Client
  const client = createClient(config)
  const params = { Bucket: config.bucket, Key: input.objectKey }

  // 小文件要整份读进内存。**读失败与上传失败要分开报**，所以读放在下面 try 之外。
  let body: Uint8Array | null = null
  if (size <= MULTIPART_THRESHOLD_BYTES) {
    const read = deps.readFile ?? ((path: string) => readFile(path))
    try {
      body = await read(input.filePath)
    } catch (error) {
      throw new Error(`无法读取本地文件 ${input.filePath}：${safeErrorMessage(error)}`)
    }
  }

  try {
    if (body !== null) {
      await client.send(
        new PutObjectCommand({ ...params, Body: body, ContentLength: body.byteLength }),
      )
    } else {
      // 大文件：分片并行。**不把整个文件读进内存** —— 峰值内存约
      // `PART_SIZE_BYTES × PART_CONCURRENCY`，与文件大小无关。
      const openStream = deps.openStream ?? ((path: string) => createReadStream(path))
      const upload = new Upload({
        // lib-storage 的类型要求完整的 S3Client；我们只用到它的 send，
        // 测试注入的替身同样满足这个契约。
        client: client as unknown as S3Client,
        params: { ...params, Body: openStream(input.filePath) },
        partSize: PART_SIZE_BYTES,
        queueSize: PART_CONCURRENCY,
      })
      await upload.done()
    }
  } catch (error) {
    throw new Error(
      `上传到对象存储失败（bucket=${config.bucket}，key=${input.objectKey}）：${safeErrorMessage(error)}`,
    )
  }

  return {
    objectKey: input.objectKey,
    bytes: size,
    message: `Uploaded: ${input.objectKey} (${size} bytes)`,
  }
}
