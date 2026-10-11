/**
 * 从操作系统层面补读环境变量（目前仅 Windows）。
 *
 * **为什么需要它**：`setx` 写的是**用户级**环境变量（注册表 `HKCU\Environment`），
 * 而已经启动的进程、或从快捷方式 / 启动器 / 服务拉起来的 `dsh web`，**不一定继承到它**。
 * 实测就撞上了这个：用户明明 `setx` 过 `RUSTFS_ACCESS_KEY`，插件的环境自检却显示「未配置」，
 * 于是只能每次在设置页重填 —— 这显然不是"配一次就好"的样子。
 *
 * 读取优先级（**先到先用，绝不覆盖已有值**）：
 *   1. `process.env` —— 进程已经继承到的（优先级最高）
 *   2. 用户级（`HKCU\Environment`）—— 即 `setx` 的落点
 *   3. 系统级（`HKLM\…\Environment`）
 *
 * 安全边界没有变化：这里只是**读取本机已有的配置**，不写任何文件、不派生新副本；
 * 读进来的值与从环境继承来的值走同一条路径（`readOssConfig()`），日志里同样只出现变量名。
 *
 * 跨平台说明：macOS / Linux 没有等价的"用户级环境变量"存储 —— `~/.bashrc` 里的变量
 * 只对交互式 shell 生效，无法可靠地从一个已启动的进程里查到，所以这两个平台上
 * `createEnvironmentSource()` 返回 `null`，插件行为与从前完全一致（靠进程继承）。
 *
 * @module dsh-plugin-oss-backup/env-source
 */

import { execFile } from 'node:child_process'
import { CREDENTIAL_STORE_ENV } from './credential-store.js'
import { PROFILES, PROVIDER_ENV } from './env.js'

/**
 * 跑一个子进程：从 stdin 喂入、从 stdout 取回。
 *
 * 形状与 `credential-store` 里的同名类型一致，但两者职责无关，所以刻意不互相依赖。
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
 * PowerShell 读取脚本。
 *
 * 变量名用**逗号**分隔从 stdin 进（`-split "\n"` 在 PowerShell 里不吃 `\n` 转义，用逗号最稳）；
 * 值以 JSON 从 stdout 出。用户级优先于系统级，空值忽略。
 */
const PS_READ = [
  '$raw = [Console]::In.ReadToEnd()',
  '$names = $raw -split "," | Where-Object { $_ -ne "" }',
  '$out = [ordered]@{}',
  'foreach ($n in $names) {',
  "  $user = [Environment]::GetEnvironmentVariable($n, 'User')",
  "  $machine = [Environment]::GetEnvironmentVariable($n, 'Machine')",
  '  if (-not [string]::IsNullOrEmpty($user)) { $out[$n] = $user }',
  '  elseif (-not [string]::IsNullOrEmpty($machine)) { $out[$n] = $machine }',
  '}',
  '[Console]::Out.Write(($out | ConvertTo-Json -Compress))',
].join('; ')

/** 一个"能补读系统环境变量"的来源。 */
export interface EnvironmentSource {
  /**
   * 读取指定的变量。
   *
   * @param names - 变量名。
   * @returns 变量名到值的映射（读不到的项不出现）。
   */
  read(names: readonly string[]): Promise<Record<string, string>>
}

/**
 * 需要尝试补读的变量名全集：三个 provider 的连接信息与凭证 + 两个开关，一次读齐。
 *
 * @returns 变量名数组。
 */
export function environmentVariableNames(): string[] {
  const names = new Set<string>([PROVIDER_ENV, CREDENTIAL_STORE_ENV])
  for (const profile of Object.values(PROFILES)) {
    for (const name of Object.values(profile.env)) names.add(name)
  }
  return [...names]
}

/**
 * 造一个系统环境变量来源；当前平台不支持时返回 `null`。
 *
 * @param options - 平台与子进程实现（测试可注入）。
 * @returns 来源或 `null`。
 */
export function createEnvironmentSource(
  options: { platform?: string; runner?: Runner } = {},
): EnvironmentSource | null {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return null
  const run = options.runner ?? runProcess

  return {
    async read(names) {
      if (names.length === 0) return {}
      const raw = await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', PS_READ],
        names.join(','),
      )
      const text = raw.trim()
      // 一个都没读到（或全为空）时 PowerShell 输出空串，而不是 `{}`。
      if (text === '') return {}
      const parsed = JSON.parse(text) as Record<string, unknown>
      const out: Record<string, string> = {}
      for (const [name, value] of Object.entries(parsed)) {
        if (typeof value === 'string' && value !== '') out[name] = value
      }
      return out
    },
  }
}

/**
 * 把系统里能读到、但当前进程**没有**的变量补进 `process.env`。
 *
 * 不覆盖已有值 —— 进程继承到的配置优先级最高（例如你在某个 shell 里临时 `export` 的）。
 * 任何失败都静默降级（返回空数组）：补读只是便利，绝不能让插件加载不了。
 *
 * @param names - 要尝试的变量名。
 * @param source - 读取实现；传 `null` 表示当前平台不支持。
 * @returns 实际补齐的变量名（**只有名字**）。
 */
export async function hydrateEnvironment(
  names: readonly string[] = environmentVariableNames(),
  source: EnvironmentSource | null = createEnvironmentSource(),
): Promise<string[]> {
  if (source === null) return []
  let found: Record<string, string>
  try {
    found = await source.read(names)
  } catch {
    return []
  }

  const added: string[] = []
  for (const [name, value] of Object.entries(found)) {
    if (typeof value !== 'string' || value === '') continue
    const existing = process.env[name]
    if (typeof existing === 'string' && existing.trim() !== '') continue
    process.env[name] = value
    added.push(name)
  }
  return added
}
