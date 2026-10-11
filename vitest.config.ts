import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      {
        // 宿主在运行时提供 @deepseek-ai/dsh-tools，npm 上装不下来（依赖未发布的私有包）。
        // 单测把它替换成同契约的桩：defineTool 原样返回定义，好让 register 断言拿到真实结构。
        find: /^@deepseek-ai\/dsh-tools$/,
        replacement: fileURLToPath(new URL('./tests/stubs/dsh-tools.ts', import.meta.url)),
      },
      {
        // 源码走 NodeNext，相对导入写成 `./env.js`（编译产物才是真身）；
        // 测试直接吃 src/*.ts，所以在这里把 `.js` 后缀摘掉再交给 vite 解析。
        find: /^(\.{1,2}\/.*)\.js$/,
        replacement: '$1',
      },
    ],
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    restoreMocks: true,
  },
})
