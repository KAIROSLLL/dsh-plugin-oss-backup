/**
 * 自动备份的单元测试：配置解析、防抖、指数退避重试、日志脱敏、默认关闭。
 *
 * 时间相关行为一律用 fake timers 定死 —— 这类"时间窗"逻辑靠真机碰运气测不可靠。
 *
 * @module tests/auto-backup.spec
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTO_BACKUP_ENV,
  AutoBackup,
  DEFAULT_BACKUP_PREFIX,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_RETRY_BACKOFF_MS,
  normalizeBackupPrefix,
  readAutoBackupConfig,
  sanitizeObjectKeyTail,
  type AutoBackupConfig,
} from '../src/auto-backup.js'
import type { UploadResult } from '../src/upload.js'

/** 哨兵凭证（不是真值）：用来断言日志脱敏。 */
const ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE'
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'

/**
 * 造一个记录日志的假日志器。
 *
 * @returns 日志器与两个数组。
 */
function makeLogger(): {
  logger: { info: (message: string) => void; warn: (message: string) => void }
  info: string[]
  warn: string[]
} {
  const info: string[] = []
  const warn: string[] = []
  return { info, warn, logger: { info: (message) => info.push(message), warn: (message) => warn.push(message) } }
}

/**
 * 造一份配置。
 *
 * @param overrides - 覆盖项。
 * @returns 配置。
 */
function makeConfig(overrides: Partial<AutoBackupConfig> = {}): AutoBackupConfig {
  return {
    enabled: true,
    prefix: DEFAULT_BACKUP_PREFIX,
    debounceMs: DEFAULT_DEBOUNCE_MS,
    backoffMs: DEFAULT_RETRY_BACKOFF_MS,
    ...overrides,
  }
}

/**
 * 造一个成功的上传结果。
 *
 * @param objectKey - 对象键。
 * @returns 上传结果。
 */
