// test/workflow.backend.test.ts
import { describe, it, expect, vi } from 'vitest'
import { makeInProcessBackend, mapEffort } from '../src/workflow/backend.js'
import { z } from 'zod'

describe('mapEffort（5→3 clamp）', () => {
  it('low/medium/high 直传，xhigh/max→high，undefined→undefined', () => {
    expect(mapEffort('low')).toBe('low')
    expect(mapEffort('high')).toBe('high')
    expect(mapEffort('xhigh')).toBe('high')
    expect(mapEffort('max')).toBe('high')
    expect(mapEffort(undefined)).toBeUndefined()
  })
})

describe('InProcessBackend', () => {
  it('调用 runSubagent，effort/thinking/model 透传', async () => {
    const runSubagent = vi.fn().mockResolvedValue('"hello"')
    const backend = makeInProcessBackend({ runSubagent: runSubagent as any, sessionModel: 'glm-5.2', client: {} as any, onUsage: () => {}, ctx: {} as any, signal: new AbortController().signal, agents: [] })
    const out = await backend.runAgent({ prompt: 'p', opts: { effort: 'max', model: undefined }, agentId: 'a1', index: 0 })
    expect(out.status).toBe('ok')
    const call = runSubagent.mock.calls[0][0]
    expect(call.model).toBe('glm-5.2')       // 省略 model → 继承 session
    expect(call.thinking).toBe(true)          // 设了 effort → thinking on
    expect(call.effortLevel).toBe('high')     // max→high
  })
  it('isolation:"remote" → 报 not available', async () => {
    const backend = makeInProcessBackend({ runSubagent: vi.fn() as any, sessionModel: 'm', client: {} as any, onUsage: () => {}, ctx: {} as any, signal: new AbortController().signal, agents: [] })
    await expect(backend.runAgent({ prompt: 'p', opts: { isolation: 'remote' }, agentId: 'a1', index: 0 }))
      .rejects.toThrow(/isolation:'remote'\}\) is not available in this build/)
  })
  it('general-purpose 子代理从 toolPool 获得非空 tools（resolveAgentTools）', async () => {
    const fakeRead: any = { name: 'Read', description: 'r', inputSchema: z.any(), isReadOnly: true, needsPermission: () => false, call: async () => '' }
    const runSubagent = vi.fn().mockResolvedValue(null)
    const backend = makeInProcessBackend({
      runSubagent: runSubagent as any,
      sessionModel: 'm',
      client: {} as any,
      onUsage: () => {},
      ctx: {} as any,
      signal: new AbortController().signal,
      agents: [],
      toolPool: [fakeRead],
    })
    await backend.runAgent({ prompt: 'p', opts: {}, agentId: 'a2', index: 0 })
    const call = runSubagent.mock.calls[0][0]
    expect(call.tools).toHaveLength(1)
    expect(call.tools[0].name).toBe('Read')
  })
})
