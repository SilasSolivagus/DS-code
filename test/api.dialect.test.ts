import { describe, it, expect } from 'vitest'
import { Assembler } from '../src/api.js'

describe('Assembler usage 归一', () => {
  it('deepseek dialect 读顶层 prompt_cache_hit_tokens', () => {
    const a = new Assembler('deepseek')
    a.push({ usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 40 }, choices: [] })
    expect(a.finish().usage.prompt_cache_hit_tokens).toBe(40)
  })
  it('glm dialect 读嵌套 prompt_tokens_details.cached_tokens 归一', () => {
    const a = new Assembler('glm')
    a.push({ usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 25 } }, choices: [] })
    expect(a.finish().usage.prompt_cache_hit_tokens).toBe(25)
  })
  it('openai dialect 无缓存字段 → 0', () => {
    const a = new Assembler('openai')
    a.push({ usage: { prompt_tokens: 100, completion_tokens: 10 }, choices: [] })
    expect(a.finish().usage.prompt_cache_hit_tokens).toBe(0)
  })
  it('缺省构造器 = deepseek', () => {
    const a = new Assembler()
    a.push({ usage: { prompt_tokens: 1, completion_tokens: 1, prompt_cache_hit_tokens: 1 }, choices: [] })
    expect(a.finish().usage.prompt_cache_hit_tokens).toBe(1)
  })
})

describe('buildThinkingParams 三态', () => {
  it('supportsThinking=false → 空对象（不发 thinking/reasoning_effort）', async () => {
    const { buildThinkingParams } = await import('../src/api.js')
    expect(buildThinkingParams(false, true, 'low')).toEqual({})
    expect(buildThinkingParams(false, false, 'low')).toEqual({})
  })
  it('supportsThinking=true + thinking 开 → enabled + reasoning_effort', async () => {
    const { buildThinkingParams } = await import('../src/api.js')
    expect(buildThinkingParams(true, true, 'high')).toEqual({ reasoning_effort: 'high', thinking: { type: 'enabled' } })
  })
  it('supportsThinking=true + thinking 关 → disabled', async () => {
    const { buildThinkingParams } = await import('../src/api.js')
    expect(buildThinkingParams(true, false, undefined)).toEqual({ thinking: { type: 'disabled' } })
  })
})
