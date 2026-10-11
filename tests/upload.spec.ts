/**
 * 上传路径的单元测试（依赖注入的假 S3 客户端）。
 *
 * 覆盖：命令参数、返回格式、缺环境变量、读文件失败、上传失败时的脱敏。
 *
 * @module tests/upload.spec
 */

import { describe, expect, it, vi } from 'vitest'
import { MissingEnvironmentError } from '../src/env.js'
import { uploadFileToOss, type S3ClientLike } from '../src/upload.js'

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
  configs: unknown[]
} {
  const send = vi.fn(behaviour)
  const configs: unknown[] = []
  return {
    client: { send },
    send,
    configs,
  }
}

describe('uploadFileToOss', () => {
  it('把文件写进配置好的桶与键，并返回固定格式的一行', async () => {
    const { client, send } = makeClient()
    const result = await uploadFileToOss(
      { filePath: 'D:\\tmp\\report.bin', objectKey: 'backups/report.bin' },
      { env: { ...ENV }, readFile: async () => BODY, createClient: () => client },
    )

    expect(result.message).toBe('Uploaded: backups/report.bin (5 bytes)')
    expect(result.bytes).toBe(5)
    expect(send).toHaveBeenCalledTimes(1)

    const command = send.mock.calls[0]?.[0] as { input: Record<string, unknown> }
    expect(command.input.Bucket).toBe('dsh-backup')
    expect(command.input.Key).toBe('backups/report.bin')
    expect(command.input.ContentLength).toBe(5)
    expect((command.input.Body as Uint8Array).byteLength).toBe(5)
  })

  it('缺环境变量时抛错，且不读文件、不建客户端', async () => {
    const readFile = vi.fn(async () => BODY)
    const createClient = vi.fn(() => makeClient().client)

    await expect(
      uploadFileToOss({ filePath: '/nope.bin', objectKey: 'k' }, { env: { RUSTFS_BUCKET: 'b' }, readFile, createClient }),
    ).rejects.toBeInstanceOf(MissingEnvironmentError)

    expect(readFile).not.toHaveBeenCalled()
    expect(createClient).not.toHaveBeenCalled()
  })

  it('缺环境变量的错误消息里不含已设置凭证的值', async () => {
    const error = await uploadFileToOss(
      { filePath: '/nope.bin', objectKey: 'k' },
      { env: { RUSTFS_ACCESS_KEY: ENV.RUSTFS_ACCESS_KEY, RUSTFS_BUCKET: 'b' }, readFile: async () => BODY },
    ).catch((caught: unknown) => caught as Error)

    expect(error.message).toContain('RUSTFS_SECRET_KEY')
    expect(error.message).not.toContain(ENV.RUSTFS_ACCESS_KEY)
  })

  it('读文件失败时给出含路径的清晰错误', async () => {
    const error = await uploadFileToOss(
      { filePath: 'D:\\missing\\nope.bin', objectKey: 'k' },
      {
        env: { ...ENV },
        readFile: async () => {
          const failure = new Error('ENOENT: no such file or directory')
          failure.name = 'Error'
          throw failure
        },
      },
    ).catch((caught: unknown) => caught as Error)

    expect(error.message).toContain('无法读取本地文件')
    expect(error.message).toContain('D:\\missing\\nope.bin')
  })

  it('上传失败时脱敏 SDK 错误（AK 出现在消息里也必须被抹掉）', async () => {
    const { client } = makeClient(async () => {
      throw new Error(`SignatureDoesNotMatch: credential=${ENV.RUSTFS_ACCESS_KEY}`)
    })

    const error = await uploadFileToOss(
      { filePath: 'D:\\tmp\\report.bin', objectKey: 'backups/report.bin' },
      { env: { ...ENV }, readFile: async () => BODY, createClient: () => client },
    ).catch((caught: unknown) => caught as Error)

    expect(error.message).toContain('上传到对象存储失败')
    expect(error.message).toContain('bucket=dsh-backup')
    expect(error.message).not.toContain(ENV.RUSTFS_ACCESS_KEY)
    expect(error.message).not.toContain(ENV.RUSTFS_SECRET_KEY)
  })
})
