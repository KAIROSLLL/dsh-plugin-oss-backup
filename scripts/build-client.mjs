/**
 * 把 src/client/*.tsx 打包成 DSH 认的 client bundle（lib/client.js）。
 *
 * 目标格式（与在役插件 dsh-meme / dsh-users-open-source 同款）：
 *
 *     window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { ... } })
 *
 * 两个不能猜错的点：
 *   1. `id` 必须是**包名**。client-modules 按"最近归属的 package.json"判定浏览器模块 id，
 *      写成别的东西会报 `loaded without registering <包名>`，这一半就静默失效；
 *   2. React 必须 external。宿主已经提供 `require('react')`，打进来会有两份 React 实例
 *      （hooks 立刻炸）。也因此这里用 classic JSX（React.createElement），
 *      避免额外要求宿主提供 `react/jsx-runtime`。
 *
 * 用 esbuild 的 banner/footer 包壳（而不是自己拼字符串），sourcemap 的行号才不会错位。
 *
 * @module scripts/build-client
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/** 本文件所在目录。 */
const HERE = dirname(fileURLToPath(import.meta.url))
/** 包根目录。 */
const ROOT = resolve(HERE, '..')

/** 浏览器模块 id —— 必须等于 package.json 的 name。 */
const PACKAGE_NAME = 'dsh-plugin-oss-backup'

const banner = [
  '/**',
  ' * 生成文件 —— 由 scripts/build-client.mjs 从 src/client/*.tsx 打包而来。',
  ' * 改界面请改源文件后跑 `pnpm run build:client`，不要手改本文件。',
  ' *',
  ` * 模块 id 固定为包名 ${PACKAGE_NAME}：client-modules 按最近归属的 package.json 判定 id。`,
  ' */',
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(PACKAGE_NAME)},`,
  '  factory: (require) => {',
  '    var module = { exports: {} }',
  '    var exports = module.exports',
].join('\n')

const footer = ['    return module.exports', '  },', '})', ''].join('\n')

const result = await build({
  entryPoints: [resolve(ROOT, 'src/client/index.tsx')],
  // 指定 outfile：esbuild 才会产出**外部** .map 文件（没有 outfile 时它把 map 内联进 js，
  // 白白让每个浏览器多下 60KB base64）。
  outfile: resolve(ROOT, 'lib/client.js'),
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['es2020'],
  // classic JSX：只依赖宿主提供的 require('react')，不额外要 react/jsx-runtime。
  jsx: 'transform',
  external: ['react'],
  legalComments: 'none',
  sourcemap: true,
  banner: { js: banner },
  footer: { js: footer },
  logLevel: 'warning',
})

/** esbuild 在 write:false 下的产物路径由它自己决定（与 entry 相关），所以按后缀挑。 */
const jsFile = result.outputFiles.find((file) => !file.path.endsWith('.map'))
const mapFile = result.outputFiles.find((file) => file.path.endsWith('.map'))

const jsPath = resolve(ROOT, 'lib/client.js')
const mapPath = `${jsPath}.map`

if (jsFile === undefined) {
  throw new Error(
    `esbuild 没有产出 js 产物，实际输出：${result.outputFiles.map((file) => file.path).join(', ') || '(空)'}`,
  )
}

await mkdir(resolve(ROOT, 'lib'), { recursive: true })
await writeFile(jsPath, jsFile.text, 'utf8')
if (mapFile !== undefined) await writeFile(mapPath, mapFile.text, 'utf8')

process.stdout.write(
  `[build-client] 已写出 lib/client.js（${Buffer.byteLength(jsFile.text, 'utf8')} 字节${
    mapFile === undefined ? '' : ' + sourcemap'
  }）\n`,
)
