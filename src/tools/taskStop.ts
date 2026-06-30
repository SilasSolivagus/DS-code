import { z } from 'zod'
import type { Tool } from './types.js'
import { getTask, updateTask, killProcessTree } from '../tasks.js'
import { getScheduler } from './scheduleWakeup.js'

const schema = z.object({ task_id: z.string().describe('要停止的后台任务 id（含 Monitor / cron）') })

export const taskStopTool: Tool<typeof schema> = {
  name: 'TaskStop',
  description: '按 id 停止一个运行中的后台任务（Monitor、后台 Bash、cron）。',
  inputSchema: schema,
  isReadOnly: true,
  needsPermission: () => false,
  async call(input) {
    const t = getTask(input.task_id)
    if (t) {
      if (t.status === 'running') {
        if (t.type === 'local_bash') killProcessTree(t.child, 'SIGTERM')
        else t.abortController?.abort()
        updateTask(t.id, { status: 'killed', endTime: Date.now() })
      }
      return `已停止 ${input.task_id}`
    }
    if (getScheduler()?.cancel(input.task_id)) return `已停止 ${input.task_id}`
    return `未找到 ${input.task_id}`
  },
}
