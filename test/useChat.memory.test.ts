// test/useChat.memory.test.ts
// Task 11：验证 useChat 每轮末 fire-and-forget 触发记忆提取
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

import { createChatCore } from '../src/tui/useChat.js'

const usage = { prompt_tokens: 50, completion_tokens: 20, prompt_cache_hit_tokens: 40 }

let sessionDir: string
beforeEach(() => {
  script.length = 0
  vi.clearAllMocks()
  sessionDir = mkdtempSync(path.join(tmpdir(), 'deepcode-mem-test-'))
})

describe('useChat 记忆提取接线', () => {
  it('一轮结束后 extractor.onTurnEnd 触发 runSubagent', async () => {
    script.push({
      deltas: ['好的'],
      result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' },
    })

    const runSub = vi.fn(async () => 'ok')
    const core = createChatCore({
      client: {} as any,
      yolo: true,
      cwd: '/tmp',
      sessionDir,
      onState: () => {},
      runSubagent: runSub,
    })

    await core.send('hi')

    // onTurnEnd 是 fire-and-forget，flush 微任务让 Promise 链跑完
    await new Promise(r => setTimeout(r, 50))

    expect(runSub).toHaveBeenCalled()
    core.dispose()
  })
})
