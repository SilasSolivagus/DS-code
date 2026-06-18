import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { runAutoDream, buildConsolidationPrompt } from '../src/services/memory/autoDream.js'
import { DEFAULT_MEMORY_CONFIG } from '../src/memdir/memoryConfig.js'

test('buildConsolidationPrompt 四阶段', () => {
  const p = buildConsolidationPrompt(5)
  expect(p).toMatch(/MEMORY\.md/)
  expect(p).toContain('过时'); expect(p).toContain('200')
})

describe('runAutoDream', () => {
  let md: string, sd: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-dr-')); sd = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-drs-')) })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }); fs.rmSync(sd, { recursive: true, force: true }) })

  test('门控不过 → 不 fork', async () => {
    const runSub = vi.fn(async () => 'ok')
    await runAutoDream({
      client: {} as any, model: 'm', memdir: md, sessionsDir: sd, currentSessionFile: path.join(sd, 'c.jsonl'),
      cfg: DEFAULT_MEMORY_CONFIG.dream, ctx: { signal: new AbortController().signal } as any,
      now: 0, lastScanAt: 0, runSubagent: runSub, gate: () => ({ pass: false }),
    })
    expect(runSub).not.toHaveBeenCalled()
  })

  test('门控过 → 取锁 + fork + 成功更新 mtime', async () => {
    const now = Date.now()
    const runSub = vi.fn(async () => 'done')
    await runAutoDream({
      client: {} as any, model: 'm', memdir: md, sessionsDir: sd, currentSessionFile: path.join(sd, 'c.jsonl'),
      cfg: DEFAULT_MEMORY_CONFIG.dream, ctx: { signal: new AbortController().signal } as any,
      now, lastScanAt: 0, runSubagent: runSub, gate: () => ({ pass: true }), sessionCount: 5,
    })
    expect(runSub).toHaveBeenCalled()
    expect(fs.existsSync(path.join(md, '.consolidate-lock'))).toBe(true)
    const lockStat = fs.statSync(path.join(md, '.consolidate-lock'))
    expect(lockStat.mtimeMs).toBeGreaterThan(0)
  })

  test('fork 失败 → 回退锁（fail-safe，不抛）', async () => {
    const runSub = vi.fn(async () => { throw new Error('x') })
    await expect(runAutoDream({
      client: {} as any, model: 'm', memdir: md, sessionsDir: sd, currentSessionFile: path.join(sd, 'c.jsonl'),
      cfg: DEFAULT_MEMORY_CONFIG.dream, ctx: { signal: new AbortController().signal } as any,
      now: Date.now(), lastScanAt: 0, runSubagent: runSub, gate: () => ({ pass: true }), sessionCount: 5,
    })).resolves.toBeUndefined()
    expect(fs.existsSync(path.join(md, '.consolidate-lock'))).toBe(false)
  })

  test('门控不过 → onStart/onDone 均不调用', async () => {
    const onStart = vi.fn()
    const onDone = vi.fn()
    await runAutoDream({
      client: {} as any, model: 'm', memdir: md, sessionsDir: sd, currentSessionFile: path.join(sd, 'c.jsonl'),
      cfg: DEFAULT_MEMORY_CONFIG.dream, ctx: { signal: new AbortController().signal } as any,
      now: 0, lastScanAt: 0, gate: () => ({ pass: false }), onStart, onDone,
    })
    expect(onStart).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })

  test('门控过，fork 成功 → onStart 取锁后调用，onDone(true) 调用', async () => {
    const runSub = vi.fn(async () => 'done')
    const onStart = vi.fn()
    const onDone = vi.fn()
    await runAutoDream({
      client: {} as any, model: 'm', memdir: md, sessionsDir: sd, currentSessionFile: path.join(sd, 'c.jsonl'),
      cfg: DEFAULT_MEMORY_CONFIG.dream, ctx: { signal: new AbortController().signal } as any,
      now: Date.now(), lastScanAt: 0, runSubagent: runSub, gate: () => ({ pass: true }),
      onStart, onDone,
    })
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledWith(true)
  })

  test('门控过，fork 失败 → onStart 调用，onDone(false) 调用', async () => {
    const runSub = vi.fn(async () => { throw new Error('boom') })
    const onStart = vi.fn()
    const onDone = vi.fn()
    await runAutoDream({
      client: {} as any, model: 'm', memdir: md, sessionsDir: sd, currentSessionFile: path.join(sd, 'c.jsonl'),
      cfg: DEFAULT_MEMORY_CONFIG.dream, ctx: { signal: new AbortController().signal } as any,
      now: Date.now(), lastScanAt: 0, runSubagent: runSub, gate: () => ({ pass: true }),
      onStart, onDone,
    })
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledWith(false)
  })
})
