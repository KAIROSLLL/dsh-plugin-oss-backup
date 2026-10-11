/**
 * `@deepseek-ai/dsh-tools` 的最小类型声明。
 *
 * 为什么自带一份：该包由 DSH 宿主在运行时提供（`peerDependencies: "*"`），
 * 而 npm 上的 `@deepseek-ai/dsh-tools@0.0.1-rc.1` 依赖未发布的私有包
 * `@deepseek-ai/dsh-type-meta`，装不下来（`ERR_PNPM_FETCH_404`）。
 * 因此这里按官方工具编写参考声明**只用到的那些字段**，让 `tsc` 能做静态检查；
 * 运行时的校验与推断仍由宿主真实的 `defineTool` 完成。
 *
 * 契约来源：DSH 文档 docs/.../cookbook/adding-a-tool（最小形态 + output 声明）。
 *
 * @module dsh-plugin-oss-backup/types/dsh-tools
 */
declare module '@deepseek-ai/dsh-tools' {
  /** 标量字面量类型（参数/输出的 enum 与 const 用）。 */
  export type ToolSchemaScalar = string | number | boolean | null

  /** 参数 DSL 的一个节点。 */
  export interface ToolParameterSpec {
    /** 节点类型。 */
    readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object' | 'json'
    /** 标记为必填。省略即可选。 */
    readonly required?: true
    /** 面向模型的说明。 */
    readonly description?: string
    /** 允许的标量值。 */
    readonly enum?: readonly ToolSchemaScalar[]
    /** 唯一允许的标量值。 */
    readonly const?: ToolSchemaScalar
    /** 数组元素 schema。 */
    readonly items?: ToolParameterSpec
    /** 对象属性 schema。 */
    readonly properties?: Readonly<Record<string, ToolParameterSpec>>
    /** 对象节点必须显式声明是否允许未声明的键。 */
    readonly additionalProperties?: boolean
  }

  /** 工具参数：隐式开放对象根，必填性写在每个属性上。 */
  export type ToolParameters = Readonly<Record<string, ToolParameterSpec>>

  /** 规范输出值 schema（作者侧 DSL）。 */
  export interface ToolOutputSchema {
    /** 根类型。 */
    readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object' | 'json'
    /** 对象属性。 */
    readonly properties?: Readonly<Record<string, unknown>>
    /** 数组元素。 */
    readonly items?: unknown
    /** 必填键。 */
    readonly required?: readonly string[]
    /** 是否允许未声明的键（对象节点必须显式声明）。 */
    readonly additionalProperties?: boolean
    /** 说明。 */
    readonly description?: string
  }

  /** 模型可见的内容块（本插件只产出文本）。 */
  export interface ToolTextContentBlock {
    /** 块类型。 */
    readonly type: 'text'
    /** 文本正文。 */
    readonly text: string
  }

  /** 规范输出声明：schema + 纯渲染器（可为 UI 回放再算一次的持久化投影）。 */
  export interface ToolOutputDefinition<Value = unknown> {
    /** 规范值的 JSON Schema。 */
    readonly schema: ToolOutputSchema
    /**
     * 把规范值渲染成模型可见内容。必须是纯函数。
     *
     * @param args - 已校验的参数。
     * @param value - 已校验的规范值。
     * @returns 内容块。
     */
    render(args: unknown, value: Value): ToolTextContentBlock[]
    /**
     * 可选的持久化卡片投影。必须是纯函数。
     *
     * @param args - 已校验的参数。
     * @param value - 已校验的规范值。
     * @returns 可回放的 JSON 元数据。
     */
    presentationMeta?(args: unknown, value: Value): unknown
  }

  /** 工具执行上下文（只声明本插件用到的字段）。 */
  export interface ToolRunContext {
    /** 调用方持有的取消信号：必须转发给进行中的工作。 */
    readonly signal: AbortSignal
    /** 本次调用的标识。 */
    readonly callId: string
  }

  /** `defineTool` 的入参。 */
  export interface DefineToolOptions<Args, Value> {
    /** 工具名（模型可见，全局唯一）。 */
    readonly name: string
    /** 工具说明（模型可见）。 */
    readonly description: string
    /** 参数声明。 */
    readonly parameters: ToolParameters
    /** 规范输出声明。 */
    readonly output: ToolOutputDefinition<Value>
    /**
     * 执行体。返回规范值本身，不要返回内容块。
     *
     * @param args - 已按 `parameters` 校验并收窄的参数。
     * @param exec - 调用身份与取消信号。
     * @returns 符合 `output.schema` 的规范值。
     */
    execute(args: Args, exec: ToolRunContext): Promise<Value> | Value
    /** 协作式超时预算（毫秒）。 */
    readonly timeoutMs?: number
    /** 纯函数的并发安全分类器。 */
    isConcurrencySafe?(args: Args): boolean
  }

  /**
   * 构造一个已注册用的工具定义。
   *
   * @param options - 工具声明与执行体。
   * @returns 交给 `ctx.tools.register()` 的定义。
   */
  export function defineTool<Args = Record<string, unknown>, Value = unknown>(
    options: DefineToolOptions<Args, Value>,
  ): unknown
}
