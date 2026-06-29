import { describe, it, expect, vi } from 'vitest'

// 拦截 runLoop，断言它收到的 deps
const loopSpy = vi.fn()
vi.mock('../src/loop.js', () => ({
  runLoop: (msgs: any[], deps: any) => { loopSpy(deps); return (async function* () {})() },
}))

import { runSubagent } from '../src/subagentRunner.js'

describe('subagent effort/thinking 接线', () => {
  it('把 thinking + effortLevel 传进内层 runLoop（默认 thinking=false）', async () => {
    loopSpy.mockClear()
    const base = {
      client: {} as any, onUsage: () => {}, systemPrompt: 's', userPrompt: 'u',
      tools: [], model: 'm', ctx: { cwd: () => '/', setCwd: () => {}, get signal() { return new AbortController().signal }, fileState: new Map() } as any,
      signal: new AbortController().signal, agentId: 'a1', agentType: 'general-purpose',
    }
    await runSubagent({ ...base, thinking: true, effortLevel: 'low' })
    expect(loopSpy).toHaveBeenCalledWith(expect.objectContaining({ thinking: true, effortLevel: 'low' }))
    loopSpy.mockClear()
    await runSubagent(base) // 不传 → 默认 thinking:false
    expect(loopSpy).toHaveBeenCalledWith(expect.objectContaining({ thinking: false }))
  })
})
