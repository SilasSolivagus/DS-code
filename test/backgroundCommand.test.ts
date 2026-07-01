// test/backgroundCommand.test.ts —— 7.3 Task4：ChatCore.backgroundSession（门控 + fork + 写 state + spawn 注入）
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

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
// 记忆提取器 fire-and-forget，归零防止消耗 chatStream mock 脚本
vi.mock('../src/subagentRunner.js', async orig => ({ ...(await orig() as any), runSubagent: vi.fn(async () => 'ok') }))

const MOCK_SETTINGS = { permissions: { allow: [] as string[], deny: [] as string[] } }
vi.mock('../src/config.js', async orig => {
  const actual = await orig() as any
  return {
    ...actual,
    loadSettings: () => ({ ...actual.loadSettings(), ...MOCK_SETTINGS }),
    addUserAllowRule: vi.fn(() => []),
    removeUserAllowRule: vi.fn(() => undefined),
    listUserAllowRules: vi.fn(() => []),
    saveRawUserSettings: vi.fn(),
  }
})
vi.mock('../src/settingsLayers.js', async orig => ({
  ...(await orig() as any),
  loadLayeredSettings: () => ({
    settings: { permissions: { allow: [], deny: [] } },
    provenance: {},
    permissionSources: { allow: {}, deny: {} },
    scopes: [],
  }),
}))

import { createChatCore } from '../src/tui/useChat.js'

const usage = { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0 }

let tmp: string
let sessionDir: string
beforeEach(() => {
  script.length = 0
  vi.clearAllMocks()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-bgcmd-'))
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-bgcmd-sessions-'))
  process.env.DEEPCODE_TEST_HOME = tmp
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(sessionDir, { recursive: true, force: true })
  delete process.env.DEEPCODE_TEST_HOME
})

function makeCore(extra: { spawnFn: any }) {
  return createChatCore({
    client: {} as any, yolo: true, cwd: '/proj', sessionDir, onState: () => {},
    spawnFn: extra.spawnFn,
  })
}

describe('backgroundSession core', () => {
  it('空会话拒绝、不 spawn', async () => {
    const spawn = vi.fn()
    const core = makeCore({ spawnFn: spawn })
    const r = await core.backgroundSession()
    expect(r.ok).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('有消息 → fork 文件 + 写 state + spawn argv 正确', async () => {
    const spawn = vi.fn((..._args: any[]) => ({ pid: 5555, unref: () => {} }) as any)
    const core = makeCore({ spawnFn: spawn })
    script.push({ result: { content: '回答', toolCalls: [], usage, finishReason: 'stop' } })
    await core.send('先发一句') // 走 mock client 跑一轮，产生消息

    const before = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'))

    const r = await core.backgroundSession('继续在后台干')
    expect(r.ok).toBe(true)
    expect(spawn).toHaveBeenCalledOnce()
    const argv = spawn.mock.calls[0][1] as string[]
    expect(argv).toContain('--background-run')
    expect(argv).toContain('--job')

    // fork 出的会话文件独立于原会话（原文件不变，多了一个新文件）
    const after = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'))
    expect(after.length).toBe(before.length + 1)

    // state.json 写入 jobs 目录（DEEPCODE_TEST_HOME 隔离）、working、pid 已回填
    const jobsDir = path.join(tmp, '.deepcode', 'jobs')
    const shorts = fs.readdirSync(jobsDir)
    expect(shorts.length).toBe(1)
    const st = JSON.parse(fs.readFileSync(path.join(jobsDir, shorts[0], 'state.json'), 'utf8'))
    expect(st.state).toBe('working')
    expect(st.pid).toBe(5555)
  })
})