function okResult(objectKey: string): UploadResult {
  return { objectKey, bytes: 16, message: `Uploaded: ${objectKey} (16 bytes)` }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('readAutoBackupConfig', () => {
  it('默认关闭：什么都不设时 enabled 为 false', () => {
    const config = readAutoBackupConfig({})
    expect(config.enabled).toBe(false)
    expect(config.prefix).toBe(DEFAULT_BACKUP_PREFIX)
    expect(config.debounceMs).toBe(2000)
    expect(config.backoffMs).toEqual([1000, 2000, 4000])
  })

  it('只有显式 true（忽略大小写与空白）才启用', () => {
    expect(readAutoBackupConfig({ [AUTO_BACKUP_ENV.enabled]: 'true' }).enabled).toBe(true)
    expect(readAutoBackupConfig({ [AUTO_BACKUP_ENV.enabled]: 'TRUE' }).enabled).toBe(true)
    expect(readAutoBackupConfig({ [AUTO_BACKUP_ENV.enabled]: '  true  ' }).enabled).toBe(true)
  })

  it('其它任何取值都算关闭（1 / yes / false / 空串）', () => {
    for (const value of ['1', 'yes', 'on', 'false', 'FALSE', '', '   ']) {
      expect(readAutoBackupConfig({ [AUTO_BACKUP_ENV.enabled]: value }).enabled).toBe(false)
    }
  })

  it('前缀可自定义，缺省时回退 workspace-backup/', () => {
    expect(readAutoBackupConfig({ [AUTO_BACKUP_ENV.prefix]: 'my-bucket-prefix' }).prefix).toBe('my-bucket-prefix/')
    expect(readAutoBackupConfig({ [AUTO_BACKUP_ENV.prefix]: '   ' }).prefix).toBe(DEFAULT_BACKUP_PREFIX)
  })
})

describe('normalizeBackupPrefix', () => {
  it('补上结尾斜杠、去掉前导斜杠', () => {
    expect(normalizeBackupPrefix('workspace-backup')).toBe('workspace-backup/')
    expect(normalizeBackupPrefix('/workspace-backup/')).toBe('workspace-backup/')
    expect(normalizeBackupPrefix('///a/b')).toBe('a/b/')
  })

  it('空值与非字符串回退默认前缀', () => {
    expect(normalizeBackupPrefix('')).toBe(DEFAULT_BACKUP_PREFIX)
    expect(normalizeBackupPrefix('   ')).toBe(DEFAULT_BACKUP_PREFIX)
    expect(normalizeBackupPrefix(undefined)).toBe(DEFAULT_BACKUP_PREFIX)
  })
})

describe('AutoBackup 防抖', () => {
  it('同一文件快速连续登记，只触发一次上传', async () => {
    const { logger } = makeLogger()
    const upload = vi.fn(async (input: { filePath: string; objectKey: string }) => okResult(input.objectKey))
    const backup = new AutoBackup({ config: makeConfig(), logger, upload })

    // 模拟"文件保存后连续多次写事件"。
    backup.schedule('D:\\ws\\src\\index.ts')
    await vi.advanceTimersByTimeAsync(500)
    backup.schedule('D:\\ws\\src\\index.ts')
    await vi.advanceTimersByTimeAsync(500)
    backup.schedule('D:\\ws\\src\\index.ts')

    // 距离最后一次还不到 2 秒：一次都不该发生。
    await vi.advanceTimersByTimeAsync(1500)
    expect(upload).not.toHaveBeenCalled()

    // 越过防抖窗口：只发生一次。
    await vi.advanceTimersByTimeAsync(600)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0]?.[0]).toEqual({
      filePath: 'D:\\ws\\src\\index.ts',
      objectKey: 'workspace-backup/index.ts',
    })

    backup.dispose()
  })

  it('不同文件各自独立计时', async () => {
    const { logger } = makeLogger()
    const upload = vi.fn(async (input: { filePath: string; objectKey: string }) => okResult(input.objectKey))
    const backup = new AutoBackup({ config: makeConfig(), logger, upload })

    backup.schedule('/ws/a.ts')
    await vi.advanceTimersByTimeAsync(1000)
    backup.schedule('/ws/b.ts')

    // a 先到期。
    await vi.advanceTimersByTimeAsync(1100)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0]?.[0]?.objectKey).toBe('workspace-backup/a.ts')

    await vi.advanceTimersByTimeAsync(1000)
    expect(upload).toHaveBeenCalledTimes(2)
    expect(upload.mock.calls[1]?.[0]?.objectKey).toBe('workspace-backup/b.ts')

    backup.dispose()
  })

  it('默认关闭时登记不产生任何上传', async () => {
    const { logger } = makeLogger()
    const upload = vi.fn(async (input: { filePath: string; objectKey: string }) => okResult(input.objectKey))
    const backup = new AutoBackup({ config: makeConfig({ enabled: false }), logger, upload })

    backup.schedule('/ws/a.ts')
    await vi.advanceTimersByTimeAsync(10000)

    expect(upload).not.toHaveBeenCalled()
    expect(backup.pending).toBe(0)
    backup.dispose()
  })

  it('dispose 之后待触发的定时器全部取消', async () => {
    const { logger } = makeLogger()
    const upload = vi.fn(async (input: { filePath: string; objectKey: string }) => okResult(input.objectKey))
    const backup = new AutoBackup({ config: makeConfig(), logger, upload })

    backup.schedule('/ws/a.ts')
    expect(backup.pending).toBe(1)
    backup.dispose()
    await vi.advanceTimersByTimeAsync(10000)
    expect(upload).not.toHaveBeenCalled()
  })

  it('对象键用注入的 toKeyTail（工作区相对路径），并把反斜杠转正斜杠', async () => {
    const { logger } = makeLogger()
    const upload = vi.fn(async (input: { filePath: string; objectKey: string }) => okResult(input.objectKey))
    const backup = new AutoBackup({
      config: makeConfig({ prefix: 'bk/' }),
      logger,
      upload,
      toKeyTail: () => 'src\\deep\\file.ts',
    })

    backup.schedule('/ws/file.ts')
    await vi.advanceTimersByTimeAsync(2000)

    expect(upload.mock.calls[0]?.[0]?.objectKey).toBe('bk/src/deep/file.ts')
    backup.dispose()
  })
})

