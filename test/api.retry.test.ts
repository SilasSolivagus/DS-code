import { describe, it, expect, vi } from 'vitest'
import { withRetry } from '../src/api.js'

const noSleep = async () => {}

describe('withRetry', () => {
  it('429 重试后成功', async () => {
    let n = 0
    const fn = vi.fn(async () => {
      if (++n < 3) throw Object.assign(new Error('rate limited'), { status: 429 })
      return 'ok'
    })
    await expect(withRetry(fn, 3, noSleep)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('400 不重试，立刻抛出', async () => {
    const fn = vi.fn(async () => { throw Object.assign(new Error('bad request'), { status: 400 }) })
    await expect(withRetry(fn, 3, noSleep)).rejects.toThrow('bad request')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('超过最大次数后抛出最后的错误', async () => {
    const fn = vi.fn(async () => { throw Object.assign(new Error('boom'), { status: 503 }) })
    await expect(withRetry(fn, 2, noSleep)).rejects.toThrow('boom')
    expect(fn).toHaveBeenCalledTimes(3) // 首次 + 2 次重试
  })

  it('网络错误（ECONNRESET）可重试', async () => {
    let n = 0
    const fn = vi.fn(async () => {
      if (++n < 2) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
      return 'ok'
    })
    await expect(withRetry(fn, 3, noSleep)).resolves.toBe('ok')
  })
})

describe('createClient', () => {
  it('缺少 DEEPSEEK_API_KEY 抛中文错误', async () => {
    const { createClient } = await import('../src/api.js')
    const saved = { key: process.env.DEEPSEEK_API_KEY, p1: process.env.https_proxy }
    delete process.env.DEEPSEEK_API_KEY
    try {
      expect(() => createClient()).toThrow('DEEPSEEK_API_KEY')
    } finally {
      if (saved.key) process.env.DEEPSEEK_API_KEY = saved.key
    }
  })
})
