import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sleepTool } from '../src/tools/sleep.js'
import type { ToolContext } from '../src/tools/types.js'

function makeCtx(signal: AbortSignal): ToolContext {
  return {
    cwd: () => process.cwd(),
    setCwd: () => {},
    signal,
    fileState: new Map(),
  } as ToolContext
}

describe('sleepTool', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('自然完成返回已等待文案', async () => {
    const ac = new AbortController()
    const p = sleepTool.call({ seconds: 2 }, makeCtx(ac.signal))
    await vi.advanceTimersByTimeAsync(2000)
    expect(await p).toBe('已等待 2 秒')
  })

  it('中途中断返回已过秒数', async () => {
    const ac = new AbortController()
    const p = sleepTool.call({ seconds: 10 }, makeCtx(ac.signal))
    await vi.advanceTimersByTimeAsync(1000)
    ac.abort('interrupt')
    await vi.advanceTimersByTimeAsync(100)
    expect(await p).toBe('已中断等待（已过 1 秒）')
  })

  it('入参已中断则立即返回 0 秒', async () => {
    const ac = new AbortController()
    ac.abort('interrupt')
    const p = sleepTool.call({ seconds: 10 }, makeCtx(ac.signal))
    await vi.advanceTimersByTimeAsync(100)
    expect(await p).toBe('已中断等待（已过 0 秒）')
  })

  it('schema 拒绝越界秒数', () => {
    expect(sleepTool.inputSchema.safeParse({ seconds: 5000 }).success).toBe(false)
    expect(sleepTool.inputSchema.safeParse({ seconds: 0 }).success).toBe(false)
    expect(sleepTool.inputSchema.safeParse({ seconds: 1.5 }).success).toBe(false)
    expect(sleepTool.inputSchema.safeParse({ seconds: 30 }).success).toBe(true)
  })

  it('元数据：只读、免审批', () => {
    expect(sleepTool.isReadOnly).toBe(true)
    expect(sleepTool.needsPermission({ seconds: 1 })).toBe(false)
  })
})
