/**
 * dsh-plugin-oss-backup —— 客户端半边（DSH Web 界面）。
 *
 * 以 `dsh.client` bundle 格式加载（本文件由 esbuild 打包成该格式，见 scripts/build-client.mjs）。
 * 注册三个席位：
 *   · 设置 → 对象存储备份：环境自检 + 用法说明 + 最近上传；
 *   · 左侧栏一栏：云上传图标 + 就绪状态短标签；
 *   · 主面板（key = oss-backup）：点侧栏那一栏进来的完整视图。
 *
 * 安全约定：这一半**只读**宿主脱敏后的 `/oss-backup/state`，
 * 不持有、也无法获取 AK/SK —— 浏览器沙箱里根本没有环境变量这个概念。
 *
 * @module dsh-plugin-oss-backup/client
 */

import * as React from 'react'
import { CSS, OssPanel, OssSidebarEntry } from './panel'

/** 插件名（必须与 npm 包名一致：client-modules 用最近归属的 package.json 判定浏览器模块 id）。 */
export const name = 'dsh-plugin-oss-backup'

/** 依赖客户端 slots 服务。 */
export const inject = ['slots']

/** 设置页/侧栏栏目/主面板共用的 id。 */
const PANEL_ID = 'oss-backup'

/** 设置页在导航里的名字。 */
const SECTION_LABEL = '对象存储备份'

/** 侧栏那一栏的文字。 */
const SIDEBAR_LABEL = '对象存储'

/** 客户端槽位注册面（只声明本插件用到的成员）。 */
interface SlotClient {
  /**
   * 等某个 slot 出现后再注册（slot 由别的插件提供，出现时机不确定）。
   *
   * @param key - slot 名。
   * @param callback - 注册回调，返回该次注入的清理函数。
   * @returns 取消注入的函数。
   */
  inject(key: string, callback: () => (() => void) | void): () => void
  /**
   * 往一个 slot 注册一个占位。
   *
   * @param definition - slot 名与 id/key/order/label。
   * @param renderer - 渲染函数；list slot 形如 `(ownerProps) => element`。
   * @returns 该占位的清理函数。
   */
  register(definition: Record<string, unknown>, renderer: (ownerProps: Record<string, unknown>) => unknown): () => void
}

/** 客户端上下文（本插件用到的子集）。 */
interface ClientContext {
  /** 槽位服务。 */
  readonly slots?: SlotClient
  /**
   * 注册随插件卸载自动清理的副作用。
   *
   * @param callback - 返回清理函数。
   * @param label - 标签。
   * @returns 精确的清理函数。
   */
  effect(callback: () => void | (() => void), label?: string): () => void
}

/**
 * 插件入口：注入样式并注册三个席位。
 *
 * @param ctx - 客户端 cordis 上下文。
 */
export function apply(ctx: ClientContext): void {
  const styleElement = document.createElement('style')
  styleElement.textContent = CSS
  document.head.appendChild(styleElement)
  ctx.effect(() => () => {
    styleElement.remove()
  }, 'oss-backup: 样式')

  const slots = ctx.slots
  if (slots === undefined) {
    // 没有 slots 服务时什么都不注册：静默失败好过抛异常把整个客户端带崩。
    return
  }

  slots.inject(
    'settings.section',
    () =>
      slots.register(
        { name: 'settings.section', id: PANEL_ID, order: 40, label: SECTION_LABEL },
        () => React.createElement(OssPanel, { variant: 'settings' }),
      ),
  )

  slots.inject(
    'sidebar.panellist',
    () =>
      slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: 12, label: () => SIDEBAR_LABEL },
        (ownerProps) =>
          React.createElement(OssSidebarEntry, {
            size: typeof ownerProps.size === 'number' ? ownerProps.size : undefined,
            active: ownerProps.active === true,
          }),
      ),
  )

  slots.inject(
    'main',
    () =>
      slots.register({ name: 'main', key: PANEL_ID }, () => React.createElement(OssPanel, { variant: 'panel' })),
  )
}
