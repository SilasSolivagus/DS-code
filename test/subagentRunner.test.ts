import { describe, it, expect } from 'vitest'
import { acquire, release } from '../src/subagentRunner.js'

describe('subagentRunner 信号量', () => {
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
