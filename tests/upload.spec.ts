/**
 * 上传路径的单元测试（依赖注入的假 S3 客户端）。
 *
 * 覆盖：命令参数、大小分派（单次 PUT vs 分片）、返回格式、缺环境变量、
 * 读文件失败、上传失败时的脱敏。
 *
 * @module tests/upload.spec
 */

import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { MissingEnvironmentError } from '../src/env.js'
import {
  MULTIPART_THRESHOLD_BYTES,
  PART_CONCURRENCY,
  PART_SIZE_BYTES,
  uploadFileToOss,
  type S3ClientLike,
  type UploadDeps,
} from '../src/upload.js'

/**
 * 把 `lib-storage` 的 `Upload` 换成记录参数的替身。
 *
 * 真实的 `Upload` 需要完整的 `S3Client`（内部会读 `client.config.requestChecksumCalculation`
 * 之类），塞一个只有 `send` 的假客户端会当场炸。而这里要验证的是**我们自己的分派逻辑** ——
 * 大文件确实交给了分片、参数传对了、没有整份读进内存 —— 所以 mock 掉它更准确也更稳。
 */
const h = vi.hoisted(() => ({
  uploads: [] as Array<Record<string, unknown>>,
  done: vi.fn(async () => ({})),
}))

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    constructor(options: Record<string, unknown>) {
      h.uploads.push(options)
    }

    done(): Promise<unknown> {
      return h.done()
    }
  },
}))

/** 齐备的测试环境（哨兵值）。 */
const ENV = {
  RUSTFS_ENDPOINT: 'http://127.0.0.1:9000',
  RUSTFS_ACCESS_KEY: 'AKIAIOSFODNN7EXAMPLE',
  RUSTFS_SECRET_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  RUSTFS_BUCKET: 'dsh-backup',
} as const

/** 一段固定内容，长度用于断言字节数。 */
const BODY = new Uint8Array([1, 2, 3, 4, 5])

/**
 * 造一个记录调用的假客户端。
 *
 * @param behaviour - `send` 的行为；默认成功。
 * @returns 假客户端与调用记录。
 */
function makeClient(behaviour: () => Promise<unknown> = async () => ({ ETag: '"fake"' })): {
  client: S3ClientLike
  send: ReturnType<typeof vi.fn>
} {
  const send = vi.fn(behaviour)
  return { client: { send }, send }
}

/**
 * 造一份"小文件"依赖（默认 5 字节，走单次 PUT）。
 *
 * @param extra - 覆盖项。
 * @returns 依赖。
 */
function smallDeps(extra: Partial<UploadDeps> = {}): UploadDeps {
  return {
    env: { ...ENV },
    statFile: async () => ({ size: BODY.byteLength }),
    readFile: async () => BODY,
    ...extra,
  }
}

/**
 * 取出一次 `send` 收到的命令类名 —— 用它判断走的是单次 PUT 还是分片。
 *
 * @param command - SDK 命令实例。
 * @returns 类名。
 */
function commandName(command: unknown): string {
  return (command as { constructor: { name: string } }).constructor.name
}

