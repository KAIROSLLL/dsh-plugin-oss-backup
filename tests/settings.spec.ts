/**
 * 设置的单元测试：默认值、字段收窄（**丢弃任何凭证字段**）、落盘与回退。
 *
 * 红线 3 是"密钥写入本地文件即失败"，所以这里有一组专门盯着配置文件的断言。
 *
 * @module tests/settings.spec
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  dshHome,
  normalizeSettings,
  readSettings,
  settingsFilePath,
  writeSettings,
} from '../src/settings.js'

/** 哨兵凭证（不是真值）。 */
const ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE'
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'

/** 临时 home。 */
let home: string | null = null

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'oss-settings-'))
})

afterEach(async () => {
  if (home !== null) {
    await rm(home, { recursive: true, force: true })
    home = null
  }
})

describe('normalizeSettings', () => {
  it('默认：自动备份关闭、目录为空、前缀 workspace-backup/、跳过缓存目录', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS.autoBackup).toBe(false)
    expect(DEFAULT_SETTINGS.backupDir).toBe('')
    expect(DEFAULT_SETTINGS.prefix).toBe('workspace-backup/')
    expect(DEFAULT_SETTINGS.skipCaches).toBe(true)
  })

  it('skipCaches 可以关掉（关掉后连 __pycache__ 也会备份）', () => {
    expect(normalizeSettings({ skipCaches: false }).skipCaches).toBe(false)
    expect(normalizeSettings({ skipCaches: true }).skipCaches).toBe(true)
    // 类型不符时回退到基准值（默认仍是"跳过"）。
    expect(normalizeSettings({ skipCaches: 'no' }).skipCaches).toBe(true)
  })

  it('只认已知键，其余（含任何凭证字段）一律丢弃', () => {
    const out = normalizeSettings({
      autoBackup: true,
      backupDir: '  D:/ws  ',
      prefix: 'bk',
      provider: '  ALIYUN  ',
      endpoint: ' https://oss-cn-hangzhou.aliyuncs.com ',
      bucket: ' dsh-backup ',
      region: ' oss-cn-hangzhou ',
      gameEnabled: false,
      gameDifficulty: '  HARD  ',
      schedule: { mode: 'daily', hour: 3, minute: 5 },
      // 下面这些是"如果有人往请求体里塞凭证"的情形，必须被丢掉。
      accessKey: ACCESS_KEY,
      accessKeyId: ACCESS_KEY,
      secretKey: SECRET_KEY,
      secretAccessKey: SECRET_KEY,
      token: 'some-token',
      password: 'hunter2',
    })
    expect(out).toEqual({
      autoBackup: true,
      backupDir: 'D:/ws',
      prefix: 'bk/',
      skipCaches: true,
      // provider 与 gameDifficulty 会被小写化，其余项去空白。
      provider: 'aliyun',
      endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
      bucket: 'dsh-backup',
      region: 'oss-cn-hangzhou',
      gameEnabled: false,
      gameDifficulty: 'hard',
      // 调度是嵌套对象：只保留白名单字段，其余补齐缺省。
      schedule: { mode: 'daily', every: 1, unit: 'hour', hour: 3, minute: 5, dayOfMonth: 1 },
    })
    const serialized = JSON.stringify(out)
    expect(serialized).not.toContain(ACCESS_KEY)
    expect(serialized).not.toContain(SECRET_KEY)
  })

  it('类型不符时回退到基准值，不做类型体操', () => {
    const out = normalizeSettings({ autoBackup: 'yes', backupDir: 42, prefix: null }, DEFAULT_SETTINGS)
    expect(out).toEqual(DEFAULT_SETTINGS)
  })

  it('兼容 autoBackupEnabled 这个别名', () => {
    expect(normalizeSettings({ autoBackupEnabled: true }).autoBackup).toBe(true)
  })
})

