/**
 * Node ESM 解析钩子：把 `@deepseek-ai/dsh-tools` 指向本地桩。
 *
 * 只有"没有宿主"的自检脚本会用到它（scripts/load-check.mjs）。
 * 正常运行时这个 specifier 由 DSH 宿主提供，绝不走这里。
 *
 * ⚠️ 注意别 import `node:path` 的 `resolve`：钩子导出的函数名就叫 `resolve`，
 * 同名会直接 SyntaxError（踩过）。
 *
 * @module scripts/stub-loader
 */

import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 桩模块的绝对 URL。 */
const STUB_URL = pathToFileURL(
  resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'stubs', 'dsh-tools.mjs'),
).href

/**
 * 把宿主提供的那个包解析到本地桩。
 *
 * @param {string} specifier - 被 import 的说明符。
 * @param {unknown} context - 解析上下文。
 * @param {(specifier: string, context: unknown) => Promise<unknown>} nextResolve - 默认解析器。
 * @returns {Promise<unknown>} 解析结果。
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    return { url: STUB_URL, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
