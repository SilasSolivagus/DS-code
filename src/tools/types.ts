// src/tools/types.ts
import type { z } from 'zod'
import type { TodoStore } from '../todo.js'

export interface ToolContext {
  cwd: () => string
  setCwd: (dir: string) => void
  readonly signal: AbortSignal
  /** 绝对路径 -> mtimeMs。Read 记录；M2 的 Edit 用它强制 read-before-edit */
  fileState: Map<string, number>
  /** 任务清单（REPL/headless 注入；子代理不注入） */
  todos?: TodoStore
  /** /rewind before-image 钩子：Edit/Write 写盘前调，捕获文件原内容。子代理/headless 不注入（无快照）。 */
  recordBeforeImage?: (absPath: string) => void
}

export interface Tool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  description: string
  inputSchema: S
  /** 只读工具：自动放行权限 + 可并发执行 */
  isReadOnly: boolean
  /** false=无需确认；string=展示给用户的操作描述（权限规则的匹配对象） */
  needsPermission(input: z.infer<S>): false | string
  call(input: z.infer<S>, ctx: ToolContext): Promise<string>
}
