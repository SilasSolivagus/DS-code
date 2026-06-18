import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const script: Array<{ deltas?: any[]; result: any }> = []
const captured: any[] = []
vi.mock('../src/api.js', async orig => ({
  ...(await orig() as any),
  chatStream: vi.fn((_client: any, opts: any) => {
    captured.push(opts)
    return (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      for (const d of scene.deltas ?? []) yield typeof d === 'string' ? { type: 'text', delta: d } : d
      return scene.result
    })()
  }),
}))

// 记忆提取器/autoDream 在每轮后 fire-and-forget；此处将 runSubagent 归零，防止消耗 chatStream mock 脚本
vi.mock('../src/subagentRunner.js', async orig => ({ ...(await orig() as any), runSubagent: vi.fn(async () => 'ok') }))

import { createChatCore } from '../src/tui/useChat.js'

const usage = { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0 }
let sessionDir: string
beforeEach(() => { script.length = 0; captured.length = 0; vi.clearAllMocks(); sessionDir = mkdtempSync(path.join(tmpdir(), 'dc-eff-')) })

function core() {
  return createChatCore({ client: {} as any, yolo: true, cwd: tmpdir(), sessionDir, onState: () => {} })
}

describe('useChat effort 档位', () => {
  it('默认 medium', () => {
    const c = core()
    expect(c.state.effortLevel).toBe('medium')
    c.dispose()
  })
  it('/effort high 设档 + 开 thinking', async () => {
    const c = core()
    await c.send('/effort high')
    expect(c.state.effortLevel).toBe('high')
    expect(c.state.thinking).toBe(true)
    c.dispose()
  })
  it('/effort off 关 thinking', async () => {
    const c = core()
    await c.send('/effort high')
    await c.send('/effort off')
    expect(c.state.thinking).toBe(false)
    c.dispose()
  })
  it('普通消息把当前 effortLevel 透传给 chatStream', async () => {
    const c = core()
    await c.send('/effort high')
    script.push({ result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' } })
    await c.send('hi')
    expect(captured.at(-1).effortLevel).toBe('high')
    expect(captured.at(-1).thinking).toBe(true)
    c.dispose()
  })
  it('关键词 ultrathink 本轮临时升 high，不改持久档', async () => {
    const c = core() // 默认 medium、thinking off
    script.push({ result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' } })
    await c.send('ultrathink 修这个 bug')
    expect(captured.at(-1).effortLevel).toBe('high')
    expect(captured.at(-1).thinking).toBe(true)
    expect(c.state.effortLevel).toBe('medium') // 持久档不变
    c.dispose()
  })
})
