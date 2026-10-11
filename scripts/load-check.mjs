/**
 * 构建产物加载自检：用真实 `lib/index.js` 走一遍 cordis 加载路径。
 *
 * 与 tests/register.spec.ts 的区别：那个吃 `src/*.ts` 并 mock 掉 S3 SDK；
 * 这个吃**构建产物 + 真实 SDK**，专门证明"装到 profile 里能被 import 起来、
 * 导出符合约定、apply 能注册工具并打出加载日志"。
 *
 * 用法：`pnpm run build && pnpm run check:load`
 * 退出码：0 通过；1 失败。
 *
 * @module scripts/load-check
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 包根目录。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 观察到的加载结果。 */
const observed = { registered: [], logs: [], warns: [] }

const moduleUrl = pathToFileURL(resolve(ROOT, 'lib/index.js')).href
process.stdout.write(`[load-check] import ${moduleUrl}\n`)

const plugin = await import(moduleUrl)

process.stdout.write(`[load-check] name   = ${String(plugin.name)}\n`)
process.stdout.write(`[load-check] inject = ${JSON.stringify(plugin.inject)}\n`)

if (typeof plugin.apply !== 'function') {
  process.stdout.write('[load-check] FAIL：没有导出 apply 函数\n')
  process.exit(1)
}

// 一个最小的假 cordis 上下文：只提供插件真正用到的那几个成员。
const context = {
  logger: {
    info: (message) => observed.logs.push(String(message)),
    warn: (message) => observed.warns.push(String(message)),
    error: (message) => observed.warns.push(String(message)),
  },
  tools: {
    register: (definition) => {
      observed.registered.push(definition)
      return () => {}
    },
  },
  effect: (callback) => {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  get: (name) => (name === 'webServer' ? { register: () => () => {} } : undefined),
  // 事件监听：本插件会监听 tools/post-execute（自动备份），这里给一个能返回 disposer 的实现。
  on: () => () => {},
}

try {
  plugin.apply(context)
} catch (error) {
  process.stdout.write(`[load-check] FAIL：apply 抛出异常 —— ${String(error && error.message)}\n`)
  process.exit(1)
}

const tools = observed.registered.map((definition) => definition?.name)
process.stdout.write(`[load-check] 注册的工具 = ${JSON.stringify(tools)}\n`)
process.stdout.write('[load-check] 加载日志：\n')
for (const line of observed.logs) process.stdout.write(`  ${line}\n`)
for (const line of observed.warns) process.stdout.write(`  (warn) ${line}\n`)

const ok = tools.includes('oss_backup') && observed.logs.length > 0
process.stdout.write(ok ? '[load-check] PASS\n' : '[load-check] FAIL：工具未注册或没有加载日志\n')
process.exit(ok ? 0 : 1)
