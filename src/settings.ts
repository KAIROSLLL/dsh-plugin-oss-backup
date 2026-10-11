/**
 * 插件设置（Host 半边）。
 *
 * 存哪儿：`$DSH_HOME/oss-backup/config.json`（`DSH_HOME` 缺省是 `~/.dsh`）。
 *
 * ⚠️ **只存非机密**：自动备份开关、备份目录、对象键前缀。
 * AK/SK 永远只从环境变量读，**绝不进这个文件** —— 红线 3 是"密钥写入本地文件即失败"，
 * 所以 {@link normalizeSettings} 不仅不认凭证字段，还会把它们显式剔除；
 * 即便有人往请求体里塞 `accessKey`，也只会被丢掉。
 *
 * @module dsh-plugin-oss-backup/settings
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_BACKUP_PREFIX, normalizeBackupPrefix } from './auto-backup.js'

/**
 * 落盘设置的结构（**永远不含凭证**）。
 *
 * provider / endpoint / bucket / region 这四项是**非机密**的，所以可以持久化。
 * AK/SK 永远不会出现在这里 —— 它们只在设置页里输入一次，由宿主直接写进自己的
 * `process.env`（见 `src/index.ts` 的凭证路由），进程退出即消失。
 */
export interface PluginSettings {
  /** 自动备份开关；默认 `false`。 */
  readonly autoBackup: boolean
  /** 备份源目录（绝对路径；空串表示尚未设置）。 */
  readonly backupDir: string
  /** 对象键前缀（保证以 `/` 结尾）。 */
  readonly prefix: string
  /**
   * 是否跳过依赖 / 缓存目录（`node_modules`、`.git`、`__pycache__` 等）。
   *
   * 默认 `true`：这些目录要么体积极大（一开就撞限额），要么是可再生的产物。
   * 想让备份**一个文件都不少**时把它关掉。
   */
  readonly skipCaches: boolean
  /** provider（`rustfs` / `aliyun` / `aws`；空串表示"跟随环境变量"）。 */
  readonly provider: string
  /** 端点（空串表示"跟随环境变量 / provider 默认"）。 */
  readonly endpoint: string
  /** 存储桶（空串表示"跟随环境变量"）。 */
  readonly bucket: string
  /** 区域（空串表示"跟随环境变量 / provider 默认"）。 */
  readonly region: string
  /**
   * 点击「立即备份」时是否先玩一局小游戏（玩过才真的开始备份）。
   *
   * 默认 `true` —— 这是趣味功能，觉得碍事的人在设置里关掉即可（关掉后点按钮直接备份）。
   */
  readonly gameEnabled: boolean
  /** 小游戏难度（`zayu` / `easy` / `normal` / `hard`）。 */
  readonly gameDifficulty: string
}

/** 出厂设置。 */
export const DEFAULT_SETTINGS: PluginSettings = {
  autoBackup: false,
  backupDir: '',
  prefix: DEFAULT_BACKUP_PREFIX,
  skipCaches: true,
  provider: '',
  endpoint: '',
  bucket: '',
  region: '',
  gameEnabled: true,
  gameDifficulty: 'easy',
}

/** 存放设置的目录名（挂在 DSH home 下）。 */
export const SETTINGS_DIR = 'oss-backup'

/** 设置文件名。 */
export const SETTINGS_FILE = 'config.json'

/**
 * 解析 DSH home（与内核 `dshHomePath()` 同优先级：`$DSH_HOME` 优先，否则 `~/.dsh`）。
 *
 * @param env - 环境变量表。
 * @returns 绝对路径。
 */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(homedir(), '.dsh')
}

/**
 * 设置文件的绝对路径。
 *
 * @param home - DSH home。
 * @returns 配置文件路径。
 */
export function settingsFilePath(home: string = dshHome()): string {
  return join(home, SETTINGS_DIR, SETTINGS_FILE)
}

/**
 * 收窄一份外部输入成设置。
 *
 * 只读取下面这**八个已知键**，其余（**尤其是任何凭证字段**）一律忽略 —— 这样
 * "界面传来的东西"无论夹带什么，都不可能落到磁盘上。界面上那几个密钥输入框走的是
 * 另一条路由（`POST /oss-backup/credentials`），其值由那条路由取用后**立刻写进
 * `process.env`**，从不进入这里、也从不进入任何返回值。
 *
 * @param input - 外部输入（请求体或文件内容）。
 * @param base - 缺省值来源。
 * @returns 完整设置。
 */
export function normalizeSettings(input: unknown, base: PluginSettings = DEFAULT_SETTINGS): PluginSettings {
  if (input === null || typeof input !== 'object') return base
  const record = input as Record<string, unknown>

  const autoBackup =
    typeof record.autoBackup === 'boolean'
      ? record.autoBackup
      : typeof record.autoBackupEnabled === 'boolean'
        ? record.autoBackupEnabled
        : base.autoBackup

  const backupDir =
    typeof record.backupDir === 'string' ? record.backupDir.trim() : base.backupDir

  const prefix =
    typeof record.prefix === 'string' ? normalizeBackupPrefix(record.prefix) : base.prefix

  const skipCaches = typeof record.skipCaches === 'boolean' ? record.skipCaches : base.skipCaches

  const provider = typeof record.provider === 'string' ? record.provider.trim().toLowerCase() : base.provider
  const endpoint = typeof record.endpoint === 'string' ? record.endpoint.trim() : base.endpoint
  const bucket = typeof record.bucket === 'string' ? record.bucket.trim() : base.bucket
  const region = typeof record.region === 'string' ? record.region.trim() : base.region

  const gameEnabled = typeof record.gameEnabled === 'boolean' ? record.gameEnabled : base.gameEnabled
  const gameDifficulty =
    typeof record.gameDifficulty === 'string' ? record.gameDifficulty.trim().toLowerCase() : base.gameDifficulty

  return {
    autoBackup,
    backupDir,
    prefix,
    skipCaches,
    provider,
    endpoint,
    bucket,
    region,
    gameEnabled,
    gameDifficulty,
  }
}

/**
 * 读设置；文件缺失或损坏时回退出厂值（**绝不让坏配置阻断插件**）。
 *
 * @param home - DSH home。
 * @returns 设置。
 */
export async function readSettings(home: string = dshHome()): Promise<PluginSettings> {
  try {
    const text = await readFile(settingsFilePath(home), 'utf8')
    return normalizeSettings(JSON.parse(text), DEFAULT_SETTINGS)
  } catch {
    return DEFAULT_SETTINGS
  }
}

/**
 * 写设置（会自动建目录；只写出这三个非机密字段）。
 *
 * @param settings - 待写入的设置（内部仍会过一遍收窄）。
 * @param home - DSH home。
 * @returns 实际落盘的设置。
 */
export async function writeSettings(
  settings: unknown,
  home: string = dshHome(),
): Promise<PluginSettings> {
  const safe = normalizeSettings(settings, DEFAULT_SETTINGS)
  const file = settingsFilePath(home)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(safe, null, 2)}\n`, 'utf8')
  return safe
}
