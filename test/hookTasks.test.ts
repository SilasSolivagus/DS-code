import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { registerAsync, parseAsyncHookOutput } from '../src/hookTasks.js'
import { listTasks, drainNotifications, clearAllTasks } from '../src/tasks.js'

// 造假 child：可控 stdout/exit。spawn 已由引擎完成，此处直接喂 child。
function fakeChild() {
  const child: any = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  return child
}
function emit(child: any, stdout: string, code: number) {
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout))
    child.emit('close', code)
  })
}
const flush = () => new Promise(r => setTimeout(r, 0))

describe('parseAsyncHookOutput', () => {
  it('剥首行 async marker，提取 additionalContext', () => {
    const out = `{"async":true}\n${JSON.stringify({ hookSpecificOutput: { additionalContext: 'ctx' } })}`
    expect(parseAsyncHookOutput(out, 0, '')).toBe('ctx')
  })
  it('无 marker 首行直接解析', () => {
    const out = JSON.stringify({ systemMessage: 'sys' })
    expect(parseAsyncHookOutput(out, 0, '')).toBe('sys')
  })
  it('无可注入内容 → undefined', () => {
    expect(parseAsyncHookOutput('{"async":true}\nplain text', 0, '')).toBe('plain text')
    expect(parseAsyncHookOutput('{"async":true}\n', 0, '')).toBeUndefined()
  })
})

describe('registerAsync', () => {
  beforeEach(() => clearAllTasks())

  it('普通 async：注册 running 任务，完成后解析 stdout → 入通知队列', async () => {
    const child = fakeChild()
    registerAsync({ child, hook: { type: 'command', command: 'echo' }, payload: {}, label: 'echo' })
    expect(listTasks()[0].status).toBe('running')
    emit(child, `{"async":true}\n${JSON.stringify({ hookSpecificOutput: { additionalContext: '完成上下文' } })}`, 0)
    await flush()
    expect(listTasks()[0].status).toBe('completed')
    const notes = drainNotifications()
    expect(notes).toHaveLength(1)
    expect(notes[0].result).toBe('完成上下文')
  })

  it('普通 async 完成但无可注入内容 → 不入通知队列', async () => {
    const child = fakeChild()
    registerAsync({ child, hook: { type: 'command', command: 'x' }, payload: {}, label: 'x' })
    emit(child, '', 0)
    await flush()
    expect(drainNotifications()).toHaveLength(0)
  })

  it('普通 async exit≠0 但有可注入内容 → 任务 failed 且入队', async () => {
    const child = fakeChild()
    registerAsync({ child, hook: { type: 'command', command: 'x' }, payload: {}, label: 'x' })
    emit(child, JSON.stringify({ hookSpecificOutput: { additionalContext: '失败上下文' } }), 1)
    await flush()
    expect(listTasks()[0].status).toBe('failed')
    const notes = drainNotifications()
    expect(notes).toHaveLength(1)
    expect(notes[0].result).toBe('失败上下文')
  })

  it('普通 async exit≠0 且无可注入内容 → 任务 failed 不入队', async () => {
    const child = fakeChild()
    registerAsync({ child, hook: { type: 'command', command: 'x' }, payload: {}, label: 'x' })
    emit(child, '', 1)
    await flush()
    expect(listTasks()[0].status).toBe('failed')
    expect(drainNotifications()).toHaveLength(0)
  })

  it('asyncRewake exit 2 → 入通知队列，result=stderr', async () => {
    const child = fakeChild()
    registerAsync({ child, hook: { type: 'command', command: 'guard', asyncRewake: true }, payload: {}, label: 'guard' })
    queueMicrotask(() => { child.stderr.emit('data', Buffer.from('阻塞原因')); child.emit('close', 2) })
    await flush()
    const notes = drainNotifications()
    expect(notes).toHaveLength(1)
    expect(notes[0].result).toBe('阻塞原因')
    expect(notes[0].status).toBe('failed')
  })

  it('asyncRewake exit 0 → 静默，不入通知队列', async () => {
    const child = fakeChild()
    registerAsync({ child, hook: { type: 'command', command: 'guard', asyncRewake: true }, payload: {}, label: 'guard' })
    emit(child, '', 0)
    await flush()
    expect(drainNotifications()).toHaveLength(0)
    expect(listTasks()[0].status).toBe('completed')
  })

  it('超时 → kill child', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    registerAsync({ child, hook: { type: 'command', command: 'slow' }, payload: {}, label: 'slow', asyncTimeout: 50 })
    vi.advanceTimersByTime(60)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    vi.useRealTimers()
  })
})
