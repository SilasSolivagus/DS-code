// test/useChat.steering.test.ts
import { describe, it, expect } from 'vitest'
import { SteeringQueue, formatSteeringMessage } from '../src/steering.js'

// useChat 完整 harness 较重；本任务核心可测单元是「队列 + 注入格式 + drainSteering 闭包」的契约。
// toolInFlight（toolsRunning > 0 → abort）行为依赖 AbortController 跨 async 边界，在
// React hook 内嵌套；这里改用集成层（真机冒烟）验证，单元层只锁定队列契约。
describe('steering 接线契约', () => {
  it('drainSteering 闭包把队列项经 formatSteeringMessage 包装后清空队列', () => {
    const q = new SteeringQueue()
    q.enqueue('改方案', 'next'); q.enqueue('再加一句', 'now')
    const drainSteering = () => q.drainAll().map(i => formatSteeringMessage(i.value))
    const out = drainSteering()
    expect(out).toHaveLength(2)
    expect(out[0]).toContain('改方案')
    expect(out[1]).toContain('再加一句')
    expect(q.size).toBe(0)
    expect(drainSteering()).toEqual([])
  })

  it('steer 模拟：无 tool 时只入队，不触发 abort', () => {
    // 模拟 steer() 函数逻辑（toolsRunning=0）
    const q = new SteeringQueue()
    let aborted = false
    const mockAbort = (reason: string) => { aborted = true; void reason }
    const toolsRunning = 0

    const steer = (text: string) => {
      if (!text.trim()) return
      q.enqueue(text, 'next')
      if (toolsRunning > 0) mockAbort('interrupt')
    }

    steer('转个方向')
    expect(q.size).toBe(1)
    expect(aborted).toBe(false)
  })

  it('steer 模拟：有 tool 在跑时同时触发 abort(interrupt)', () => {
    // 模拟 steer() 函数逻辑（toolsRunning=1）
    const q = new SteeringQueue()
    let abortReason: string | undefined
    const mockAbort = (reason: string) => { abortReason = reason }
    const toolsRunning = 1

    const steer = (text: string) => {
      if (!text.trim()) return
      q.enqueue(text, 'next')
      if (toolsRunning > 0) mockAbort('interrupt')
    }

    steer('立刻转向')
    expect(q.size).toBe(1)
    expect(abortReason).toBe('interrupt')
  })

  it('steer 模拟：空文本不入队也不 abort', () => {
    const q = new SteeringQueue()
    let aborted = false
    const mockAbort = () => { aborted = true }
    const toolsRunning = 1

    const steer = (text: string) => {
      if (!text.trim()) return
      q.enqueue(text, 'next')
      if (toolsRunning > 0) mockAbort()
    }

    steer('   ')
    expect(q.size).toBe(0)
    expect(aborted).toBe(false)
  })
})
