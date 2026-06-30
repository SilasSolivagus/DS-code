// test/workflow.journal.test.ts
import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { LocalFileJournal, cachedAgent, optsKeyOf } from '../src/workflow/journal.js'

describe('LocalFileJournal + resume 缓存', () => {
  it('append 后 load 回读', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfj-'))
    const j = new LocalFileJournal(join(dir, 'journal.jsonl'))
    await j.append({ type: 'workflow_agent', index: 0, key: '#0', agentId: 'a0', model: 'm', status: 'ok', prompt: 'p0', optsKey: optsKeyOf({}), result: 'r0' })
    await j.append({ type: 'workflow_log', index: 1, message: 'hi' })
    const recs = await j.load()
    expect(recs).toHaveLength(2)
    expect(recs[0].type).toBe('workflow_agent')
  })
  it('缓存命中：同 结构化 key + 同 (prompt,optsKey) → 返缓存结果', async () => {
    const recs = [{ type: 'workflow_agent', index: 0, key: 'i2/s1#0', agentId: 'a0', model: 'm', status: 'ok', prompt: 'p0', optsKey: optsKeyOf({ label: 'x' }), result: 'cached' }] as any
    const hit = cachedAgent(recs, 'i2/s1#0', 'p0', optsKeyOf({ label: 'x' }))
    expect(hit).toEqual({ hit: true, result: 'cached' })
  })
  it('缓存未命中：key 不同（index 相同也不命中）', async () => {
    const recs = [{ type: 'workflow_agent', index: 0, key: 'i0/s1#0', agentId: 'a0', model: 'm', status: 'ok', prompt: 'p0', optsKey: optsKeyOf({}), result: 'cached' }] as any
    expect(cachedAgent(recs, 'i2/s1#0', 'p0', optsKeyOf({})).hit).toBe(false)
  })
  it('缓存未命中：prompt 变 → miss（从该点 live）', async () => {
    const recs = [{ type: 'workflow_agent', index: 0, key: '#0', agentId: 'a0', model: 'm', status: 'ok', prompt: 'p0', optsKey: optsKeyOf({}), result: 'cached' }] as any
    expect(cachedAgent(recs, '#0', 'CHANGED', optsKeyOf({})).hit).toBe(false)
  })
  it('optsKeyOf 稳定（键序无关）', () => {
    expect(optsKeyOf({ a: 1, b: 2 })).toBe(optsKeyOf({ b: 2, a: 1 }))
  })
})
