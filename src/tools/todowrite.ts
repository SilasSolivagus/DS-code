// src/tools/todowrite.ts
import { z } from 'zod'
import type { Tool } from './types.js'

const item = z.object({
  content: z.string().min(1).describe('任务内容，一句话'),
  status: z.enum(['pending', 'in_progress', 'completed']).describe('任务状态'),
})
const schema = z.object({
  todos: z.array(item).describe('完整的任务清单（全量覆盖式写入，不是增量）'),
})

export const todoWriteTool: Tool<typeof schema> = {
  name: 'TodoWrite',
  description:
    '维护当前任务清单。多步任务（3 步以上）开始时先列出计划；每完成一项立即把它标为 completed 并把下一项标为 in_progress。每次调用传入完整清单（全量覆盖）。同一时刻至多一项 in_progress。',
  inputSchema: schema,
  isReadOnly: true,
  needsPermission: () => false,
  async call(input, ctx) {
    if (!ctx.todos) return '错误：当前会话不支持 Todo。'
    ctx.todos.set(input.todos)
    const mark = (s: string) => (s === 'completed' ? '✔' : s === 'in_progress' ? '▸' : '·')
    return `Todo 已更新：\n${input.todos.map(t => `${mark(t.status)} ${t.content}`).join('\n')}`
  },
}
