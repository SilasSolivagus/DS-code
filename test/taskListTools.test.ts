import { describe, it, expect } from 'vitest'
import { taskUpdateTool } from '../src/tools/taskListTools.js'
import { TaskListStore } from '../src/taskList.js'
import type { ToolContext } from '../src/tools/types.js'

function ctxWith(store: TaskListStore): ToolContext {
  return { cwd: () => '/tmp', setCwd: () => {}, get signal() { return new AbortController().signal }, fileState: new Map(), taskList: store } as unknown as ToolContext
}

describe('TaskUpdate 依赖图', () => {
  it('addBlockedBy 写入依赖', async () => {
    const s = new TaskListStore()
    const a = s.create({ subject: 'A', description: 'd' })
    const b = s.create({ subject: 'B', description: 'd' })
    const out = await taskUpdateTool.call({ taskId: b.id, addBlockedBy: [a.id] }, ctxWith(s))
    expect(out).toContain('已更新')
    expect(s.get(b.id)!.blockedBy).toEqual([a.id])
  })

  it('未清依赖时拒绝 in_progress 并提示', async () => {
    const s = new TaskListStore()
    const a = s.create({ subject: 'A', description: 'd' })
    const b = s.create({ subject: 'B', description: 'd' })
    s.update(b.id, { addBlockedBy: [a.id] })
    const out = await taskUpdateTool.call({ taskId: b.id, status: 'in_progress' }, ctxWith(s))
    expect(out).toContain('被未完成依赖阻塞')
    expect(out).toContain(`#${a.id}`)
    expect(s.get(b.id)!.status).toBe('pending')
  })
})
