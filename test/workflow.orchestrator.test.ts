// test/workflow.orchestrator.test.ts
import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { mkdtempSync } from 'node:fs'
import { runWorkflow, generateRunId } from '../src/workflow/orchestrator.js'

const script = `export const meta = { name: 't', description: 'd' }
phase('go')
const r = await agent('hello')
return r`

function opts(dir: string, over: any = {}) {
  return {
    script, args: null, runId: undefined, journalDir: dir,
    backend: { runAgent: vi.fn().mockResolvedValue({ status: 'ok', result: 'WORLD' }) },
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    onProgress: () => {}, abortSignal: new AbortController().signal,
    ...over,
  }
}

describe('runWorkflow 端到端', () => {
  it('runId 形如 wf_<12hex>', () => {
    expect(generateRunId(() => Buffer.from('0123456789abcdef', 'hex'))).toMatch(/^wf_[0-9a-f]{12}$/)
  })
  it('跑脚本 → 返回 agent 结果，agents 计数', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfo-'))
    const out = await runWorkflow(opts(dir))
    expect(out.result).toBe('WORLD')
    expect(out.agents).toBe(1)
  })
  it('resume：同 runId 二次跑，backend 不再被调（缓存命中）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfo-'))
    const o1 = opts(dir)
    const r1 = await runWorkflow(o1)
    const o2 = opts(dir, { runId: r1.runId, backend: { runAgent: vi.fn() } })
    const r2 = await runWorkflow(o2)
    expect(r2.result).toBe('WORLD')
    expect(o2.backend.runAgent).not.toHaveBeenCalled()
  })
})
