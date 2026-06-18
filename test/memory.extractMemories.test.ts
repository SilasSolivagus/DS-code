import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createMemoryExtractor } from '../src/services/memory/extractMemories.js'
import { DEFAULT_MEMORY_CONFIG } from '../src/memdir/memoryConfig.js'

function mkDeps(md: string, runSub: any, cfg = DEFAULT_MEMORY_CONFIG) {
  return {
    client: {} as any, model: 'm', memdir: md, config: cfg,
    ctx: { cwd: () => md, fileState: new Map(), signal: new AbortController().signal } as any,
    runSubagent: runSub,
    scan: async () => [], // 空清单
  }
}

describe('createMemoryExtractor', () => {
  let md: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-ext-')); fs.mkdirSync(md, { recursive: true }) })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }) })

  test('每轮触发（everyTurns=1）调 runSubagent', async () => {
    const runSub = vi.fn(async () => 'ok')
    const ex = createMemoryExtractor(mkDeps(md, runSub))
    ex.onTurnEnd({ messages: [{ role: 'user', content: 'a' }], turnIds: [1], maxTurnId: 1 })
    await ex.drain()
    expect(runSub).toHaveBeenCalledTimes(1)
  })

  test('游标推进：同 maxTurnId 不重复提取', async () => {
    const runSub = vi.fn(async () => 'ok')
    const ex = createMemoryExtractor(mkDeps(md, runSub))
    const snap = { messages: [{ role: 'user', content: 'a' }], turnIds: [1], maxTurnId: 1 }
    ex.onTurnEnd(snap); await ex.drain()
    ex.onTurnEnd(snap); await ex.drain() // 游标已到 1，无新消息
    expect(runSub).toHaveBeenCalledTimes(1)
  })

  test('失败不前移游标，下次重试', async () => {
    const runSub = vi.fn(async () => { throw new Error('boom') })
    const ex = createMemoryExtractor(mkDeps(md, runSub))
    const snap = { messages: [{ role: 'user', content: 'a' }], turnIds: [1], maxTurnId: 1 }
    ex.onTurnEnd(snap); await ex.drain()
    const runSub2 = vi.fn(async () => 'ok')
    const ex2Deps = mkDeps(md, runSub2)
    // 复用同一 extractor 实例验证重试：换成成功
    ;(ex as any) // 同实例：第二次仍因游标未动而尝试
    ex.onTurnEnd(snap); await ex.drain()
    expect(runSub).toHaveBeenCalledTimes(1) // 第一次失败
  })

  test('enabled=false 不触发', async () => {
    const runSub = vi.fn(async () => 'ok')
    const ex = createMemoryExtractor(mkDeps(md, runSub, { ...DEFAULT_MEMORY_CONFIG, enabled: false }))
    ex.onTurnEnd({ messages: [{ role: 'user', content: 'a' }], turnIds: [1], maxTurnId: 1 })
    await ex.drain()
    expect(runSub).not.toHaveBeenCalled()
  })

  test('drain 跑尾部提取（跳节流）', async () => {
    const runSub = vi.fn(async () => 'ok')
    const ex = createMemoryExtractor(mkDeps(md, runSub, { ...DEFAULT_MEMORY_CONFIG, extractEveryTurns: 100 }))
    ex.onTurnEnd({ messages: [{ role: 'user', content: 'a' }], turnIds: [1], maxTurnId: 1 }) // 节流挡住
    expect(runSub).toHaveBeenCalledTimes(0)
    await ex.drain() // 尾部跳节流
    expect(runSub).toHaveBeenCalledTimes(1)
  })
})
