// test/compact.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { summarize, rebuildMessages, shouldAutoCompact } from '../src/compact.js'

// 隔离真实 provider 配置：pinning activeFastModel 为 deepseek 档，使测试对 ~/.deepcode/settings.json 免疫
vi.mock('../src/providers.js', async orig => ({
  ...(await orig() as any),
  activeFastModel: () => 'deepseek-v4-flash',
}))

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

const usage = { prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 0 }
beforeEach(() => { script.length = 0 })

describe('summarize', () => {
  it('用 flash 总结对话（剔除 system），返回总结文本与 usage', async () => {
    script.push({ result: { content: '## 总结\n做了 X', toolCalls: [], usage, finishReason: 'stop' } })
    const messages = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '修 bug' },
      { role: 'assistant', content: '修好了' },
    ]
    const r = await summarize({} as any, messages, new AbortController().signal)
    expect(r.summary).toContain('总结')
    expect(r.usage.prompt_tokens).toBe(100)
    expect(r.truncated).toBe(false)
    // 送给总结模型的消息不含 system，且末尾追加了总结指令
    const { chatStream } = await import('../src/api.js')
    const sent = (chatStream as any).mock.calls[0][1].messages
    expect(sent.some((m: any) => m.role === 'system')).toBe(false)
    expect(sent[sent.length - 1].content).toContain('总结')
    expect((chatStream as any).mock.calls[0][1].model).toBe('deepseek-v4-flash')
  })

  it('总结被输出限制截断时返回 truncated: true', async () => {
    script.push({ result: { content: '## 总结\n...超出限制', toolCalls: [], usage, finishReason: 'length' } })
    const messages = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '修 bug' },
      { role: 'assistant', content: '修好了' },
    ]
    const r = await summarize({} as any, messages, new AbortController().signal)
    expect(r.truncated).toBe(true)
  })
})

describe('rebuildMessages', () => {
  const sys = { role: 'system', content: 'SYS' }
  const um = (i: number) => ({ role: 'user', content: `u${i}` })
  const am = (i: number) => ({ role: 'assistant', content: `a${i}` })

  it('重建为 [system, 总结, ...最近 keep 条]，不改原数组', () => {
    const messages = [sys, ...Array.from({ length: 20 }, (_, i) => (i % 2 ? am(i) : um(i)))]
    const before = messages.length
    const out = rebuildMessages(messages, '总结文本', 8)
    expect(messages.length).toBe(before)
    expect(out[0]).toBe(sys)
    expect(out[1].role).toBe('user')
    expect(out[1].content).toContain('总结文本')
    expect(out.length).toBe(1 + 1 + 8)
    expect(out.slice(2)).toEqual(messages.slice(-8))
  })

  it('切口落在 tool 消息上时向前扩到所属 assistant，保证序列合法', () => {
    const asst = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{}' } }] }
    const tool = { role: 'tool', tool_call_id: 'c1', content: 'R' }
    // 末尾 7 条的第一条恰好是 tool —— 必须把 asst 也带上
    const messages = [sys, um(1), am(1), um(2), am(2), um(3), am(3), um(4), asst, tool, um(5), am(5), um(6), am(6), um(7), am(7)]
    const out = rebuildMessages(messages, 'S', 7)
    const tail = out.slice(2)
    expect(tail[0]).toBe(asst)
    expect(tail[0].tool_calls?.[0]?.id).toBe('c1')
    expect(tail[1].role).toBe('tool')
  })

  it('切口落在并行 tool_calls 的多条 tool 中间时也向前扩齐', () => {
    const asst = { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'Read', arguments: '{}' } },
      { id: 'c2', type: 'function', function: { name: 'Read', arguments: '{}' } },
    ] }
    const t1 = { role: 'tool', tool_call_id: 'c1', content: 'R1' }
    const t2 = { role: 'tool', tool_call_id: 'c2', content: 'R2' }
    // keep=3 的切口落在 t2 上：必须连 t1 和 asst 一起带上
    const messages = [sys, um(1), am(1), um(2), asst, t1, t2, um(3), am(3)]
    const out = rebuildMessages(messages, 'S', 3)
    const tail = out.slice(2)
    expect(tail[0]).toBe(asst)
    expect(tail).toEqual([asst, t1, t2, um(3), am(3)])
  })

  it('消息总数不足 keep 时全保留', () => {
    const messages = [sys, um(1), am(1)]
    const out = rebuildMessages(messages, 'S', 8)
    expect(out.length).toBe(1 + 1 + 2)
  })
})

describe('shouldAutoCompact', () => {
  it('预估 > 阈值 且 未达熔断 → true', () => {
    expect(shouldAutoCompact(972_000, 971_000, 0, 3)).toBe(true)
  })
  it('预估 ≤ 阈值 → false', () => {
    expect(shouldAutoCompact(971_000, 971_000, 0, 3)).toBe(false)
  })
  it('达到连续失败上限 → false（熔断）', () => {
    expect(shouldAutoCompact(999_999, 971_000, 3, 3)).toBe(false)
  })
})
