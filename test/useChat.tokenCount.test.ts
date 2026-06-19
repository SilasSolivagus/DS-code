// test/useChat.tokenCount.test.ts
// 2.5 Task7：发送前预估接线集成测试
//  - 验证 estimated = lastPromptTokens + estimateMessagesTokens(自 baseline 起新增) 触发 compact
//  - 验证「一轮 assistant 产出计入下次预估」不变量（baselineLen=sentLen，不含本轮 assistant 输出）
//  - 验证 contextUsed/contextWindow 状态契约
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
// summarize mock：避免真打 API；返回压缩结果，使 doCompact 走完
vi.mock('../src/compact.js', async orig => ({
  ...(await orig() as any),
  summarize: vi.fn(async () => ({
    summary: '历史总结', usage: { prompt_tokens: 5, completion_tokens: 5, prompt_cache_hit_tokens: 0 }, truncated: false,
  })),
}))

import { createChatCore } from '../src/tui/useChat.js'
import { summarize } from '../src/compact.js'
import { effectiveThreshold } from '../src/tokenEstimate.js'

// 240 个 ASCII 字符 → 估算 ceil(240*0.3)=72 token
const BIG = 'x'.repeat(240)
const SMALL = 'ok'

let sessionDir: string
let cwd: string
let settingsPath: string
beforeEach(() => {
  script.length = 0
  vi.clearAllMocks()
  sessionDir = mkdtempSync(path.join(tmpdir(), 'deepcode-tok-session-'))
  cwd = mkdtempSync(path.join(tmpdir(), 'deepcode-tok-cwd-'))
  // compactTokens=100 → effectiveThreshold=min(971000,100)=100，小到便于跨阈值
  settingsPath = path.join(cwd, 'flag-settings.json')
  writeFileSync(settingsPath, JSON.stringify({ compactTokens: 100 }))
})
afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const mkCore = () => createChatCore({
  client: {} as any, yolo: true, cwd, sessionDir, flagSettingsPath: settingsPath,
  onState: () => {}, runSubagent: vi.fn(async () => 'ok'),
})

describe('发送前预估触发 compact', () => {
  it('lastPromptTokens 小但 assistant 大产出使预估跨阈值 → 触发 compact', async () => {
    // usage.prompt_tokens=50 < thr=100：单看 lastPromptTokens 不会触发
    // 但本轮 assistant content=BIG（~72 token）入 messages，自 baseline 起新增被计入
    // estimated = 50 + 72 = 122 > 100 → 触发 compact
    script.push({
      deltas: [BIG],
      result: { content: BIG, toolCalls: [], usage: { prompt_tokens: 50, completion_tokens: 20, prompt_cache_hit_tokens: 0 }, finishReason: 'stop' },
    })
    const core = mkCore()
    await core.send('问题')
    await new Promise(r => setTimeout(r, 30))
    expect(summarize).toHaveBeenCalled()
    core.dispose()
  })

  it('同样 prompt_tokens 但 assistant 产出小 → 不触发 compact（证明计入的是产出而非仅 prompt）', async () => {
    // usage.prompt_tokens=50，assistant content=SMALL（~1 token）
    // estimated = 50 + 1 = 51 < 100 → 不触发
    script.push({
      deltas: [SMALL],
      result: { content: SMALL, toolCalls: [], usage: { prompt_tokens: 50, completion_tokens: 2, prompt_cache_hit_tokens: 0 }, finishReason: 'stop' },
    })
    const core = mkCore()
    await core.send('问题')
    await new Promise(r => setTimeout(r, 30))
    expect(summarize).not.toHaveBeenCalled()
    core.dispose()
  })
})

describe('contextUsed / contextWindow 状态契约', () => {
  it('初始 contextUsed=0，contextWindow=生效阈值', () => {
    const core = mkCore()
    expect(core.state.contextUsed()).toBe(0)
    expect(core.state.contextWindow()).toBe(effectiveThreshold('deepseek-v4-flash', 100))
    core.dispose()
  })

  it('一轮后 contextUsed=上次真实 prompt_tokens', async () => {
    script.push({
      deltas: [SMALL],
      result: { content: SMALL, toolCalls: [], usage: { prompt_tokens: 40, completion_tokens: 2, prompt_cache_hit_tokens: 0 }, finishReason: 'stop' },
    })
    const core = mkCore()
    await core.send('问题')
    expect(core.state.contextUsed()).toBe(40)
    core.dispose()
  })

  it('/model 切换后 contextWindow 跟随当前模型', async () => {
    const core = mkCore()
    // compactTokens=100 始终是更紧上限，切到未知模型派生阈值仍远大于 100 → 仍取 100
    await core.send('/model some-unknown-model')
    expect(core.state.contextWindow()).toBe(effectiveThreshold('some-unknown-model', 100))
    expect(core.state.contextWindow()).toBe(100)
    core.dispose()
  })
})
