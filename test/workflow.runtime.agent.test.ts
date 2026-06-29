// test/workflow.runtime.agent.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createRuntime } from '../src/workflow/runtime.js'
import { optsKeyOf } from '../src/workflow/journal.js'

function deps(over: any = {}) {
  return {
    backend: { runAgent: vi.fn().mockResolvedValue({ status: 'ok', result: 'live' }) },
    journal: { append: vi.fn().mockResolvedValue(undefined) },
    records: [],
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    onProgress: () => {},
    abortSignal: new AbortController().signal,
    ...over,
  }
}

describe('runtime.agent()', () => {
  it('正常调用 backend，返回 result', async () => {
    const d = deps()
    const rt = createRuntime(d as any)
    expect(await rt.agent('p')).toBe('live')
    expect(d.backend.runAgent).toHaveBeenCalledOnce()
  })
  it('resume 缓存命中 → 跳过 backend', async () => {
    const records = [{ type: 'workflow_agent', index: 0, agentId: 'a0', model: 'm', status: 'ok', prompt: 'p', optsKey: optsKeyOf({}), result: 'cached' }]
    const d = deps({ records })
    const rt = createRuntime(d as any)
    expect(await rt.agent('p')).toBe('cached')
    expect(d.backend.runAgent).not.toHaveBeenCalled()
  })
  it('backend error → 返回 null', async () => {
    const d = deps({ backend: { runAgent: vi.fn().mockResolvedValue({ status: 'error', result: null }) } })
    expect(await createRuntime(d as any).agent('p')).toBeNull()
  })
  it('budget 达 total → agent() throw', async () => {
    const d = deps({ budget: { total: 100, spent: () => 100, remaining: () => 0 } })
    await expect(createRuntime(d as any).agent('p')).rejects.toThrow(/budget/i)
  })
  it('超 1000 agent → throw backstop', async () => {
    const d = deps()
    const rt = createRuntime(d as any)
    for (let i = 0; i < 1000; i++) await rt.agent('p' + i)
    await expect(rt.agent('over')).rejects.toThrow(/1000/)
  })
})
