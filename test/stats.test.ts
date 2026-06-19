import { describe, it, expect } from 'vitest'
import { sessionStats, formatStats } from '../src/stats.js'
import type { UsageRecord } from '../src/session.js'

const u = (prompt: number, hit: number, completion: number, model = 'deepseek-v4-flash'): UsageRecord => ({
  usage: { prompt_tokens: prompt, completion_tokens: completion, prompt_cache_hit_tokens: hit },
  model,
})
const uMem = (prompt: number, hit: number, completion: number, model = 'deepseek-v4-flash'): UsageRecord => ({
  usage: { prompt_tokens: prompt, completion_tokens: completion, prompt_cache_hit_tokens: hit },
  model, kind: 'memory',
})

describe('sessionStats', () => {
  it('只有 system：全为 0', () => {
    const s = sessionStats([{ role: 'system', content: 'sys' }], [])
    expect(s).toEqual({
      userTurns: 0, assistantTurns: 0, requests: 0,
      totalToolCalls: 0, toolCounts: [],
      inTokens: 0, hitTokens: 0, outTokens: 0,
    })
  })

  it('单轮 user+assistant：轮数各 1', () => {
    const s = sessionStats(
      [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }],
      [],
    )
    expect(s.userTurns).toBe(1)
    expect(s.assistantTurns).toBe(1)
  })

  it('content=null 的 assistant（带 tool_calls）仍计入助手轮', () => {
    const s = sessionStats(
      [
        { role: 'system', content: 's' },
        { role: 'user', content: 'go' },
        { role: 'assistant', content: null, tool_calls: [{ function: { name: 'Bash', arguments: '{}' } }] },
      ],
      [],
    )
    expect(s.assistantTurns).toBe(1)
    expect(s.userTurns).toBe(1)
  })

  it('多工具调用按首次出现顺序分组计数', () => {
    const s = sessionStats(
      [
        { role: 'system', content: 's' },
        { role: 'user', content: 'q' },
        {
          role: 'assistant', content: null, tool_calls: [
            { function: { name: 'Bash', arguments: '{}' } },
            { function: { name: 'Read', arguments: '{}' } },
            { function: { name: 'Bash', arguments: '{}' } },
          ],
        },
        { role: 'tool', content: 'out' },
        { role: 'assistant', content: null, tool_calls: [{ function: { name: 'Edit', arguments: '{}' } }] },
      ],
      [],
    )
    expect(s.totalToolCalls).toBe(4)
    expect(s.toolCounts).toEqual([
      { name: 'Bash', n: 2 },
      { name: 'Read', n: 1 },
      { name: 'Edit', n: 1 },
    ])
    expect(s.assistantTurns).toBe(2)
  })

  it('token 从 usageLog 求和', () => {
    const s = sessionStats([{ role: 'system', content: 's' }], [u(100, 80, 30), u(200, 150, 40)])
    expect(s.requests).toBe(2)
    expect(s.inTokens).toBe(300)
    expect(s.hitTokens).toBe(230)
    expect(s.outTokens).toBe(70)
  })

  it('kind=memory 记录不计入 token/requests（主对话口径）', () => {
    const s = sessionStats(
      [{ role: 'system', content: 's' }],
      [u(100, 80, 30), uMem(500, 400, 100)],
    )
    // memory 记录过滤：只算普通记录
    expect(s.requests).toBe(1)
    expect(s.inTokens).toBe(100)
    expect(s.hitTokens).toBe(80)
    expect(s.outTokens).toBe(30)
  })

  it('usageLog 空：token 全 0、requests 0', () => {
    const s = sessionStats([{ role: 'system', content: 's' }], [])
    expect(s.requests).toBe(0)
    expect(s.inTokens).toBe(0)
  })

  it('messages 含 null 元素：不抛错，跳过', () => {
    const s = sessionStats(
      [{ role: 'system', content: 's' }, null, { role: 'user', content: 'x' }] as any,
      [],
    )
    expect(s.userTurns).toBe(1)
  })

  it('assistant 无 tool_calls 字段：不计工具', () => {
    const s = sessionStats(
      [{ role: 'system', content: 's' }, { role: 'assistant', content: 'plain' }],
      [],
    )
    expect(s.totalToolCalls).toBe(0)
    expect(s.toolCounts).toEqual([])
  })
})

describe('formatStats', () => {
  const stats = {
    userTurns: 2, assistantTurns: 3, requests: 4,
    totalToolCalls: 6, toolCounts: [{ name: 'Bash', n: 4 }, { name: 'Read', n: 2 }],
    inTokens: 1000, hitTokens: 800, outTokens: 250,
  }

  it('含轮数/工具/token/命中率/花费关键片段', () => {
    const out = formatStats(stats, 0.001234, 0.8)
    expect(out).toContain('2') // user 轮
    expect(out).toContain('3') // assistant 轮
    expect(out).toContain('4') // requests
    expect(out).toContain('Bash×4')
    expect(out).toContain('Read×2')
    expect(out).toContain('1000')
    expect(out).toContain('800')
    expect(out).toContain('250')
    expect(out).toContain('80')      // 命中率百分比
    expect(out).toContain('¥0.001234')
  })

  it('无工具调用：显示 0', () => {
    const out = formatStats({ ...stats, totalToolCalls: 0, toolCounts: [] }, 0, 0)
    expect(out).toContain('工具调用：0')
  })
})
