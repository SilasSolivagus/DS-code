// src/tools/taskTools.ts
import { z } from 'zod'
import fs from 'node:fs'
import type { Tool } from './types.js'
import {
  listTasks,
  getTask,
  updateTask,
  formatTaskList,
  killProcessTree,
  type TaskStatus,
} from '../tasks.js'

const TERMINAL: TaskStatus[] = ['completed', 'failed', 'killed']

const listSchema = z.object({})

export const bgTaskListTool: Tool<typeof listSchema> = {
  name: 'BgTaskList',
  description: '列出所有后台进程任务（id/状态/描述）',
  inputSchema: listSchema,
  isReadOnly: true,
  needsPermission: () => false,
  async call() {
    return formatTaskList(listTasks())
  },
}

const outputSchema = z.object({
  task_id: z.string().describe('后台任务 id'),
  offset: z.number().optional().describe('从该字节偏移读；省略则从上次游标增量读'),
})

export const taskOutputTool: Tool<typeof outputSchema> = {
  name: 'TaskOutput',
  description: '读取后台任务输出（默认增量；给 offset 则从指定字节处读）',
  inputSchema: outputSchema,
  isReadOnly: true,
  needsPermission: () => false,
  async call(input) {
    const t = getTask(input.task_id)
    if (!t) return `任务 ${input.task_id} 不存在`
    const from = input.offset ?? t.outputOffset
    const buf = fs.existsSync(t.outputFile) ? fs.readFileSync(t.outputFile) : Buffer.alloc(0)
    const chunk = buf.subarray(from).toString('utf8')
    updateTask(t.id, { outputOffset: buf.length })
    if (TERMINAL.includes(t.status)) updateTask(t.id, { notified: true })
    // 无文件流输出（如 Workflow：结果存 task.result 而非 outputFile）时回退到 result，
    // 否则模型轮询 TaskOutput 只看到 <status> 看不到产出。
    const body = chunk || (t.result ?? '')
    return `<status>${t.status}</status>\n${body}`
  },
}

const stopSchema = z.object({
  task_id: z.string(),
})

export const taskStopTool: Tool<typeof stopSchema> = {
  name: 'TaskStop',
  description: '停止运行中的后台任务',
  inputSchema: stopSchema,
  isReadOnly: false,
  needsPermission: () => false,
  async call(input) {
    const t = getTask(input.task_id)
    if (!t) return `任务 ${input.task_id} 不存在`
    if (t.status !== 'running') return `任务 ${input.task_id} 非运行中（${t.status}）`
    if (t.type === 'local_bash') killProcessTree(t.child, 'SIGTERM')
    else t.abortController?.abort()
    updateTask(t.id, { status: 'killed', notified: true, endTime: Date.now() })
    return `已停止任务 ${input.task_id}`
  },
}
