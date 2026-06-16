// test/useChat.hooks.test.ts —— L-042 ①b-1：useChat 自有事件（mock runHooks 注入受控 outcome）
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const script: Array<{ deltas?: any[]; result: any }> = []
vi.mock('../src/api.js', async orig => ({
  ...(await orig() as any),
  chatStream: vi.fn(() =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      for (const d of scene.deltas ?? []) yield typeof d === 'string' ? { type: 'text', delta: d } : d
      return scene.result
    })(),
  ),
}))

// 受控 runHooks：按 event 返回测试设定的 outcome；记录每次调用。
const emptyOutcome = { block: false, preventContinuation: false, stop: false, results: [] }
const hookCalls: Array<{ event: string; payload: any }> = []
let hookImpl: (event: string, payload: any) => any = () => emptyOutcome
vi.mock('../src/hooks.js', async orig => ({
  ...(await orig() as any),
  runHooks: vi.fn(async (event: string, payload: any) => { hookCalls.push({ event, payload }); return hookImpl(event, payload) }),
}))

// mock config：注入非空 settings.hooks，使 useChat/headless 的 `if (settings.hooks)` 守卫通过
// （守卫与 loop.ts 一致——未配 hooks 时不引入额外 await）。runHooks 已被 mock，hooks 内容仅需 truthy。
vi.mock('../src/config.js', async orig => {
  const actual = await orig() as any
  return {
    ...actual,
    loadSettings: () => ({ ...actual.loadSettings(), hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'true' }] }] } }),
  }
})

import { createChatCore } from '../src/tui/useChat.js'

const usage = { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0 }
let sessionDir: string
beforeEach(() => {
  script.length = 0
  hookCalls.length = 0
  hookImpl = () => emptyOutcome
  vi.clearAllMocks()
  sessionDir = mkdtempSync(path.join(tmpdir(), 'deepcode-hooks-'))
})

describe('useChat UserPromptSubmit hook', () => {
  it('正常输入 → UserPromptSubmit 以 prompt 文本触发，照常跑', async () => {
    script.push({ result: { content: '回答', toolCalls: [], usage, finishReason: 'stop' } })
    const core = createChatCore({ client: {} as any, yolo: true, cwd: process.cwd(), sessionDir, onState: () => {} })
    await core.send('你好世界')
    const ups = hookCalls.find(c => c.event === 'UserPromptSubmit')
    expect(ups).toBeTruthy()
    expect(ups!.payload.prompt).toContain('你好世界')
  })

  it('UserPromptSubmit block → 拦截本次输入，不发起 API', async () => {
    script.push({ result: { content: '不应出现', toolCalls: [], usage, finishReason: 'stop' } })
    hookImpl = (event) => event === 'UserPromptSubmit'
      ? { ...emptyOutcome, block: true, blockReason: '含敏感词' }
      : emptyOutcome
    const core = createChatCore({ client: {} as any, yolo: true, cwd: process.cwd(), sessionDir, onState: () => {} })
    await core.send('泄密内容')
    // 未发起 API：script 未被消费
    expect(script.length).toBe(1)
  })
})
