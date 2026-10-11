/**
 * 密钥自检：扫描仓库里有没有明文凭证或泄漏的凭证值。
 *
 * 两条路子一起用：
 *   1. **形态扫描** —— 找"变量名 + 引号包起来的 16 位以上凭据串"和已知密钥前缀（AKIA/ASIA/LTAI 等）；
 *   2. **值扫描** —— 如果当前环境里已经设了 `RUSTFS_*` / `AWS_*` 凭证，
 *      逐个文件确认那些**实际值**没有出现在任何被扫描的文件里。
 *
 * 第 2 条是给使用者跑的自检：配好环境变量后执行 `pnpm run check:secrets`，
 * 就能确认自己的密钥没被插件或脚本写进任何文件。
 *
 * 退出码：0 干净；1 发现可疑内容。
 *
 * @module scripts/secret-scan
 */

import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 包根目录。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 扫描范围：**整个仓库**，用黑名单跳过依赖与构建产物。
 *
 * 早先用的是白名单（`src` / `scripts` / `tests` + 几个具名根文件），结果是
 * **根目录下新增的任何文件都不会被扫描** —— 有人把密钥写进根目录的 `config.ts`
 * 或 `deploy.sh` 就完全发现不了（实测：往根目录放一个含 AK 的文件，扫描照样 PASS）。
 * 黑名单才是正确的默认值：漏扫一个已知目录是可接受的，漏扫未知文件不可接受。
 */
const SCAN_ROOT = ROOT

/** 不进入的目录（依赖、构建产物、包管理器状态、语言缓存）。 */
const SKIP_DIRS = new Set([
  'node_modules',
  'lib',
  'dist',
  'build',
  'coverage',
  '.git',
  '.pnpm-store',
  '.npm-cache',
  '.cache',
  '.venv',
  '__pycache__',
])

/**
 * 确定**不扫**的二进制 / 资源扩展名。
 *
 * 这里用黑名单而不是白名单，理由是：漏扫一个已知二进制只是少看一张图，
 * 漏扫一个未知文本文件却可能是漏掉一把密钥。早先的白名单就漏掉了点文件
 * （`.npmrc`、`.gitignore`、`.env.example` —— `lastIndexOf('.')` 对它们会算出
 * `.npmrc` / `.example` 这类"假扩展名"），而 `.env.example` 恰恰是最该扫的文件之一。
 */
const BINARY_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.tif',
  '.tiff',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.tar',
  '.7z',
  '.rar',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.node',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.wav',
  '.map',
  '.db',
  '.sqlite',
])

/**
 * 取一个文件名用于匹配的"扩展名"。
 *
 * 点文件（`.npmrc`、`.gitignore`）没有扩展名，返回整个名字 —— 它不在
 * {@link BINARY_EXTENSIONS} 里，于是会被扫描；无后缀文件（`LICENSE`）返回空串，同样会被扫。
 *
 * @param name - 文件名。
 * @returns 小写扩展名；点文件返回整名；无点返回空串。
 */
function extensionOf(name) {
  const dot = name.lastIndexOf('.')
  if (dot === -1) return ''
  return (dot === 0 ? name : name.slice(dot)).toLowerCase()
}

/**
 * 公开的示例值白名单：这些是 AWS 文档里的经典样例与占位符，
 * 出现在测试里是正常的（它们不是有效凭证）。
 */
const ALLOWLIST = new Set([
  'AKIAIOSFODNN7EXAMPLE',
  'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  'AKIAIOSFODNN7EXAMPLE/20260101',
])

/** 被当作机密的环境变量名（三个 provider 全覆盖 —— 早先漏了 OSS_*）。 */
const SECRET_ENV_NAMES = [
  'RUSTFS_ACCESS_KEY',
  'RUSTFS_SECRET_KEY',
  'RUSTFS_SESSION_TOKEN',
  'OSS_ACCESS_KEY_ID',
  'OSS_ACCESS_KEY_SECRET',
  'OSS_SESSION_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
]

/**
 * 形态扫描规则。
 *
 * 第 1 条要求"引号包起来的密集串"，避免把 `accessKeyId: string` 这类类型写法算进来；
 * 第 2 条只认已知的密钥前缀。
 */
