// test/useChat.compactAbort.test.ts
// 既有 bug 修复：doCompact 的 AbortController 此前从不被 abort（无超时 + interrupt 不通）→
// provider（GLM/DeepSeek 皆然，shared 代码）压缩流卡住时 /compact 无限挂起且 ESC 逃不出。
// 本测试验证：① 超时自动 abort → 失败通知不挂起 ② interrupt()（ESC）能中断压缩。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// summarize mock：尊重 signal —— 收到 abort 即 reject(signal.reason)，否则永不 resolve（模拟 provider 卡住的流）。
vi.mock('../src/compact.js', async orig => ({
  ...(await orig() as any),
  summarize: vi.fn((_client: any, _messages: any, signal: AbortSignal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
    })),
}))

import { createChatCore, COMPACT_TIMEOUT_MS } from '../src/tui/useChat.js'

let sessionDir: string
let cwd: string
let settingsPath: string
beforeEach(() => {
  vi.clearAllMocks()
  sessionDir = mkdtempSync(path.join(tmpdir(), 'deepcode-compactabort-session-'))
  cwd = mkdtempSync(path.join(tmpdir(), 'deepcode-compactabort-cwd-'))
  settingsPath = path.join(cwd, 'flag-settings.json')
  writeFileSync(settingsPath, JSON.stringify({})) // 无 hooks，doCompact 直奔 summarize
})
afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

const mkCore = () => createChatCore({
  client: {} as any, yolo: true, cwd, sessionDir, flagSettingsPath: settingsPath,
  onState: () => {}, runSubagent: vi.fn(async () => 'ok'),
})

const errorNotices = (core: ReturnType<typeof mkCore>) =>
  core.state.transcript.filter((t: any) => t.kind === 'notice' && t.level === 'error')

describe('doCompact 中止（超时 + ESC）', () => {
  it('压缩超时 → 自动 abort → 失败通知，不无限挂起', async () => {
    const core = mkCore() // 先建 core（真 timer，buildSystemPrompt 的 new Date 才有效）
    vi.useFakeTimers()    // 再切假 timer，仅用于推进 doCompact 的超时定时器
    try {
      const p = core.send('/compact')
      await vi.advanceTimersByTimeAsync(COMPACT_TIMEOUT_MS + 100)
      await p
      expect(core.state.busy).toBe(false)
      expect(errorNotices(core).some((n: any) => /compact/.test(n.text))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  }, 10_000)

  it('压缩中 interrupt()（ESC）→ 中断压缩 → 失败通知，不挂起', async () => {
    const core = mkCore()
    const p = core.send('/compact')
    await Promise.resolve() // 让 doCompact 跑到 await summarize（compactAbort 已设）
    await Promise.resolve()
    core.interrupt()
    await p
    expect(core.state.busy).toBe(false)
    expect(errorNotices(core).length).toBeGreaterThan(0)
  }, 10_000)
})
