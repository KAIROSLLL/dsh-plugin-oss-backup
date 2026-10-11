/**
 * 给 `node --import` 用的注册入口：装上 stub-loader 钩子。
 *
 * 用法（package.json 的 check:load 已经这么写）：
 *     node --import ./scripts/register-stub.mjs scripts/load-check.mjs
 *
 * @module scripts/register-stub
 */

import { register } from 'node:module'

register('./stub-loader.mjs', import.meta.url)
