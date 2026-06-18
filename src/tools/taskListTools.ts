// src/tools/taskListTools.ts —— CC 式 todo 工具：TaskCreate/Get/Update/List。
import { z } from 'zod'
import type { Tool, ToolContext } from './types.js'
import type { Task } from '../taskList.js'

const mark = (s: Task['status']): string => (s === 'completed' ? '✔' : s === 'in_progress' ? '▸' : '·')
const renderLine = (t: Task): string => `${mark(t.status)} #${t.id} ${t.subject}${t.activeForm ? `（${t.activeForm}）` : ''}`
const renderFull = (t: Task): string =>
  `#${t.id} ${t.subject}\n状态：${t.status}\n描述：${t.description}` +
  (t.activeForm ? `\n进行时：${t.activeForm}` : '') +
  (t.metadata ? `\n元数据：${JSON.stringify(t.metadata)}` : '')

const createSchema = z.object({
  subject: z.string().describe('简短标题'),
  description: z.string().describe('要做什么'),
  activeForm: z.string().optional().describe('进行时文案，如 "Running tests"'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('任意元数据'),
})
export const taskCreateTool: Tool<typeof createSchema> = {
  name: 'TaskCreate',
  description: '创建一个任务到任务清单。多步任务（3 步以上）开始时先建任务列出计划。',
  inputSchema: createSchema,
  isReadOnly: false,
  needsPermission: () => false,
  async call(input, ctx: ToolContext) {
    if (!ctx.taskList) return '错误：当前会话不支持任务清单。'
    const t = ctx.taskList.create(input)
    return `已创建任务 #${t.id}：${t.subject}`
  },
}

const getSchema = z.object({ taskId: z.string().describe('任务 id') })
export const taskGetTool: Tool<typeof getSchema> = {
  name: 'TaskGet',
  description: '按 id 取一个任务的全部字段。',
  inputSchema: getSchema,
  isReadOnly: true,
  needsPermission: () => false,
  async call(input, ctx: ToolContext) {
    if (!ctx.taskList) return '错误：当前会话不支持任务清单。'
    const t = ctx.taskList.get(input.taskId)
    return t ? renderFull(t) : `任务 ${input.taskId} 不存在`
  },
}

const updateSchema = z.object({
  taskId: z.string().describe('要更新的任务 id'),
  subject: z.string().optional().describe('新标题'),
  description: z.string().optional().describe('新描述'),
  activeForm: z.string().optional().describe('进行时文案'),
  status: z.enum(['pending', 'in_progress', 'completed', 'deleted']).optional().describe('新状态；deleted 删除任务'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('合并进 metadata；值设 null 删该键'),
})
export const taskUpdateTool: Tool<typeof updateSchema> = {
  name: 'TaskUpdate',
  description: '更新一个任务。完成一项就把它标 completed 并把下一项标 in_progress；同一时刻至多一项 in_progress。',
  inputSchema: updateSchema,
  isReadOnly: false,
  needsPermission: () => false,
  async call(input, ctx: ToolContext) {
    if (!ctx.taskList) return '错误：当前会话不支持任务清单。'
    const { taskId, ...patch } = input
    const r = ctx.taskList.update(taskId, patch)
    if (!r.ok) return `任务 ${taskId} 不存在`
    return `已更新任务 #${taskId}：${r.updatedFields.join('、') || '（无改动）'}`
  },
}

const listSchema = z.object({})
export const taskListTool: Tool<typeof listSchema> = {
  name: 'TaskList',
  description: '列出当前任务清单（id/subject/status）。',
  inputSchema: listSchema,
  isReadOnly: true,
  needsPermission: () => false,
  async call(_input, ctx: ToolContext) {
    if (!ctx.taskList) return '错误：当前会话不支持任务清单。'
    const tasks = ctx.taskList.list()
    return tasks.length ? tasks.map(renderLine).join('\n') : '（任务清单为空）'
  },
}
