import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { parseStatusLineStdout, createStatusLineRunner, execStatusLineCommand } from '../src/statusLine.js'

/** 造一个最小 ChildProcess 假体：stdout/stderr 是 EventEmitter，stdin 是 no-op，kill 记标记。 */
function makeFakeChild(): any {
  const child: any = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { write: () => {}, end: () => {} }
  child.killed = false
  child.kill = () => { child.killed = true; return true }
  return child
}

/** spawn 假体：下一 microtask 吐 out 然后以 code 关闭。 */
function spawnThenClose(out: string, code: number): any {
  return () => {
    const c = makeFakeChild()
    queueMicrotask(() => { if (out) c.stdout.emit('data', Buffer.from(out)); c.emit('close', code) })
    return c
  }
}

describe('parseStatusLineStdout', () => {
  it('多行 trim 去空 join 单行', () => {
    expect(parseStatusLineStdout('  a \n\n  b  \n')).toBe('a b')
  })
  it('超长截断到 maxChars', () => {
    expect(parseStatusLineStdout('x'.repeat(50), 10)).toHaveLength(10)
  })
  it('全空白 → 空串', () => {
    expect(parseStatusLineStdout('   \n  \n')).toBe('')
  })
})

describe('execStatusLineCommand', () => {
  it('exit 0 + stdout → 返回解析后的字符串', async () => {
    const r = await execStatusLineCommand('cmd', {}, { spawn: spawnThenClose('  分支 main \n', 0) })
    expect(r).toBe('分支 main')
  })
  it('exit≠0 → undefined（不抛）', async () => {
    const r = await execStatusLineCommand('cmd', {}, { spawn: spawnThenClose('有输出但失败', 1) })
    expect(r).toBeUndefined()
  })
  it('exit 0 但空输出 → undefined', async () => {
    const r = await execStatusLineCommand('cmd', {}, { spawn: spawnThenClose('   \n', 0) })
    expect(r).toBeUndefined()
  })
  it('spawn 抛错 → undefined（不抛）', async () => {
    const r = await execStatusLineCommand('cmd', {}, { spawn: (() => { throw new Error('boom') }) as any })
    expect(r).toBeUndefined()
  })
  it('超时 → undefined 且杀子进程', async () => {
    let child: any
    const spawn = (() => { child = makeFakeChild(); return child }) as any // 永不 close
    const r = await execStatusLineCommand('cmd', {}, { spawn, timeoutMs: 20 })
    expect(r).toBeUndefined()
    expect(child.killed).toBe(true)
  })
  it('外部 signal abort → undefined 且杀子进程', async () => {
    let child: any
    const spawn = (() => { child = makeFakeChild(); return child }) as any // 永不 close
    const ctrl = new AbortController()
    const p = execStatusLineCommand('cmd', {}, { spawn, signal: ctrl.signal, timeoutMs: 5000 })
    ctrl.abort()
    const r = await p
    expect(r).toBeUndefined()
    expect(child.killed).toBe(true)
  })
})

describe('createStatusLineRunner', () => {
  it('300ms 去抖：连续 schedule 只跑一次', async () => {
    vi.useFakeTimers()
    const exec = vi.fn(async () => 'out')
    const changes: (string | undefined)[] = []
    const r = createStatusLineRunner({ exec, onChange: t => changes.push(t), debounceMs: 300 })
    r.schedule(); r.schedule(); r.schedule()
    await vi.advanceTimersByTimeAsync(300)
    expect(exec).toHaveBeenCalledTimes(1)
    expect(changes).toEqual(['out'])
    r.dispose(); vi.useRealTimers()
  })
  it('结果不变不重复通知', async () => {
    vi.useFakeTimers()
    const exec = vi.fn(async () => 'same')
    const changes: (string | undefined)[] = []
    const r = createStatusLineRunner({ exec, onChange: t => changes.push(t), debounceMs: 300 })
    r.schedule(); await vi.advanceTimersByTimeAsync(300)
    r.schedule(); await vi.advanceTimersByTimeAsync(300)
    expect(changes).toEqual(['same']) // 第二次相同不通知
    expect(r.current()).toBe('same')
    r.dispose(); vi.useRealTimers()
  })
})