describe('AutoBackup 重试与退避', () => {
  it('一直失败：共 4 次尝试，按 1s/2s/4s 退避，最后放弃并记日志', async () => {
    const { logger, warn, info } = makeLogger()
    const upload = vi.fn(async () => {
      throw new Error('上传到对象存储失败（bucket=dsh-backup）：InvalidAccessKeyId')
    })
    const backup = new AutoBackup({ config: makeConfig(), logger, upload })

    backup.schedule('/ws/a.ts')

    await vi.advanceTimersByTimeAsync(2000) // 防抖到期 → 第 1 次尝试失败
    expect(upload).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000) // 退避 1s → 第 2 次
    expect(upload).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(2000) // 退避 2s → 第 3 次
    expect(upload).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(4000) // 退避 4s → 第 4 次失败后放弃
    expect(upload).toHaveBeenCalledTimes(4)

    // 之后再推进也不会重试了（验收：重试 3 次后停止）。
    await vi.advanceTimersByTimeAsync(60000)
    expect(upload).toHaveBeenCalledTimes(4)

    expect(info).toHaveLength(0)
    expect(warn.join('\n')).toContain('1000ms 后重试')
    expect(warn.join('\n')).toContain('2000ms 后重试')
    expect(warn.join('\n')).toContain('4000ms 后重试')
    expect(warn.join('\n')).toContain('已重试 3 次后放弃')
    expect(backup.pending).toBe(0)

    backup.dispose()
  })

  it('第二次尝试成功时不再继续重试，并记一条完成日志', async () => {
    const { logger, info, warn } = makeLogger()
    let attempt = 0
    const upload = vi.fn(async (input: { filePath: string; objectKey: string }) => {
      attempt += 1
      if (attempt === 1) throw new Error('boom')
      return okResult(input.objectKey)
    })
    const backup = new AutoBackup({ config: makeConfig(), logger, upload })

    backup.schedule('/ws/a.ts')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(upload).toHaveBeenCalledTimes(2)
    expect(warn).toHaveLength(1)
    expect(info.join('\n')).toContain('自动备份完成：workspace-backup/a.ts')

    backup.dispose()
  })

  it('日志脱敏：失败原因里出现凭证值也会被抹掉', async () => {
    const { logger, warn } = makeLogger()
    const upload = vi.fn(async () => {
      throw new Error(`SignatureDoesNotMatch credential=${ACCESS_KEY}&secret=${SECRET_KEY}`)
    })
    const backup = new AutoBackup({ config: makeConfig({ backoffMs: [] }), logger, upload })

    // backoffMs 为空 → 只尝试一次就放弃，日志就在这一条里。
    backup.schedule('/ws/a.ts')
    await vi.advanceTimersByTimeAsync(2000)

    const text = warn.join('\n')
    expect(text).not.toContain(ACCESS_KEY)
    expect(text).not.toContain(SECRET_KEY)
    expect(text).toContain('自动备份失败')

    backup.dispose()
  })
})

describe('sanitizeObjectKeyTail（真机踩出来的 Windows 限制）', () => {
  it('剥掉 Windows 盘符 —— RustFS 拒绝含冒号的对象键', () => {
    // 实测错误：InvalidArgument: object key contains characters unsupported on Windows hosts
    expect(sanitizeObjectKeyTail('D:/projects/workspace/proj/src/index.ts')).toBe('projects/workspace/proj/src/index.ts')
    expect(sanitizeObjectKeyTail('C:\\work\\a.ts')).toBe('work/a.ts')
  })

  it('反斜杠统一、压掉重复与前导斜杠', () => {
    expect(sanitizeObjectKeyTail('\\\\ws\\\\a\\\\b.ts')).toBe('ws/a/b.ts')
    expect(sanitizeObjectKeyTail('ws//a///b.ts')).toBe('ws/a/b.ts')
  })

  it('兜底替换其它 Windows 非法字符', () => {
    expect(sanitizeObjectKeyTail('ws/a*b?c"d|e<f>g.ts')).toBe('ws/a_b_c_d_e_f_g.ts')
  })

  it('净化后为空时给个占位名，不会拼出裸前缀', () => {
    expect(sanitizeObjectKeyTail('///')).toBe('unnamed')
    expect(sanitizeObjectKeyTail('')).toBe('unnamed')
  })

  it('端到端：宿主返回带盘符路径时，对象键里不会出现冒号', async () => {
    const { logger } = makeLogger()
    const upload = vi.fn(async (input: { filePath: string; objectKey: string }) => okResult(input.objectKey))
    const backup = new AutoBackup({
      config: makeConfig(),
      logger,
      upload,
      // 模拟 fs.processPathFromHostPath() 的真实行为：返回带盘符的宿主路径。
      toKeyTail: () => 'D:/projects/workspace/dsh-plugin-oss-backup/.probe.txt',
    })

    backup.schedule('D:\\projects\\workspace\\dsh-plugin-oss-backup\\.probe.txt')
    await vi.advanceTimersByTimeAsync(2000)

    const key = upload.mock.calls[0]?.[0]?.objectKey ?? ''
    expect(key).toBe('workspace-backup/projects/workspace/dsh-plugin-oss-backup/.probe.txt')
    expect(key).not.toContain(':')

    backup.dispose()
  })
})
