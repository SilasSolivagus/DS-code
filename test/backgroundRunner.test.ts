// test/backgroundRunner.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// 脚本化的 chatStream（对齐 test/loop.test.ts、test/headless.test.ts 既有 mock 形状）：
// runLoop 通过 src/api.js 的 chatStream 驱动，而非直接调 client.chat.completions.create。
const script: Array<{ result: any }> = []
vi.mock('../src/api.js', () => ({
  chatStream: vi.fn(() =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      return scene.result
    })(),
  ),
}))

const mockSettings = {
  permissions: { allow: [] },
  maxToolResultChars: 100_000,
}
vi.mock('../src/settingsLayers.js', async orig => {
  const actual = await orig<typeof import('../src/settingsLayers.js')>()
  return {
    ...actual,
    loadLayeredSettings: vi.fn(() => ({
      settings: mockSettings,
      provenance: {},
      permissionSources: { allow: {}, deny: {} },
      scopes: [],
    })),
  }
})

import { newSession } from '../src/session.js'
import { writeJobState, readJobState } from '../src/backgroundSession.js'
import { runBackgroundSession } from '../src/backgroundRunner.js'

const usage = { prompt_tokens: 5, completion_tokens: 3, prompt_cache_hit_tokens: 0 }

let tmp: string, sessDir: string
beforeEach(() => {
  script.length = 0
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-bgrun-'))
  process.env.DEEPCODE_TEST_HOME = tmp
  sessDir = path.join(tmp, 'sessions')
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DEEPCODE_TEST_HOME
})

function seedSession(): { file: string; short: string } {
  const h = newSession({ cwd: tmp, model: 'glm-5.2', thinking: false, permMode: 'default' }, sessDir)
  h.appendMessage({ role: 'system', content: 'sys' })
  h.appendMessage({ role: 'user', content: '先前的问题' }, 1)
  const short = path.basename(h.file).replace(/\.jsonl$/, '').slice(0, 8)
  return { file: h.file, short }
}

describe('runBackgroundSession', () => {
  it('resume 会话跑到 done → state completed，新消息落回同一文件', async () => {
    const { file, short } = seedSession()
    writeJobState({
      sessionId: path.basename(file).replace(/\.jsonl$/, ''), short, state: 'working', cwd: tmp,
      name: 'x', pid: process.pid, model: 'glm-5.2', permMode: 'default', sessionFile: file,
      backend: 'detached', createdAt: 1, updatedAt: 1,
    })
    script.push({ result: { content: '后台跑完了', toolCalls: [], usage, finishReason: 'stop' } })
    await runBackgroundSession({ client: {} as any, resumeFile: file, jobShort: short, seed: '继续干' })
    expect(readJobState(short)?.state).toBe('completed')
    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).toContain('继续干')        // seed 落盘
    expect(raw).toContain('后台跑完了')     // assistant 回复落盘
  })

  it('client 抛错 → state failed', async () => {
    const { file, short } = seedSession()
    writeJobState({
      sessionId: path.basename(file).replace(/\.jsonl$/, ''), short, state: 'working', cwd: tmp,
      name: 'x', pid: process.pid, model: 'glm-5.2', permMode: 'default', sessionFile: file,
      backend: 'detached', createdAt: 1, updatedAt: 1,
    })
    // 不 push script → mock chatStream 抛 'script exhausted'（对齐 test/loop.test.ts:717 的异常路径手法）
    await runBackgroundSession({ client: {} as any, resumeFile: file, jobShort: short, seed: 'x' })
    expect(readJobState(short)?.state).toBe('failed')
  })
})
