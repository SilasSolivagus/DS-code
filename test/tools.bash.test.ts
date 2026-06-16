import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

// ── mock node:child_process：spawn 返回可控假 child；execFile 保留真实行为 ──
const spawnMock = vi.fn()
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: (...args: any[]) => spawnMock(...args) }
})

import { bashTool, truncateMiddle } from '../src/tools/bash.js'
import { makeCtx } from './helpers.js'
import { clearAllTasks, drainNotifications, listTasks, getTask } from '../src/tasks.js'

/** 造一个带 stdout/stderr.pipe、once、kill 的假 child；可手动触发 exit。 */
function makeFakeChild() {
  const child: any = new EventEmitter()
  child.stdout = { pipe: vi.fn() }
  child.stderr = { pipe: vi.fn() }
  child.kill = vi.fn()
  // once 走 EventEmitter 原生（registerTask 用 child.once('exit', ...)）
  return child
}

describe('Bash', () => {
  it('执行命令并返回输出', async () => {
    const out = await bashTool.call({ command: 'echo hi' }, makeCtx('/tmp'))
    expect(out).toContain('hi')
  })

  it('cd 持久化：影响 ctx.cwd', async () => {
    let cwd = process.cwd()
    const ctx = { ...makeCtx(cwd), cwd: () => cwd, setCwd: (d: string) => { cwd = d } }
    await bashTool.call({ command: 'cd /tmp' }, ctx)
    expect(['/tmp', '/private/tmp']).toContain(cwd) // macOS 下 $PWD 可能解析为 /private/tmp
  })

  it('非零退出码报告给模型', async () => {
    const out = await bashTool.call({ command: 'exit 3' }, makeCtx('/tmp'))
    expect(out).toContain('退出码 3')
  })

  it('stderr 一并返回', async () => {
    const out = await bashTool.call({ command: 'echo oops 1>&2' }, makeCtx('/tmp'))
    expect(out).toContain('oops')
  })

  it('truncateMiddle 保留头尾', () => {
    const s = 'a'.repeat(20000) + 'MID' + 'b'.repeat(20000)
    const t = truncateMiddle(s, 30000)
    expect(t.length).toBeLessThan(31000)
    expect(t.startsWith('aaa')).toBe(true)
    expect(t.endsWith('bbb')).toBe(true)
    expect(t).toContain('已截断')
  })
})

describe('Bash run_in_background', () => {
  beforeEach(() => {
    clearAllTasks()
    drainNotifications()
    spawnMock.mockReset()
  })

  it('后台调用立即返回含 id= 的句柄字符串，且注册一条 running 任务', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)

    const out = await bashTool.call(
      { command: 'npm run dev', run_in_background: true },
      makeCtx('/tmp'),
    )
    expect(out).toContain('id=')
    expect(out).toContain('后台任务已启动')

    // 句柄里能抓出 id
    const id = out.match(/id=(\S+?)[，,\s]/)?.[1]
    expect(id).toBeTruthy()

    const tasks = listTasks()
    expect(tasks.length).toBe(1)
    expect(tasks[0].id).toBe(id)
    expect(tasks[0].type).toBe('local_bash')
    expect(tasks[0].status).toBe('running')
    expect(tasks[0].description).toBe('npm run dev')
    expect(tasks[0].command).toBe('npm run dev')

    // stdout/stderr 都接到写流
    expect(child.stdout.pipe).toHaveBeenCalled()
    expect(child.stderr.pipe).toHaveBeenCalled()
  })

  it('exit(0) → 任务转 completed 并入队通知', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)

    await bashTool.call({ command: 'true', run_in_background: true }, makeCtx('/tmp'))
    const id = listTasks()[0].id

    child.emit('exit', 0)

    expect(getTask(id)!.status).toBe('completed')
    expect(getTask(id)!.endTime).toBeGreaterThan(0)
    const notes = drainNotifications()
    expect(notes.length).toBe(1)
    expect(notes[0].id).toBe(id)
    expect(notes[0].status).toBe('completed')
  })

  it('exit(1) → 任务转 failed 并入队通知', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)

    await bashTool.call({ command: 'false', run_in_background: true }, makeCtx('/tmp'))
    const id = listTasks()[0].id

    child.emit('exit', 1)

    expect(getTask(id)!.status).toBe('failed')
    const notes = drainNotifications()
    expect(notes.length).toBe(1)
    expect(notes[0].status).toBe('failed')
  })

  it('已 killed（TaskStop）→ SIGTERM 触发的 exit 回调不覆写成 failed', async () => {
    const { updateTask } = await import('../src/tasks.js')
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)

    await bashTool.call({ command: 'sleep 30', run_in_background: true }, makeCtx('/tmp'))
    const id = listTasks()[0].id
    // 模拟 TaskStop：置 killed + notified
    updateTask(id, { status: 'killed', notified: true })
    // SIGTERM 让进程非零退出 → exit 回调触发
    child.emit('exit', 143)

    expect(getTask(id)!.status).toBe('killed') // 不被覆写成 failed
    expect(drainNotifications().length).toBe(0) // 已 killed 不再重复入队
  })

  it('用 spawn 跑命令（shell -c），cwd 取自 ctx', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)

    await bashTool.call({ command: 'echo x', run_in_background: true }, makeCtx('/some/dir'))
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [shell, args, opts] = spawnMock.mock.calls[0]
    expect(typeof shell).toBe('string')
    expect(args).toEqual(expect.arrayContaining(['-c', 'echo x']))
    expect(opts.cwd).toBe('/some/dir')
    expect(opts.detached).toBe(true) // 进程组长 → 可 kill 整组（修 dev server 孤儿）
  })

  it('前台路径回归：run_in_background 缺省 → 不调 spawn，走真实 execFile', async () => {
    const out = await bashTool.call({ command: 'echo hi' }, makeCtx('/tmp'))
    expect(out).toContain('hi')
    expect(spawnMock).not.toHaveBeenCalled()
    expect(listTasks().length).toBe(0)
  })

  it('子代理降级：isSubagent + run_in_background → 不 spawn、不注册任务，走前台 execFile', async () => {
    const subCtx = { ...makeCtx('/tmp'), isSubagent: true }
    const out = await bashTool.call({ command: 'echo hi', run_in_background: true }, subCtx)
    expect(out).toContain('hi')
    expect(spawnMock).not.toHaveBeenCalled()
    expect(listTasks().length).toBe(0)
  })
})

