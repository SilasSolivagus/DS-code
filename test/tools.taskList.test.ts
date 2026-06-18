import { describe, it, expect } from 'vitest'
import { taskCreateTool, taskGetTool, taskUpdateTool, taskListTool } from '../src/tools/taskListTools.js'
import { TaskListStore } from '../src/taskList.js'
import type { ToolContext } from '../src/tools/types.js'

function ctxWith(store: TaskListStore): ToolContext {
  return { taskList: store } as unknown as ToolContext
}

describe('taskListTools', () => {
  it('TaskCreate 建任务、返回 #id', async () => {
    const s = new TaskListStore()
    const out = await taskCreateTool.call({ subject: '修登录', description: '修复登录 bug' }, ctxWith(s))
    expect(out).toContain('#1')
    expect(s.get('1')).toMatchObject({ subject: '修登录' })
  })
  it('TaskGet 取全字段；不存在提示', async () => {
    const s = new TaskListStore(); s.create({ subject: '甲', description: 'd' })
    expect(await taskGetTool.call({ taskId: '1' }, ctxWith(s))).toContain('甲')
    expect(await taskGetTool.call({ taskId: '9' }, ctxWith(s))).toContain('不存在')
  })
  it('TaskUpdate 改状态、返回改动字段', async () => {
    const s = new TaskListStore(); s.create({ subject: '甲', description: 'd' })
    const out = await taskUpdateTool.call({ taskId: '1', status: 'in_progress' }, ctxWith(s))
    expect(out).toContain('#1')
    expect(s.get('1')!.status).toBe('in_progress')
  })
  it('TaskUpdate 不存在 → 提示', async () => {
    const s = new TaskListStore()
    expect(await taskUpdateTool.call({ taskId: '1', status: 'completed' }, ctxWith(s))).toContain('不存在')
  })
  it('TaskList 列出活跃任务', async () => {
    const s = new TaskListStore(); s.create({ subject: '甲', description: 'd' }); s.create({ subject: '乙', description: 'd' })
    const out = await taskListTool.call({}, ctxWith(s))
    expect(out).toContain('#1 甲'); expect(out).toContain('#2 乙')
  })
  it('TaskList 空 → 提示', async () => {
    const s = new TaskListStore()
    expect(await taskListTool.call({}, ctxWith(s))).toContain('为空')
  })
  it('isReadOnly：Get/List 只读，Create/Update 非只读', () => {
    expect(taskGetTool.isReadOnly).toBe(true)
    expect(taskListTool.isReadOnly).toBe(true)
    expect(taskCreateTool.isReadOnly).toBe(false)
    expect(taskUpdateTool.isReadOnly).toBe(false)
  })
  it('全部 needsPermission false', () => {
    for (const t of [taskCreateTool, taskGetTool, taskUpdateTool, taskListTool]) {
      expect(t.needsPermission({} as any)).toBe(false)
    }
  })
})
