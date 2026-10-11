/**
 * 插件运行时上下文的最小结构声明。
 *
 * 不 `import type { Context } from '@deepseek-ai/cordis'` 的原因与
 * `src/types/dsh-tools.d.ts` 相同：cordis 由宿主在运行时提供。
 * 这里只声明本插件真正碰到的四个成员，宿主传进来的对象天然满足。
 *
 * @module dsh-plugin-oss-backup/context
 */

/** 宿主日志器。 */
export interface PluginLogger {
  /**
   * 记一条信息级日志。
   *
   * @param message - 文本。
   * @param rest - 附加参数。
   */
  info(message: string, ...rest: unknown[]): void
  /**
   * 记一条告警。
   *
   * @param message - 文本。
   * @param rest - 附加参数。
   */
  warn(message: string, ...rest: unknown[]): void
  /**
   * 记一条错误。
   *
   * @param message - 文本。
   * @param rest - 附加参数。
   */
  error(message: string, ...rest: unknown[]): void
}

/** 工具注册表（只用到 register）。 */
export interface ToolRuntimeLike {
  /**
   * 注册一个工具定义。
   *
   * @param definition - `defineTool()` 的产物。
   * @returns 注销该工具的精确 disposer。
   */
  register(definition: unknown): () => void
}

/** 由宿主提供的插件上下文（本插件用到的子集）。 */
export interface PluginContext {
  /** 日志器。 */
  readonly logger: PluginLogger
  /** 工具注册表——`inject = ['tools']` 保证其存在。 */
  readonly tools: ToolRuntimeLike
  /**
   * 注册一个随插件卸载自动清理的副作用。
   *
   * @param callback - 返回 disposer 的函数。
   * @param label - 便于排查的标签。
   * @returns 精确的清理函数。
   */
  effect(callback: () => void | (() => void), label?: string): () => void
  /**
   * 读取一个可选服务（软依赖，取不到返回 undefined）。
   *
   * @param name - 服务名。
   * @returns 服务实例或 undefined。
   */
  get(name: string): unknown
  /**
   * 监听一个 Cordis 事件。
   *
   * waterfall 事件（本插件用的 `tools/post-execute`）的监听器**必须把 `next()` 的结果返回回去**，
   * 否则会截断后续监听器看到的决策。
   *
   * @param name - 事件名。
   * @param listener - 监听器。
   * @returns 注销该监听的 disposer。
   */
  on(
    name: 'tools/post-execute',
    listener: (
      execution: ToolExecutionLike,
      result: ToolExecutionOutcomeLike,
      next: () => Promise<unknown>,
    ) => Promise<unknown>,
  ): () => void
}

/** 一次已归一化的工具调用（本插件用到的子集）。 */
export interface ToolExecutionLike {
  /** 工具名：自动备份只关心 `write` / `edit`。 */
  readonly name: string
  /** 已校验的调用参数（`write` / `edit` 的路径在 `file_path`）。 */
  readonly arguments: unknown
}

/** 工具执行结果中本插件关心的部分。 */
export interface ToolExecutionOutcomeLike {
  /** 调用是否以失败结束。 */
  readonly isError: boolean
}

/** 浏览器 HTTP 载体服务（`webServer`）中本插件用到的子集。 */
export interface WebServerLike {
  /**
   * 注册一条精确路径路由。
   *
   * @param route - 路由声明。
   * @returns 注销该路由的 disposer。
   */
  register(route: {
    /** 匹配方式。 */
    readonly kind: 'exact'
    /** 路径。 */
    readonly path: string
    /**
     * 处理函数。
     *
     * @param request - 请求。
     * @param response - 响应。
     */
    handler(request: WebRequestLike, response: WebResponseLike): void | Promise<void>
  }): () => void
}

/** 本插件用到的请求子集（形状对齐 Node `IncomingMessage`）。 */
export interface WebRequestLike {
  /** HTTP 方法。 */
  readonly method?: string
  /**
   * 订阅请求体数据。
   *
   * @param event - `data`。
   * @param listener - 收到一块数据。
   */
  on(event: 'data', listener: (chunk: Uint8Array) => void): void
  /**
   * 订阅请求体结束。
   *
   * @param event - `end`。
   * @param listener - 结束时调用。
   */
  on(event: 'end', listener: () => void): void
  /**
   * 订阅请求错误。
   *
   * @param event - `error`。
   * @param listener - 出错时调用。
   */
  on(event: 'error', listener: (error: unknown) => void): void
}

/** 本插件用到的响应子集。 */
export interface WebResponseLike {
  /**
   * 写状态行与响应头。
   *
   * @param status - 状态码。
   * @param headers - 响应头。
   */
  writeHead(status: number, headers: Record<string, string>): void
  /**
   * 结束响应。
   *
   * @param body - 响应体。
   */
  end(body?: string | Uint8Array): void
}

/**
 * 把任意服务取成目标类型（软依赖的窄化辅助）。
 *
 * @param ctx - 插件上下文。
 * @param name - 服务名。
 * @param probe - 判定该实例是否具备所需方法的守卫。
 * @returns 服务实例或 undefined。
 */
export function optionalService<T>(ctx: PluginContext, name: string, probe: (value: unknown) => boolean): T | undefined {
  const value = ctx.get(name)
  return probe(value) ? (value as T) : undefined
}
