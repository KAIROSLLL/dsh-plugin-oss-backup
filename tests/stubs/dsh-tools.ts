/**
 * `@deepseek-ai/dsh-tools` 的测试桩。
 *
 * 真实实现在宿主进程里，装不到 node_modules（见 vitest.config.ts 的 alias 说明）。
 * 这里只保证单测关心的那件事：`defineTool(options)` 返回 options 本身，
 * 于是测试可以拿到注册进去的定义，直接检查 name/parameters/output/execute。
 *
 * @module tests/stubs/dsh-tools
 */

/**
 * 原样返回传入的工具定义。
 *
 * @param options - 工具定义。
 * @returns 同一个对象。
 */
export function defineTool(options) {
  return options
}
