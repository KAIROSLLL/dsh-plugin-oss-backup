/**
 * 凭证持久化（**可选、默认关闭**）。
 *
 * 设计立场：这是个要**开源发布**的插件，所以默认行为必须是最保守的那个 ——
 * 凭证只在宿主进程内存里（见 `index.ts` 的凭证路由），**零文件写入**。
 * 只有当用户显式设置 `OSS_CREDENTIAL_STORE=os` 时，才会用**操作系统提供的**
 * 加密存储落一份密文。
 *
 * 为什么用 OS 密钥库，而不是"自己加密一下"：
 *   · 自己加密就得自己保管主密钥，而"主密钥放哪"和"凭证放哪"是同一个问题，绕回原点；
 *   · DPAPI 的密钥由 Windows 用**当前登录用户**的凭据派生，别的账户、别的机器都解不开；
 *   · 这正是 Chrome / Edge 保存密码的做法，属于业界标准。
 *
 * 平台支持：目前只实现 Windows DPAPI。macOS / Linux 上 `createCredentialStore()`
 * 返回 `null`，插件自动回落到"仅本次会话"（不落盘）—— 与其用一个半吊子后端，
 * 不如明确不支持。加后端只需实现 {@link CredentialStore} 接口。
 *
 * @module dsh-plugin-oss-backup/credential-store
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SETTINGS_DIR } from './settings.js'

/** 控制是否启用 OS 密钥库的环境变量名。 */
export const CREDENTIAL_STORE_ENV = 'OSS_CREDENTIAL_STORE'

/** 唯一会开启持久化的取值（别的值一律视为关闭）。 */
export const CREDENTIAL_STORE_OS = 'os'

/** 密文文件名（与 `config.json` 同目录）。 */
export const CREDENTIAL_FILE = 'credentials.enc'

/** 一份凭证（只在宿主内存与本模块之间流转）。 */
export interface StoredCredentials {
  /** 访问密钥 ID。 */
  readonly accessKeyId: string
  /** 访问密钥密码。 */
  readonly secretAccessKey: string
}

/** 一个持久化后端。 */
export interface CredentialStore {
  /** 后端标识（进日志用，不含机密）。 */
  readonly kind: string
  /** 面向人的说明。 */
  readonly label: string
  /**
   * 读取凭证。
   *
   * @returns 凭证；没有或解不开时返回 `null`（并清掉坏文件）。
   */
  load(): Promise<StoredCredentials | null>
  /**
   * 保存凭证（密文）。
   *
   * @param credentials - 要保存的凭证。
   */
  save(credentials: StoredCredentials): Promise<void>
  /** 删除已保存的凭证。 */
  clear(): Promise<void>
}

/**
 * 跑一个子进程：从 stdin 喂入、从 stdout 取回。
 *
 * 单独抽出来是为了能在测试里替换（DPAPI 本身没法在 CI 上跑）。
 */
export type Runner = (command: string, args: readonly string[], stdin: string) => Promise<string>

/** 默认的子进程实现。 */
const runProcess: Runner = (command, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      command,
      [...args],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null && error !== undefined) {
          reject(error)
          return
        }
        resolve(String(stdout))
      },
    )
    child.stdin?.end(stdin)
  })

/**
 * DPAPI 加密脚本。
 *
 * 明文**从 stdin 进、密文从 stdout 出** —— 不走 argv（argv 在进程列表里可见）
 * 也不走环境变量（可能被子进程或被同用户的其他进程看到）。
 */
const DPAPI_PROTECT = [
  // Windows PowerShell 5.1 **不会**自动加载 System.Security，必须显式 Add-Type，
  // 否则报「找不到类型 [Security.Cryptography.ProtectedData]」（真机验证时踩到，
  // 单元测试用假 runner 是发现不了的）。
  'Add-Type -AssemblyName System.Security',
  '$plain = [Console]::In.ReadToEnd()',
  '$bytes = [Text.Encoding]::UTF8.GetBytes($plain)',
  "$enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')",
  '[Console]::Out.Write([Convert]::ToBase64String($enc))',
].join('; ')

/** DPAPI 解密脚本（同样只走管道）。 */
const DPAPI_UNPROTECT = [
  'Add-Type -AssemblyName System.Security',
  '$b64 = [Console]::In.ReadToEnd()',
  '$bytes = [Convert]::FromBase64String($b64)',
  "$dec = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')",
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($dec))',
].join('; ')

/** PowerShell 的调用参数（关掉 profile，避免用户脚本干扰）。 */
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-Command'] as const

/**
 * 造一个 Windows DPAPI 后端。
 *
 * @param home - DSH home。
 * @param run - 子进程实现。
 * @returns 后端。
 */
function createDpapiStore(home: string, run: Runner): CredentialStore {
  const file = join(home, SETTINGS_DIR, CREDENTIAL_FILE)

  const clear = async (): Promise<void> => {
    await rm(file, { force: true })
  }

  return {
    kind: 'dpapi',
    label: 'Windows DPAPI（密文绑定当前 Windows 账户）',
    async load() {
      let raw: string
      try {
        raw = await readFile(file, 'utf8')
      } catch {
        // 文件不存在就是"还没保存过"，不是错误。
        return null
      }
      try {
        const wrapper = JSON.parse(raw) as { v?: unknown; data?: unknown }
        if (wrapper.v !== 1 || typeof wrapper.data !== 'string') throw new Error('bad envelope')
        const plain = await run('powershell.exe', [...PS_ARGS, DPAPI_UNPROTECT], wrapper.data)
        const parsed = JSON.parse(plain) as Partial<StoredCredentials>
        if (typeof parsed.accessKeyId !== 'string' || typeof parsed.secretAccessKey !== 'string') {
          throw new Error('bad payload')
        }
        return { accessKeyId: parsed.accessKeyId, secretAccessKey: parsed.secretAccessKey }
      } catch {
        // 解不开通常意味着"换了机器或换了 Windows 账户"：清掉坏文件，让用户重填，
        // 而不是每次启动都失败一次。
        await clear()
        return null
      }
    },
    async save(credentials) {
      const plain = JSON.stringify(credentials)
      const cipher = (await run('powershell.exe', [...PS_ARGS, DPAPI_PROTECT], plain)).trim()
      if (cipher === '') throw new Error('DPAPI 返回了空密文')
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify({ v: 1, kind: 'dpapi', data: cipher }), {
        encoding: 'utf8',
        mode: 0o600,
      })
    },
    clear,
  }
}

/**
 * 判断用户是否显式开启了凭证持久化。
 *
 * 只有字面量 `os` 才算开启 —— 别的值（含 `1` / `true`）一律视为关闭，
 * 避免"随手设了个 true 就把密钥写到磁盘上"。
 *
 * @param env - 环境变量表。
 * @returns 是否开启。
 */
export function isCredentialStoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[CREDENTIAL_STORE_ENV]
  return typeof value === 'string' && value.trim().toLowerCase() === CREDENTIAL_STORE_OS
}

/**
 * 造一个凭证后端；当前平台不支持时返回 `null`（调用方回落到"仅本次会话"）。
 *
 * @param home - DSH home。
 * @param options - 平台与子进程实现（测试可注入）。
 * @returns 后端或 `null`。
 */
export function createCredentialStore(
  home: string,
  options: { platform?: string; runner?: Runner } = {},
): CredentialStore | null {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return null
  return createDpapiStore(home, options.runner ?? runProcess)
}
