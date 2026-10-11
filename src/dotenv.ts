/**
 * `.env` 文件加载（Host 半边）。
 *
 * `process.env` 只关心一件事：**某个键在进程环境里存不存在**，不关心它从哪来。
 * 所以插件只要把 `.env` 里的键值对补进 `process.env`，后面所有 provider 解析、
 * 凭证读取、派生配置的逻辑都照常工作 —— 不必为"文件来源"单开一条代码路径。
 *
 * 于是这几种配置方式**完全等价**：
 *   · 手动 `export` / `setx` 后启动；
 *   · 写在 `.env` 里，由本模块补读；
 *   · 系统环境变量、Docker `-e`、CI Secret。
 *
 * 几条刻意定下的约束：
 *   · **只读，永不写入** —— 插件绝不修改、绝不生成 `.env`；密钥是否落盘完全由用户决定，
 *     这与"插件自己不把凭证写到文件里"那条红线并不冲突；
 *   · **不覆盖已有值** —— 进程里已经有的优先（与系统环境补读的规则保持一致）；
 *   · **不回显值** —— 日志与界面只列**变量名**；
 *   · **零依赖** —— 自己解析，不引入 `dotenv` 之类的包。解析规则就那几条，
 *     可控比省事重要（多一个依赖就多一份供应链面）。
 *
 * @module dsh-plugin-oss-backup/dotenv
 */

/** 一次 `.env` 加载的结果。 */
export interface DotenvLoadResult {
  /** 实际读取的文件路径；候选全都不存在时为 `null`。 */
  readonly path: string | null
  /** 实际注入的变量名（**只有名字，没有值**）。 */
  readonly loaded: readonly string[]
  /** 因"进程里已经有值"而跳过的变量名（只在 `override: false` 时可能非空）。 */
  readonly skipped: readonly string[]
  /** 被 `.env` **覆盖掉**的变量名（只在 `override: true` 时可能非空）。 */
  readonly overridden: readonly string[]
  /** 读取或解析失败的原因（**已脱敏**）；正常为 `null`。 */
  readonly error: string | null
}

/** 一个什么都没发生的空结果。 */
function emptyResult(path: string | null, error: string | null = null): DotenvLoadResult {
  return { path, loaded: [], skipped: [], overridden: [], error }
}

/** 加载选项。 */
export interface DotenvLoadOptions {
  /**
   * 是否允许 `.env` **覆盖进程里已有的值**，默认 `true`。
   *
   * 默认开启是有意的：`.env` 是用户**显式写下来**的配置，应当比外部环境更权威。
   * 否则你在 `.env` 里改了密钥，却因为 shell 里还留着一个旧的 `export` 而毫无效果 ——
   * "改了没反应"是最难查的一类问题。被覆盖的键名会记进
   * {@link DotenvLoadResult.overridden}，日志里会列出来。
   */
  readonly override?: boolean
}

/**
 * 解析 `.env` 文本。
 *
 * 支持的写法（够用且不产生歧义）：
 *
 * ```dotenv
 * KEY=value
 * KEY="value"
 * KEY='value'
 * export KEY=value     # 顺手容忍 shell 风格
 * # 注释、空行
 * ```
 *
 * 刻意**不做**这几件事：行内注释（`KEY=a#b` 里的 `#` 算值的一部分）、多行值、
 * 变量展开（`$OTHER`）。它们在真实 `.env` 里很少见，而支持它们只会让"值被悄悄改掉"
 * 成为可能的解释 —— 出问题时最难查的就是这种。
 *
 * @param text - 文件内容。
 * @returns 键值对（按出现顺序；重复键后者覆盖前者）。
 */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue

    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const eq = withoutExport.indexOf('=')
    if (eq <= 0) continue

    const key = withoutExport.slice(0, eq).trim()
    // 键名必须像环境变量：否则多半是写错了（比如误写成 JSON 或 YAML）。
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue

    let value = withoutExport.slice(eq + 1).trim()
    // 只有**成对**的引号才剥掉；单边引号原样保留（那说明它本来就是值的一部分）。
    if (value.length >= 2) {
      const first = value[0]
      const last = value[value.length - 1]
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1)
      }
    }
    out.set(key, value)
  }
  return out
}

