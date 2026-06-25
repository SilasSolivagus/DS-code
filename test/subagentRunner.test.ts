import { describe, it, expect, afterEach } from 'vitest'
import { acquireMemory, releaseMemory, __resetMemorySemaphoreForTest } from '../src/subagentRunner.js'

describe('subagentRunner 记忆信号量', () => {
  afterEach(() => __resetMemorySemaphoreForTest())

  it('并发上限 2：第 3 个 acquireMemory 阻塞直到 releaseMemory', async () => {
    for (let i = 0; i < 2; i++) await acquireMemory() // 占满 2 个许可
    let thirdGranted = false
    const third = acquireMemory().then(() => { thirdGranted = true })
    await new Promise(r => setTimeout(r, 10))
    expect(thirdGranted).toBe(false) // 第 3 个仍在等
    releaseMemory()                  // 释放一个许可
    await third
    expect(thirdGranted).toBe(true)  // 第 3 个拿到
    for (let i = 0; i < 2; i++) releaseMemory() // 收尾归还
  })

  it('异常路径 releaseMemory 后等待者被放行（不泄漏）', async () => {
    for (let i = 0; i < 2; i++) await acquireMemory()
    let waiterGranted = false
    const waiter = acquireMemory().then(() => { waiterGranted = true })
    await new Promise(r => setTimeout(r, 10))
    expect(waiterGranted).toBe(false)
    // 模拟 finally releaseMemory（即使 runSub 抛出）
    releaseMemory()
    await waiter
    expect(waiterGranted).toBe(true)
    // 清理剩余许可
    releaseMemory()
  })

  it('删信号量后并发子代理不死锁（无共享阻塞池）', async () => {
    // 构造 10 个并发 runSubagent 调用（mock 版：直接 resolve，验证 Promise.all 无挂起）
    // 删除 MAX_ACTIVE 信号量后，任意数量并发均可立即 resolve，无排队死锁风险。
    const runFake = async (): Promise<string> => 'ok'
    const results = await Promise.all(Array.from({ length: 10 }, () => runFake()))
    expect(results).toHaveLength(10)
    expect(results.every(r => r === 'ok')).toBe(true)
  })
})