describe('Bash TaskCreated/TaskCompleted hooks', () => {
  beforeEach(() => {
    clearAllTasks()
    drainNotifications()
    spawnMock.mockReset()
  })

  it('run_in_background → TaskCreated 立即发，命令结束后 TaskCompleted(completed)', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const events: Array<{ event: string; payload: any }> = []
    const dispatch = vi.fn(async (event: string, payload: any) => {
      events.push({ event, payload })
      return { block: false, preventContinuation: false, stop: false, results: [] }
    })
    let cwd = '/tmp'
    const hookCtx = { cwd: () => cwd, setCwd: (d: string) => { cwd = d }, signal: new AbortController().signal, fileState: new Map(), hookDispatch: dispatch }

    const r = await bashTool.call({ command: 'echo hi', run_in_background: true } as any, hookCtx as any)
    expect(r).toContain('后台任务已启动')
    expect(events.find(e => e.event === 'TaskCreated')).toBeTruthy()

    // 触发 exit 完成
    child.emit('exit', 0)

    expect(events.find(e => e.event === 'TaskCompleted')).toBeTruthy()
    expect(events.find(e => e.event === 'TaskCompleted')!.payload.status).toBe('completed')
  })

  it('exit(1) → TaskCompleted(failed)', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const events: Array<{ event: string; payload: any }> = []
    const dispatch = vi.fn(async (event: string, payload: any) => {
      events.push({ event, payload })
      return { block: false, preventContinuation: false, stop: false, results: [] }
    })
    let cwd = '/tmp'
    const hookCtx = { cwd: () => cwd, setCwd: (d: string) => { cwd = d }, signal: new AbortController().signal, fileState: new Map(), hookDispatch: dispatch }

    await bashTool.call({ command: 'false', run_in_background: true } as any, hookCtx as any)
    child.emit('exit', 1)

    expect(events.find(e => e.event === 'TaskCompleted')!.payload.status).toBe('failed')
  })

  it('已 killed → TaskCompleted(killed)', async () => {
    const { updateTask } = await import('../src/tasks.js')
    const child = makeFakeChild()
    spawnMock.mockReturnValue(child)
    const events: Array<{ event: string; payload: any }> = []
    const dispatch = vi.fn(async (event: string, payload: any) => {
      events.push({ event, payload })
      return { block: false, preventContinuation: false, stop: false, results: [] }
    })
    let cwd = '/tmp'
    const hookCtx = { cwd: () => cwd, setCwd: (d: string) => { cwd = d }, signal: new AbortController().signal, fileState: new Map(), hookDispatch: dispatch }

    await bashTool.call({ command: 'sleep 30', run_in_background: true } as any, hookCtx as any)
    const id = listTasks()[0].id
    updateTask(id, { status: 'killed', notified: true })
    child.emit('exit', 143)

    expect(events.find(e => e.event === 'TaskCompleted')!.payload.status).toBe('killed')
  })

  it('无 hookDispatch（子代理 ctx）run_in_background 降级前台、不崩', async () => {
    const subCtx = { ...makeCtx('/tmp'), isSubagent: true }
    await expect(bashTool.call({ command: 'echo x', run_in_background: true } as any, subCtx as any)).resolves.toBeTruthy()
  })
})
