// test/headless.mcp.test.ts — verifies MCP wiring in headless: initMcpTools called + cleanup called
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- api mock (identical to headless.test.ts pattern) ----
const script: Array<{ deltas?: any[]; result: any }> = []
vi.mock('../src/api.js', () => ({
  chatStream: vi.fn(() =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      for (const d of scene.deltas ?? []) yield typeof d === 'string' ? { type: 'text', delta: d } : d
      return scene.result
    })(),
  ),
}))

vi.mock('../src/hooks.js', async (orig) => {
  const actual = await orig<typeof import('../src/hooks.js')>()
  return {
    ...actual,
    runHooks: vi.fn(async () => ({ block: false, preventContinuation: false, stop: false, results: [] })),
  }
})

// ---- settings with mcpServers configured ----
const fakeMcpServers = { my_server: { command: 'node', args: ['mcp-server.js'] } }
vi.mock('../src/config.js', async (orig) => {
  const actual = await orig<typeof import('../src/config.js')>()
  return {
    ...actual,
    loadSettings: vi.fn(() => ({
      permissions: { allow: [] },
      compactTokens: 200_000,
      costWarnUSD: 2,
      mcpServers: fakeMcpServers,
    })),
  }
})

// ---- mcp mock: use vi.hoisted so the cleanup fn is available before hoisting ----
const { mcpCleanup } = vi.hoisted(() => ({
  mcpCleanup: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/mcp.js', async (orig) => {
  const actual = await orig<typeof import('../src/mcp.js')>()
  return {
    ...actual,
    initMcpTools: vi.fn().mockResolvedValue({ tools: [], cleanup: mcpCleanup }),
  }
})

import { runHeadless } from '../src/headless.js'
import * as mcpModule from '../src/mcp.js'

const usage = { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0 }
beforeEach(() => {
  script.length = 0
  vi.mocked(mcpModule.initMcpTools).mockClear()
  mcpCleanup.mockClear()
})

describe('headless MCP wiring', () => {
  it('calls initMcpTools with configured mcpServers and calls cleanup after loop', async () => {
    script.push({ result: { content: '完成', toolCalls: [], usage, finishReason: 'stop' } })
    await runHeadless({ client: {} as any, prompt: '测试 MCP', yolo: true })

    expect(vi.mocked(mcpModule.initMcpTools)).toHaveBeenCalledOnce()
    const [calledServers] = vi.mocked(mcpModule.initMcpTools).mock.calls[0]
    expect(calledServers).toEqual(fakeMcpServers)
    expect(mcpCleanup).toHaveBeenCalledOnce()
  })

  it('calls cleanup even when runLoop throws', async () => {
    // script exhausted → chatStream throws → generator propagates error
    await expect(runHeadless({ client: {} as any, prompt: '爆炸', yolo: true })).rejects.toThrow()
    expect(mcpCleanup).toHaveBeenCalledOnce()
  })
})