const PATTERNS = [
  {
    name: '硬编码凭证字面量',
    re: /(?:access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|secret[_-]?key|password|passwd|token)\s*[:=]\s*(['"])([A-Za-z0-9+/=_-]{16,})\1/gi,
    capture: 2,
  },
  {
    name: '已知密钥前缀',
    re: /(?<![A-Za-z0-9])(AKIA|ASIA|LTAI|AKLT)[A-Z0-9]{10,}/g,
    capture: 0,
  },
]

/** 一条命中。 */
class Hit {
  /**
   * @param file - 相对路径。
   * @param line - 行号。
   * @param rule - 规则名。
   * @param text - 命中片段（用于人工判断，不当机密）。
   */
  constructor(file, line, rule, text) {
    this.file = file
    this.line = line
    this.rule = rule
    this.text = text
  }

  /** @returns {string} 展示文本。 */
  format() {
    return `  ${this.file}:${this.line}  [${this.rule}]  ${this.text}`
  }
}

/**
 * 判断一个值是不是"变量名"而不是"值"（纯大写 + 下划线）。
 *
 * @param value - 捕获到的串。
 * @returns 是变量名则为 true。
 */
function looksLikeVariableName(value) {
  // 变量名一定带下划线（RUSTFS_ACCESS_KEY、OSS_ACCESS_KEY_ID）；
  // 而**纯大写字母数字**的串（AKIA 开头 + 16 位）恰恰是 AK 本身的形态，
  // 不能当成"变量名"放行 —— 早先的宽松写法会漏掉这类真凭证（实测踩过）。
  return /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value)
}

/**
 * 判断一个值是不是"占位符 / 示例值"。
 *
 * 测试与文档**必须**能写出假密钥（否则没法验证脱敏逻辑），它们不该被报成泄漏。
 * Gitleaks 那边靠 allowlist 放行几个具体的公开示例值，这里靠形态判断，覆盖更广：
 * `FAKE-SESSION-TOKEN-FOR-TEST`、`AKIAIOSFODNN7EXAMPLE`、`<你的子账号 AK>` 都算占位符。
 *
 * @param value - 捕获到的串。
 * @returns 是占位符则为 true。
 */
function looksLikePlaceholder(value) {
  return /(?:FAKE|EXAMPLE|PLACEHOLDER|YOUR_|CHANGEME|CHANGE_ME|DUMMY|SAMPLE|TEST|<|>)/i.test(value)
}

/**
 * 递归收集要扫描的文件。
 *
 * @param dir - 起始目录。
 * @param out - 收集数组。
 * @returns 收集数组。
 */
async function collect(dir, out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await collect(join(dir, entry.name), out)
      continue
    }
    if (!BINARY_EXTENSIONS.has(extensionOf(entry.name))) out.push(join(dir, entry.name))
  }
  return out
}

const targets = await collect(SCAN_ROOT)

/** 环境里实际存在的机密值（用于值扫描）。 */
const liveSecrets = SECRET_ENV_NAMES.map((name) => [name, process.env[name]]).filter(
  ([, value]) => typeof value === 'string' && value.length >= 8,
)

const hits = []

for (const file of targets) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    continue
  }
  const lines = text.split(/\r?\n/)
  const relativePath = relative(ROOT, file).replace(/\\/g, '/')

  lines.forEach((line, index) => {
    for (const pattern of PATTERNS) {
      pattern.re.lastIndex = 0
      for (const match of line.matchAll(pattern.re)) {
        const value = match[pattern.capture]
        if (value === undefined) continue
        if (ALLOWLIST.has(value)) continue
        if (pattern.capture !== 0 && looksLikeVariableName(value)) continue
        // 占位符 / 示例值不算泄漏：测试与文档必须能写出假密钥。
        if (looksLikePlaceholder(value)) continue
        hits.push(new Hit(relativePath, index + 1, pattern.name, match[0].trim()))
      }
    }
    // 值扫描：环境里的真实凭证不得出现在任何文件里。
    for (const [name, value] of liveSecrets) {
      if (line.includes(value)) {
        hits.push(new Hit(relativePath, index + 1, `环境变量 ${name} 的值出现在文件中`, '<redacted>'))
      }
    }
  })
}

process.stdout.write(`[secret-scan] 扫描 ${targets.length} 个文件\n`)
process.stdout.write(
  liveSecrets.length === 0
    ? '[secret-scan] 环境里没有检测到凭证变量，只做了形态扫描（想连值一起扫，请先设好 RUSTFS_*/AWS_*）\n'
    : `[secret-scan] 额外比对了 ${liveSecrets.length} 个环境凭证的值\n`,
)

if (hits.length === 0) {
  process.stdout.write('[secret-scan] PASS：没有发现明文凭证或泄漏的值\n')
  process.exit(0)
}

process.stdout.write(`[secret-scan] FAIL：发现 ${hits.length} 处可疑内容\n`)
for (const hit of hits) process.stdout.write(`${hit.format()}\n`)
process.exit(1)
