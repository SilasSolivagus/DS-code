// test/todo.test.ts
import { describe, it, expect } from 'vitest'
import { TodoStore } from '../src/todo.js'
import { todoWriteTool } from '../src/tools/todowrite.js'

const ctx = (todos?: TodoStore): any => ({
  cwd: () => '/tmp', setCwd: () => {}, signal: new AbortController().signal, fileState: new Map(), todos,
})

describe('TodoStore', () => {
  it('set 记录清单并重置走神计数', () => {
    const s = new TodoStore()
    s.tick(); s.tick(); s.tick()
    s.set([{ content: '修 bug', status: 'pending' }])
    expect(s.staleReminder()).toBeNull() // 刚更新过
  })

  it('连续 3 轮未更新且有未完成项时给提醒，之后每 3 轮再提醒一次', () => {
    const s = new TodoStore()
    s.set([{ content: '修 bug', status: 'in_progress' }])
    s.tick(); s.tick()
    expect(s.staleReminder()).toBeNull() // 2 轮，未到
    s.tick()
    expect(s.staleReminder()).toContain('修 bug') // 3 轮，提醒
    s.tick()
    expect(s.staleReminder()).toBeNull() // 4 轮，不重复刷屏
    s.tick(); s.tick()
    expect(s.staleReminder()).toContain('修 bug') // 6 轮，再提醒
  })

  it('全部完成则永不提醒', () => {
    const s = new TodoStore()
    s.set([{ content: 'x', status: 'completed' }])
    s.tick(); s.tick(); s.tick()
    expect(s.staleReminder()).toBeNull()
  })
})

describe('TodoWrite 工具', () => {
  it('全量覆盖写入并返回渲染清单', async () => {
    const store = new TodoStore()
    const out = await todoWriteTool.call(
      { todos: [{ content: '读代码', status: 'completed' }, { content: '改代码', status: 'in_progress' }] },
      ctx(store),
    )
    expect(store.items.length).toBe(2)
    expect(out).toContain('改代码')
  })

  it('ctx 无 todos 时返回错误文本不抛异常', async () => {
    const out = await todoWriteTool.call({ todos: [] }, ctx(undefined))
    expect(out).toContain('不支持')
  })
})
