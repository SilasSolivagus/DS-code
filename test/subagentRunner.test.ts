import { describe, it, expect, afterEach } from 'vitest'
import { acquire, release, acquireMemory, releaseMemory, __resetSubagentSemaphoreForTest, __resetMemorySemaphoreForTest } from '../src/subagentRunner.js'

describe('subagentRunner 信号量', () => {
  afterEach(() => __resetSubagentSemaphoreForTest())

  it('并发上限 4：第 5 个 acquire 阻塞直到 release', async () => {
    for (let i = 0; i < 4; i++) await acquire() // 占满 4 个许可
    let fifthGranted = false
    const fifth = acquire().then(() => { fifthGranted = true })
    await new Promise(r => setTimeout(r, 10))
    expect(fifthGranted).toBe(false) // 第 5 个仍在等
    release()                        // 释放一个许可
    await fifth
    expect(fifthGranted).toBe(true)  // 第 5 个拿到
    for (let i = 0; i < 4; i++) release() // 收尾归还（4 占用 -1 释放 +1 第五占用 = 净占用 4）
  })
})

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

  it('记忆信号量与用户 subagent 池互不影响（独立计数）', async () => {
    // 占满用户池（4），记忆信号量仍可独立 acquire
    for (let i = 0; i < 4; i++) await acquire()
    let memGranted = false
    await acquireMemory().then(() => { memGranted = true })
    expect(memGranted).toBe(true) // 记忆许可不受用户池影响
    releaseMemory()
    for (let i = 0; i < 4; i++) release()
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
})
