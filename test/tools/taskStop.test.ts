import { describe, it, expect, beforeEach } from 'vitest'
import { taskStopTool } from '../../src/tools/taskStop.js'
import { registerTask, getTask, clearAllTasks } from '../../src/tasks.js'

beforeEach(() => clearAllTasks())

describe('TaskStop', () => {
  it('停一个 running 任务 → 状态 killed', async () => {
    registerTask({ id: 'b1', type: 'local_bash', status: 'running', description: 'x', startTime: 0, outputFile: '/x', outputOffset: 0, notified: false, child: { pid: undefined, kill() {} } } as any)
    const out = await taskStopTool.call({ task_id: 'b1' }, {} as any)
    expect(out).toMatch(/已停止/)
    expect(getTask('b1')!.status).toBe('killed')
  })
  it('未知 id → 提示未找到', async () => {
    expect(await taskStopTool.call({ task_id: 'nope' }, {} as any)).toMatch(/未找到/)
  })
})