describe('readSettings / writeSettings', () => {
  it('写入后能读回，且**文件里不含任何凭证字眼**', async () => {
    const dir = home as string
    await writeSettings({ autoBackup: true, backupDir: 'D:/ws', prefix: 'bk' }, dir)

    const text = await readFile(settingsFilePath(dir), 'utf8')
    expect(text).not.toMatch(/access|secret|token|password|credential/i)
    expect(JSON.parse(text)).toEqual({
      autoBackup: true,
      backupDir: 'D:/ws',
      prefix: 'bk/',
      skipCaches: true,
      provider: '',
      endpoint: '',
      bucket: '',
      region: '',
      gameEnabled: true,
      gameDifficulty: 'easy',
      schedule: { mode: 'off', every: 1, unit: 'hour', hour: 3, minute: 0, dayOfMonth: 1 },
    })

    const back = await readSettings(dir)
    expect(back).toEqual({
      autoBackup: true,
      backupDir: 'D:/ws',
      prefix: 'bk/',
      skipCaches: true,
      provider: '',
      endpoint: '',
      bucket: '',
      region: '',
      gameEnabled: true,
      gameDifficulty: 'easy',
      schedule: { mode: 'off', every: 1, unit: 'hour', hour: 3, minute: 0, dayOfMonth: 1 },
    })
  })

  it('即使传入凭证字段，落盘内容也不含它们', async () => {
    const dir = home as string
    await writeSettings({ autoBackup: false, accessKey: ACCESS_KEY, secretKey: SECRET_KEY }, dir)
    const text = await readFile(settingsFilePath(dir), 'utf8')
    expect(text).not.toContain(ACCESS_KEY)
    expect(text).not.toContain(SECRET_KEY)
  })

  it('文件缺失时回退出厂值（不让坏配置阻断插件）', async () => {
    expect(await readSettings(home as string)).toEqual(DEFAULT_SETTINGS)
  })

  it('文件损坏时同样回退，而不是抛异常', async () => {
    const dir = home as string
    // 先落一份正常设置（顺带建出目录），再把它改坏。
    await writeSettings({ autoBackup: true }, dir)
    await writeFile(settingsFilePath(dir), '{ not json', 'utf8')
    expect(await readSettings(dir)).toEqual(DEFAULT_SETTINGS)
  })
})

describe('dshHome', () => {
  it('$DSH_HOME 优先', () => {
    expect(dshHome({ DSH_HOME: 'D:/custom-dsh' })).toBe('D:/custom-dsh')
  })

  it('空白视为未设置', () => {
    expect(dshHome({ DSH_HOME: '   ' })).toMatch(/\.dsh$/)
  })
})

describe('防回归：/state 必须报出完整设置（"小游戏开关关不掉"的根因）', () => {
  it('宿主是整体展开 settings，而不是手写字段白名单', async () => {
    // 背景：/state 原本是 `settings: { autoBackup, backupDir, prefix }` 三个字段的手写白名单。
    // 后来新增的设置项（skipCaches / provider / endpoint / bucket / region /
    // gameEnabled / gameDifficulty）都没往里补，于是：
    //   · 保存完全正常（确实写进了 config.json）
    //   · 但界面读回来永远是默认值 —— 关掉「备份前的小游戏」根本没有效果
    // 整体展开从结构上免疫这个问题（settings 本身已由 normalizeSettings 做过白名单）。
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).toContain('settings: { ...settings }')
    // 反向断言：不要出现逐字段抄写 autoBackup 的白名单写法。
    expect(source).not.toMatch(/settings:\s*\{\s*\n\s*autoBackup:\s*settings\.autoBackup/)
  })

  it('客户端对缺失字段的兜底不能让开关"锁死"在开的状态', () => {
    // 即便宿主漏报字段，界面也不该把它当成 false 才关 —— 这条锁定当前语义，
    // 万一以后改成 `=== true` 会让老配置全部失效，那时候必须有意识地改这里。
    expect(normalizeSettings({}).gameEnabled).toBe(true)
    expect(normalizeSettings({ gameEnabled: false }).gameEnabled).toBe(false)
  })
})
