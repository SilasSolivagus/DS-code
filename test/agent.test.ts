import { describe, it, expect, vi, beforeEach } from 'vitest'

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

import { makeAgentTool } from '../src/tools/agent.js'

const usage = { prompt_tokens: 30, completion_tokens: 10, prompt_cache_hit_tokens: 0 }
const ctx = (): any => ({
  cwd: () => process.cwd(), setCwd: () => {}, signal: new AbortController().signal, fileState: new Map(),
})
beforeEach(() => { script.length = 0 })

describe('Agent 子代理', () => {
  it('递归跑 runLoop，返回子代理最终文本，usage 上报', async () => {
    script.push(
      {
        result: {
          content: '', toolCalls: [{ id: 's1', name: 'Glob', args: '{"pattern":"src/*.ts"}' }],
          usage, finishReason: 'tool_calls',
        },
      },
      { result: { content: '共 17 个 TS 文件，入口是 src/index.ts', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const reported: any[] = []
    const tool = makeAgentTool({ client: {} as any, onUsage: (u, m) => reported.push([u, m]) })
    const out = await tool.call({ description: '数文件', prompt: '统计 src 下 TS 文件数量' }, ctx())
    expect(out).toContain('17 个')
    expect(reported.length).toBe(2) // 两轮各上报一次
    expect(reported[0][1]).toBe('deepseek-v4-flash')
  })

  it('子代理只有只读工具，使用独立 fileState', async () => {
    script.push({ result: { content: '结论', toolCalls: [], usage, finishReason: 'stop' } })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {} })
    const c = ctx()
    await tool.call({ description: 'x', prompt: 'y' }, c)
    const { chatStream } = await import('../src/api.js')
    const sentTools = (chatStream as any).mock.calls[0][1].tools.map((t: any) => t.function.name)
    expect(sentTools.sort()).toEqual(['Glob', 'Grep', 'Read'])
    expect(c.fileState.size).toBe(0) // 主 fileState 不被子代理污染
  })

  it('子代理无文本输出时返回兜底文案', async () => {
    script.push({ result: { content: '', toolCalls: [], usage, finishReason: 'stop' } })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {} })
    const out = await tool.call({ description: 'x', prompt: 'y' }, ctx())
    expect(out).toContain('无输出')
  })
})
