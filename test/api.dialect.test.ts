import { describe, it, expect } from 'vitest'
import { Assembler, chatStream } from '../src/api.js'

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

function fakeClient(captured: any[]) {
  return {
    chat: {
      completions: {
        create: async (payload: any) => {
          captured.push(payload)
          return (async function* () {
            yield {
              choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }
          })()
        },
      },
    },
  } as any
}

describe('chatStream thinking 字段不泄漏', () => {
  const drain = async (gen: AsyncGenerator<any, any>) => {
    let s = await gen.next()
    while (!s.done) s = await gen.next()
    return s.value
  }

  it('supportsThinking=false → payload 不含 thinking/reasoning_effort', async () => {
    const cap: any[] = []
    await drain(
      chatStream(fakeClient(cap), {
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
        thinking: true,
        signal: new AbortController().signal,
        dialect: 'openai',
        supportsThinking: false,
      }),
    )
    expect(cap[0]).not.toHaveProperty('thinking')
    expect(cap[0]).not.toHaveProperty('reasoning_effort')
  })

  it('supportsThinking=true + thinking → payload 含 thinking enabled + reasoning_effort', async () => {
    const cap: any[] = []
    await drain(
      chatStream(fakeClient(cap), {
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
        thinking: true,
        effortLevel: 'high',
        signal: new AbortController().signal,
        dialect: 'deepseek',
        supportsThinking: true,
      }),
    )
    expect(cap[0].thinking).toEqual({ type: 'enabled' })
    expect(cap[0].reasoning_effort).toBe('high')
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
