// src/tools/types.ts
import type { z } from 'zod'
import type { TaskListStore } from '../taskList.js'
import type { HookEvent, HookOutcome } from '../hooks.js'

export interface ToolContext {
  cwd: () => string
  setCwd: (dir: string) => void
  readonly signal: AbortSignal
  /** 绝对路径 -> mtimeMs。Read 记录；M2 的 Edit 用它强制 read-before-edit */
  fileState: Map<string, number>
  /** todo 任务清单 store（REPL/headless 注入；子代理不注入）。 */
  taskList?: TaskListStore
  /** /rewind before-image 钩子：Edit/Write 写盘前调，捕获文件原内容。子代理/headless 不注入（无快照）。 */
  recordBeforeImage?: (absPath: string) => void
  /** 子代理上下文标记：子代理保持纯执行，禁止起后台任务（防污染主会话通知队列）。 */
  isSubagent?: boolean
  /** hooks 生命周期分派闭包（捕获会话 hooks 快照）。主会话与 headless 顶层 ctx 注入；子代理内部子 ctx 不注入。
   *  工具层事件（SubagentStart/Stop、①b-2 的 CwdChanged/Task/Notification）经此发事件。对空配置零开销返回空 outcome。 */
  hookDispatch?: (event: HookEvent, payload: Record<string, unknown>) => Promise<HookOutcome>
  /** 会话 ID（落盘文件 basename）。会话级事件 payload 的 session_id；①b-3 env-file 目录键。
   *  主会话/headless 顶层 ctx 注入；子代理子 ctx 不注入。getter 形式：resume/clear 换 session 后随之更新。 */
  sessionId?: () => string | undefined
  /** inline skill 注入：工具调用时把内容排进待注入队列，loop 在本轮 tool 结果回灌后作为 user 消息 flush。
   *  主会话/headless 顶层 ctx 注入；子代理子 ctx 不注入（forked skill 不嵌套注入）。 */
  injectUserMessage?: (content: string) => void
  /** deny 规则列表（Glob/Grep 过滤输出用）。主会话/headless 注入；子代理可不注入。 */
  denyPatterns?: () => string[]
}

export interface Tool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  description: string
  inputSchema: S
  /** MCP 工具：直接透传 server 给的 JSON Schema；toApiTools 优先用它，跳过 zodToJsonSchema。 */
  rawJsonSchema?: object
  /** 只读工具：自动放行权限 + 可并发执行 */
  isReadOnly: boolean
  /** false=无需确认；string=展示给用户的操作描述（权限规则的匹配对象） */
  needsPermission(input: z.infer<S>): false | string
  /** 本次调用会触碰的绝对路径（权限层 deny 检查用）。工具自管路径语义，无则不参与 deny。 */
  deniablePaths?(input: z.infer<S>, cwd: string): string[]
  call(input: z.infer<S>, ctx: ToolContext): Promise<string>
}