/**
 * 读取一个 `.env` 文件并把键值补进环境变量表。
 *
 * 默认**覆盖**已有值（见 {@link DotenvLoadOptions.override}）：本插件的配置优先级是
 * **`.env` > 系统环境变量** —— `.env` 是你显式写在项目/配置目录里的那一份，
 * 应当比机器上残留的 export 更权威。传 `override: false` 可恢复 dotenv 的通行语义。
 *
 * 文件不存在不算错误（返回 `path: null` 的空结果）。
 *
 * @param path - 文件路径。
 * @param env - 目标环境变量表，默认 `process.env`。
 * @param readFileImpl - 读文件实现（测试注入用），默认 `node:fs/promises`。
 * @param options - 加载选项。
 * @returns 加载结果（**只含变量名，不含值**）。
 */
export async function loadDotenvFile(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  readFileImpl?: (path: string) => Promise<string>,
  options: DotenvLoadOptions = {},
): Promise<DotenvLoadResult> {
  const override = options.override ?? true
  const read = readFileImpl ?? (async (target: string) => (await import('node:fs/promises')).readFile(target, 'utf8'))
  let text: string
  try {
    text = await read(path)
  } catch (error) {
    const code = (error as { code?: string } | null)?.code
    // 文件不存在是**正常情况**（用户没建 .env 而已），不当作错误上报。
    if (code === 'ENOENT') return emptyResult(null)
    return emptyResult(path, `读取 .env 失败：${describeError(error)}`)
  }

  const pairs = parseDotenv(text)
  const loaded: string[] = []
  const skipped: string[] = []
  const overridden: string[] = []
  for (const [key, value] of pairs) {
    const existing = env[key]
    const hasExisting = typeof existing === 'string' && existing.trim() !== ''
    if (hasExisting) {
      if (!override) {
        skipped.push(key)
        continue
      }
      // 只记录"值确实不同"的覆盖：同值时提它只会让日志变吵。
      if (existing.trim() !== value.trim()) overridden.push(key)
    }
    env[key] = value
    loaded.push(key)
  }
  return { path, loaded, skipped, overridden, error: null }
}

/**
 * 按候选顺序尝试加载**第一个存在**的 `.env`。
 *
 * 找到第一个能读到的文件就停 —— 不做"多层合并"，那样出问题时没法解释某个值究竟来自哪份文件。
 *
 * @param candidates - 候选路径（按优先级从高到低）。
 * @param env - 目标环境变量表，默认 `process.env`。
 * @param readFileImpl - 读文件实现（测试注入用）。
 * @param options - 加载选项（是否允许覆盖已有值）。
 * @returns 加载结果。
 */
export async function loadDotenv(
  candidates: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  readFileImpl?: (path: string) => Promise<string>,
  options: DotenvLoadOptions = {},
): Promise<DotenvLoadResult> {
  let lastError: string | null = null
  for (const path of candidates) {
    const result = await loadDotenvFile(path, env, readFileImpl, options)
    if (result.path !== null && result.error === null) return result
    if (result.error !== null) lastError = result.error
  }
  return emptyResult(null, lastError)
}

/**
 * 从错误对象里取一段**不含凭证**的描述。
 *
 * 刻意不走 `safeErrorMessage`：这里只关心 errno 级别的信息（ENOENT / EACCES），
 * 自己判一下比引入整条脱敏链更清楚。
 *
 * @param error - 捕获到的错误。
 * @returns 简短描述。
 */
function describeError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code
  if (typeof code === 'string' && code !== '') return code
  const name = (error as { name?: string } | null)?.name
  return typeof name === 'string' && name !== '' ? name : 'unknown error'
}
