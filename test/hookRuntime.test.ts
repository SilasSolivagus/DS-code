import { describe, it, expect, vi } from 'vitest'

const script: Array<{ deltas?: any[]; result: any }> = []
vi.mock('../src/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/api.js')>()
  return { ...actual, chatStream: vi.fn(() => (async function* () {
    const scene = script.shift(); if (!scene) throw new Error('script exhausted')
    for (const d of scene.deltas ?? []) yield typeof d === 'string' ? { type: 'text', delta: d } : d
    return scene.result
  })()) }
})

import { makeHookRuntime } from '../src/hookRuntime.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../src/tools/structuredOutput.js'

const usage = { prompt_tokens: 1, completion_tokens: 1, prompt_cache_hit_tokens: 0 }

describe('makeHookRuntime.llm', () => {
  it('单轮：把 prompt 作 user 消息发 chatStream，返回 content', async () => {
    script.length = 0
    script.push({ result: { content: '{"ok":true}', toolCalls: [], usage, finishReason: 'stop' } })
    const rt = makeHookRuntime({ client: {} as any, getModel: () => 'deepseek-v4-flash', cwd: () => process.cwd() })
    const text = await rt.llm!('评估这个', undefined, new AbortController().signal)
    expect(text).toBe('{"ok":true}')
  })
})

describe('makeHookRuntime.runAgent 结构化输出 (L-044)', () => {
  it('hook 子代理调 StructuredOutput({ok:false,reason}) → runAgent 返回该 JSON 串', async () => {
    script.length = 0
    script.push(
      { result: { content: '', toolCalls: [{ id: 'so1', name: STRUCTURED_OUTPUT_TOOL_NAME, args: JSON.stringify({ ok: false, reason: '不达标' }) }], usage, finishReason: 'tool_calls' } },
      { result: { content: 'done', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const rt = makeHookRuntime({ client: {} as any, getModel: () => 'deepseek-v4-flash', cwd: () => process.cwd() })
    const text = await rt.runAgent!('核查', undefined, new AbortController().signal)
    expect(JSON.parse(text)).toEqual({ ok: false, reason: '不达标' })
  })

  it('hook 子代理始终不调 → 重试耗尽兜底返回末条文本（parseHookEvalResult 端 fail-safe）', async () => {
    script.length = 0
    for (let i = 0; i < 8; i++) script.push({ result: { content: '自由文本结论', toolCalls: [], usage, finishReason: 'stop' } })
    const rt = makeHookRuntime({ client: {} as any, getModel: () => 'deepseek-v4-flash', cwd: () => process.cwd() })
    const text = await rt.runAgent!('核查', undefined, new AbortController().signal)
    expect(text).toBe('自由文本结论')
  })
})

describe('makeHookRuntime registerAsync', () => {
  it('返回的 deps 含 registerAsync', () => {
    const deps = makeHookRuntime({ client: {} as any, getModel: () => 'm', cwd: () => '/tmp' })
    expect(typeof deps.registerAsync).toBe('function')
  })
})
