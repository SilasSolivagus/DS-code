// test/workflow.nesting.test.ts
import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { runWorkflow } from '../src/workflow/orchestrator.js'

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wf-nest-'))
  mkdirSync(join(dir, '.deepcode', 'workflows'), { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, '.deepcode', 'workflows', `${name}.js`), body)
  }
  return dir
}

function opts(dir: string, script: string, over: any = {}) {
  return {
    script, args: null, runId: undefined, cwd: dir, journalDir: dir,
    backend: { runAgent: vi.fn().mockResolvedValue({ status: 'ok', result: 'A' }) },
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    onProgress: () => {}, abortSignal: new AbortController().signal,
    ...over,
  }
}

describe('workflow() 嵌套组合', () => {
  it('父调子（named）→ 子 agent 结果可用，且父 agentCount 含子 agent（共享计数）', async () => {
    const dir = project({
      child: `export const meta = { name: 'child', description: 'd' }\nconst r = await agent('child-prompt')\nreturn { child: r }`,
    })
    const parent = `export const meta = { name: 'parent', description: 'd' }
const p = await agent('parent-prompt')
const c = await workflow('child')
return { p, c }`
    const out = await runWorkflow(opts(dir, parent))
    expect(out.result).toEqual({ p: 'A', c: { child: 'A' } })
    // 共享计数：父 1 个 agent + 子 1 个 agent = 2
    expect(out.agents).toBe(2)
  })

  it('子再调 workflow() → 抛 verbatim 一层限制', async () => {
    const dir = project({
      child: `export const meta = { name: 'child', description: 'd' }\nreturn await workflow('grand')`,
      grand: `export const meta = { name: 'grand', description: 'd' }\nreturn 1`,
    })
    const parent = `export const meta = { name: 'parent', description: 'd' }\nreturn await workflow('child')`
    await expect(runWorkflow(opts(dir, parent))).rejects.toThrow('Nesting is one level only: workflow() inside a child throws.')
  })

  it('子内经 parallel 调 workflow() → 仍抛一层限制（depth 透传）', async () => {
    const dir = project({
      child: `export const meta = { name: 'child', description: 'd' }\nconst r = await parallel([() => workflow('grand')])\nreturn r`,
      grand: `export const meta = { name: 'grand', description: 'd' }\nreturn 1`,
    })
    const parent = `export const meta = { name: 'parent', description: 'd' }\nreturn await workflow('child')`
    // parallel 把 thunk throw 降为 null，但若 depth 未透传则子会真的去加载 grand 并成功 → 结果非 null。
    // 断言：grand 从未被加载执行（无 grand agent），结果为 [null]。
    const out = await runWorkflow(opts(dir, parent))
    expect(out.result).toEqual([null])
  })

  it('未知 name → 抛清晰 not-found', async () => {
    const dir = project({})
    const parent = `export const meta = { name: 'parent', description: 'd' }\nreturn await workflow('does-not-exist')`
    await expect(runWorkflow(opts(dir, parent))).rejects.toThrow('Workflow not found: does-not-exist')
  })
})