describe('uploadFileToOss', () => {
  it('小文件走单次 PUT：写进配置好的桶与键，并返回固定格式的一行', async () => {
    const { client, send } = makeClient()
    const result = await uploadFileToOss(
      { filePath: 'D:\\tmp\\report.bin', objectKey: 'backups/report.bin' },
      smallDeps({ createClient: () => client }),
    )

    expect(result.message).toBe('Uploaded: backups/report.bin (5 bytes)')
    expect(result.bytes).toBe(5)
    expect(send).toHaveBeenCalledTimes(1)
    expect(commandName(send.mock.calls[0]?.[0])).toBe('PutObjectCommand')

    const command = send.mock.calls[0]?.[0] as { input: Record<string, unknown> }
    expect(command.input.Bucket).toBe('dsh-backup')
    expect(command.input.Key).toBe('backups/report.bin')
    expect(command.input.ContentLength).toBe(5)
    expect((command.input.Body as Uint8Array).byteLength).toBe(5)
  })

  it('阈值边界：正好 8 MB 仍走单次 PUT', async () => {
    const { client, send } = makeClient()
    await uploadFileToOss(
      { filePath: '/exact.bin', objectKey: 'k' },
      smallDeps({
        statFile: async () => ({ size: MULTIPART_THRESHOLD_BYTES }),
        readFile: async () => new Uint8Array(MULTIPART_THRESHOLD_BYTES),
        createClient: () => client,
      }),
    )
    expect(send.mock.calls.map((call) => commandName(call[0]))).toEqual(['PutObjectCommand'])
  })

  it('大文件走分片：**不整份读进内存**，而是开流交给分片上传', async () => {
    h.uploads.length = 0
    const size = MULTIPART_THRESHOLD_BYTES + 1_000_000
    const readFile = vi.fn(async () => BODY)
    const openStream = vi.fn(() => Readable.from([Buffer.alloc(size)]))
    const send = vi.fn(async () => ({}))

    const result = await uploadFileToOss(
      { filePath: 'D:\\tmp\\big.bin', objectKey: 'backups/big.bin' },
      {
        env: { ...ENV },
        statFile: async () => ({ size }),
        readFile,
        openStream,
        createClient: () => ({ send }),
      },
    )

    expect(result.bytes).toBe(size)
    expect(result.message).toBe(`Uploaded: backups/big.bin (${size} bytes)`)
    // 关键断言：整份读内存那条路**没有**被走。
    expect(readFile).not.toHaveBeenCalled()
    expect(openStream).toHaveBeenCalledWith('D:\\tmp\\big.bin')
    // 也没走单次 PUT。
    expect(send).not.toHaveBeenCalled()

    // 交给分片上传的参数：桶、键、流、片大小、并发数。
    expect(h.uploads).toHaveLength(1)
    const options = h.uploads[0]!
    expect(options.partSize).toBe(PART_SIZE_BYTES)
    expect(options.queueSize).toBe(PART_CONCURRENCY)
    const params = options.params as Record<string, unknown>
    expect(params.Bucket).toBe('dsh-backup')
    expect(params.Key).toBe('backups/big.bin')
    expect(params.Body).toBeDefined()
    expect(h.done).toHaveBeenCalledTimes(1)
  })

  it('缺环境变量时抛错，且不 stat、不读文件、不建客户端', async () => {
    const statFile = vi.fn(async () => ({ size: BODY.byteLength }))
    const readFile = vi.fn(async () => BODY)
    const createClient = vi.fn(() => makeClient().client)

    await expect(
      uploadFileToOss(
        { filePath: '/nope.bin', objectKey: 'k' },
        { env: { RUSTFS_BUCKET: 'b' }, statFile, readFile, createClient },
      ),
    ).rejects.toBeInstanceOf(MissingEnvironmentError)

    expect(statFile).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
    expect(createClient).not.toHaveBeenCalled()
  })

  it('缺环境变量的错误消息里不含已设置凭证的值', async () => {
    const error = await uploadFileToOss(
      { filePath: '/nope.bin', objectKey: 'k' },
      { env: { RUSTFS_ACCESS_KEY: ENV.RUSTFS_ACCESS_KEY, RUSTFS_BUCKET: 'b' } },
    ).catch((caught: unknown) => caught as Error)

    expect(error.message).toContain('RUSTFS_SECRET_KEY')
    expect(error.message).not.toContain(ENV.RUSTFS_ACCESS_KEY)
  })

  it('取文件信息失败时给出含路径的清晰错误', async () => {
    const error = await uploadFileToOss(
      { filePath: 'D:\\missing\\nope.bin', objectKey: 'k' },
      {
        env: { ...ENV },
        statFile: async () => {
          throw new Error('ENOENT: no such file or directory')
        },
      },
    ).catch((caught: unknown) => caught as Error)

    expect(error.message).toContain('无法读取本地文件')
    expect(error.message).toContain('D:\\missing\\nope.bin')
  })

  it('小文件读内容失败时同样给含路径的错误', async () => {
    const error = await uploadFileToOss(
      { filePath: 'D:\\missing\\nope.bin', objectKey: 'k' },
      smallDeps({
        readFile: async () => {
          throw new Error('EACCES: permission denied')
        },
      }),
    ).catch((caught: unknown) => caught as Error)

    expect(error.message).toContain('无法读取本地文件')
  })

  it('上传失败时脱敏 SDK 错误（AK 出现在消息里也必须被抹掉）', async () => {
    const { client } = makeClient(async () => {
      throw new Error(`SignatureDoesNotMatch: credential=${ENV.RUSTFS_ACCESS_KEY}`)
    })

    const error = await uploadFileToOss(
      { filePath: 'D:\\tmp\\report.bin', objectKey: 'backups/report.bin' },
      smallDeps({ createClient: () => client }),
    ).catch((caught: unknown) => caught as Error)

    expect(error.message).toContain('上传到对象存储失败')
    expect(error.message).toContain('bucket=dsh-backup')
    expect(error.message).not.toContain(ENV.RUSTFS_ACCESS_KEY)
    expect(error.message).not.toContain(ENV.RUSTFS_SECRET_KEY)
  })
})
