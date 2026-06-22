// test/useChat.steering.test.ts
import { describe, it, expect } from 'vitest'
import { SteeringQueue, formatSteeringMessage } from '../src/steering.js'

// useChat 完整 harness 较重；本任务核心可测单元是「队列 + 注入格式 + drainSteering 闭包」的契约。
// 若仓库已有 useChat 测试 harness（createChatCore mock client），追加端到端用例；否则至少锁定下列契约。
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
})
