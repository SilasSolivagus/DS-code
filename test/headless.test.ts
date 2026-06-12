// test/headless.test.ts
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

import { runHeadless } from '../src/headless.js'

const usage = { prompt_tokens: 50, completion_tokens: 20, prompt_cache_hit_tokens: 10 }
beforeEach(() => { script.length = 0 })

describe('runHeadless', () => {
  it('跑完单 prompt 返回最终文本与累计 usage/cost/轮数', async () => {
    script.push(
      {
        result: {
          content: '', toolCalls: [{ id: 'h1', name: 'Glob', args: '{"pattern":"*.md"}' }],
          usage, finishReason: 'tool_calls',
        },
      },
      { result: { content: '找到 1 个 md 文件', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const r = await runHeadless({ client: {} as any, prompt: '有几个 md？', yolo: true })
    expect(r.text).toContain('1 个')
    expect(r.usage.prompt_tokens).toBe(100) // 两轮累计
    expect(r.usage.completion_tokens).toBe(40)
    expect(r.costUSD).toBeGreaterThan(0)
    expect(r.turns).toBe(2)
    expect(r.status).toBe('done')
  })

  it('非 yolo 时权限询问自动拒绝（headless 无人值守）', async () => {
    script.push(
      {
        result: {
          content: '', toolCalls: [{ id: 'h2', name: 'Bash', args: '{"command":"touch /tmp/x"}' }],
          usage, finishReason: 'tool_calls',
        },
      },
      { result: { content: '被拒了', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const r = await runHeadless({ client: {} as any, prompt: '建个文件', yolo: false })
    expect(r.status).toBe('done') // 不挂起、不抛错，拒绝理由按正常机制喂回模型
  })
})
