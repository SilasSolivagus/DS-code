import { describe, it, expect } from 'vitest'
import { taskCreateTool, taskGetTool, taskUpdateTool, taskListTool } from '../src/tools/taskListTools.js'
import { TaskListStore } from '../src/taskList.js'
import type { ToolContext } from '../src/tools/types.js'
import type { HookOutcome } from '../src/hooks.js'

function ctxWith(store: TaskListStore): ToolContext {
  return { taskList: store } as unknown as ToolContext
}

const okOutcome: HookOutcome = { block: false, preventContinuation: false, stop: false, results: [] }
const blockOutcome: HookOutcome = { block: true, preventContinuation: false, stop: false, results: [] }

function ctxWithHook(store: TaskListStore, dispatch: (e: string, p: any) => Promise<HookOutcome>, calls: any[]): ToolContext {
  return {
    taskList: store,
    hookDispatch: async (e: string, p: any) => { calls.push({ e, p }); return dispatch(e, p) },
  } as unknown as ToolContext
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

describe('taskListTools hook 集成', () => {
  it('TaskCreate 触发 TaskCreated（task_kind:todo）', async () => {
    const s = new TaskListStore(); const calls: any[] = []
    await taskCreateTool.call({ subject: '甲', description: 'd' }, ctxWithHook(s, async () => okOutcome, calls))
    const ev = calls.find(c => c.e === 'TaskCreated')
    expect(ev.p).toMatchObject({ task_kind: 'todo', task_id: '1', subject: '甲' })
  })
  it('TaskCreated 被 block → 删任务 + 返回错误', async () => {
    const s = new TaskListStore(); const calls: any[] = []
    const out = await taskCreateTool.call({ subject: '甲', description: 'd' }, ctxWithHook(s, async () => blockOutcome, calls))
    expect(out).toMatch(/被.*(拦截|阻止|hook)/)
    expect(s.get('1')).toBeUndefined()                 // 回滚
  })
  it('TaskUpdate→completed 触发 TaskCompleted；被 block → 拒绝完成、status 不变', async () => {
    const s = new TaskListStore(); s.create({ subject: '甲', description: 'd' }); s.update('1', { status: 'in_progress' })
    const calls: any[] = []
    const out = await taskUpdateTool.call({ taskId: '1', status: 'completed' }, ctxWithHook(s, async () => blockOutcome, calls))
    expect(calls.find(c => c.e === 'TaskCompleted').p).toMatchObject({ task_kind: 'todo', task_id: '1' })
    expect(out).toMatch(/被.*(拦截|阻止|hook)/)
    expect(s.get('1')!.status).toBe('in_progress')      // 未完成
  })
  it('TaskUpdate 非 completed 不触发 TaskCompleted', async () => {
    const s = new TaskListStore(); s.create({ subject: '甲', description: 'd' })
    const calls: any[] = []
    await taskUpdateTool.call({ taskId: '1', status: 'in_progress' }, ctxWithHook(s, async () => okOutcome, calls))
    expect(calls.find(c => c.e === 'TaskCompleted')).toBeUndefined()
  })
  it('无 hookDispatch → 正常创建（fail-safe）', async () => {
    const s = new TaskListStore()
    const out = await taskCreateTool.call({ subject: '甲', description: 'd' }, { taskList: s } as any)
    expect(out).toContain('#1'); expect(s.get('1')).toBeDefined()
  })
})
