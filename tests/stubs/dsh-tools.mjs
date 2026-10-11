/**
 * 无宿主环境下的 `@deepseek-ai/dsh-tools` 桩（ESM 版）。
 *
 * 与 `tests/stubs/dsh-tools.ts` 同契约，区别只是给 Node 直接加载用：
 * 构建产物自检（scripts/load-check.mjs）要在没有 DSH 宿主的普通 node 里跑起来，
 * 而那个包只在宿主进程里存在。
 *
 * @module tests/stubs/dsh-tools.mjs
 */

/**
 * 原样返回传入的工具定义。
 *
 * @param {unknown} options - 工具定义。
 * @returns {unknown} 同一个对象。
 */
export function defineTool(options) {
  return options
}
