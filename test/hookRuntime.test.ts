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

describe('makeHookRuntime registerAsync', () => {
  it('返回的 deps 含 registerAsync', () => {
    const deps = makeHookRuntime({ client: {} as any, getModel: () => 'm', cwd: () => '/tmp' })
    expect(typeof deps.registerAsync).toBe('function')
  })
})
