import { describe, it, expect, vi } from 'vitest'
import { parseStatusLineStdout, createStatusLineRunner } from '../src/statusLine.js'

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
