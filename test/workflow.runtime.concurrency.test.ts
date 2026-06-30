// test/workflow.runtime.concurrency.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createRuntime } from '../src/workflow/runtime.js'

const base = () => ({ backend: { runAgent: vi.fn() }, journal: { append: vi.fn().mockResolvedValue(undefined) }, records: [], budget: { total: null, spent: () => 0, remaining: () => Infinity }, onProgress: () => {}, abortSignal: new AbortController().signal })

describe('parallel', () => {
  it('await 全部 thunk，throw 位 → null', async () => {
    const rt = createRuntime(base() as any)
    const out = await rt.parallel([() => Promise.resolve('a'), () => { throw new Error('x') }, () => Promise.resolve('c')])
    expect(out).toEqual(['a', null, 'c'])
  })
  it('传 promise 而非 thunk → 报错', async () => {
    const rt = createRuntime(base() as any)
    await expect(rt.parallel([Promise.resolve('a') as any])).rejects.toThrow(/expects an array of functions, not promises/)
  })
  it('>4096 item → 显式报错', async () => {
    const rt = createRuntime(base() as any)
    await expect(rt.parallel(Array.from({ length: 4097 }, () => () => Promise.resolve(1)))).rejects.toThrow(/at most 4096 items/)
  })
})

describe('pipeline', () => {
  it('每 item 穿全 stage；stage throw → item 降 null', async () => {
    const rt = createRuntime(base() as any)
    const out = await rt.pipeline([1, 2, 3],
      (x: number) => x * 10,
      (x: number) => { if (x === 20) throw new Error('drop'); return x + 1 })
    expect(out).toEqual([11, null, 31])
  })
  it('stage 收到 (prev, orig, idx)', async () => {
    const rt = createRuntime(base() as any)
    const seen: any[] = []
    await rt.pipeline(['a'], (_p: any, orig: any, idx: any) => { seen.push([orig, idx]); return 1 })
    expect(seen).toEqual([['a', 0]])
  })
})
