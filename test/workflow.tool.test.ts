import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeWorkflowTool } from '../src/tools/workflow.js'

describe('Workflow 工具', () => {
  it('name=Workflow, isReadOnly, 后台启动返回 async_launched + runId', async () => {
    const tool = makeWorkflowTool({ client: {} as any, onUsage: () => {}, sessionModel: 'm', agents: [], runSubagent: vi.fn() as any, journalDir: '/tmp/x' })
    expect(tool.name).toBe('Workflow')
    expect(tool.isReadOnly).toBe(true)
    expect(tool.needsPermission({} as any)).toBe(false)
    const out: any = await tool.call({ script: `export const meta={name:'t',description:'d'}\nreturn 1` } as any, { cwd: () => '/', signal: new AbortController().signal } as any)
    expect(out).toMatch(/async_launched/)
    expect(out).toMatch(/wf_/)
  })
})

describe('Workflow 工具 — Fix 1a: 真实 runId', () => {
  const VALID_SCRIPT = `export const meta={name:'t',description:'d'}\nreturn 1`

  it('返回真实 wf_[0-9a-f]{12} runId（非占位符）', async () => {
    const tool = makeWorkflowTool({ client: {} as any, onUsage: () => {}, sessionModel: 'm', agents: [], runSubagent: vi.fn() as any, journalDir: '/tmp/x' })
    const out: any = await tool.call({ script: VALID_SCRIPT } as any, { cwd: () => '/', signal: new AbortController().signal } as any)
    const parsed = JSON.parse(out)
    expect(parsed.runId).toMatch(/^wf_[0-9a-f]{12}$/)
  })

  it('resumeFromRunId 原值透传', async () => {
    const tool = makeWorkflowTool({ client: {} as any, onUsage: () => {}, sessionModel: 'm', agents: [], runSubagent: vi.fn() as any, journalDir: '/tmp/x' })
    const out: any = await tool.call({ script: VALID_SCRIPT, resumeFromRunId: 'wf_aabbccddeeff' } as any, { cwd: () => '/', signal: new AbortController().signal } as any)
    const parsed = JSON.parse(out)
    expect(parsed.runId).toBe('wf_aabbccddeeff')
  })
})

describe('Workflow 工具 — Fix 1b: scriptPath / name 解析', () => {
  const VALID_SCRIPT = `export const meta={name:'t',description:'d'}\nreturn 1`

  it('scriptPath 指向真实文件 → async_launched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-tool-test-'))
    const scriptPath = join(dir, 'mywf.js')
    writeFileSync(scriptPath, VALID_SCRIPT)
    const tool = makeWorkflowTool({ client: {} as any, onUsage: () => {}, sessionModel: 'm', agents: [], runSubagent: vi.fn() as any, journalDir: dir })
    const out: any = await tool.call({ scriptPath } as any, { cwd: () => dir, signal: new AbortController().signal } as any)
    const parsed = JSON.parse(out)
    expect(parsed.status).toBe('async_launched')
  })

  it('name 从 cwd/.deepcode/workflows/<name>.js 解析', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-tool-test-'))
    mkdirSync(join(dir, '.deepcode', 'workflows'), { recursive: true })
    writeFileSync(join(dir, '.deepcode', 'workflows', 'foo.js'), VALID_SCRIPT)
    const tool = makeWorkflowTool({ client: {} as any, onUsage: () => {}, sessionModel: 'm', agents: [], runSubagent: vi.fn() as any, journalDir: dir })
    const out: any = await tool.call({ name: 'foo' } as any, { cwd: () => dir, signal: new AbortController().signal } as any)
    const parsed = JSON.parse(out)
    expect(parsed.status).toBe('async_launched')
  })

  it('scriptPath 指向不存在的文件 → 明确报错（非 meta 错）', async () => {
    const tool = makeWorkflowTool({ client: {} as any, onUsage: () => {}, sessionModel: 'm', agents: [], runSubagent: vi.fn() as any, journalDir: '/tmp/x' })
    await expect(
      tool.call({ scriptPath: '/nonexistent/path/to/wf.js' } as any, { cwd: () => '/', signal: new AbortController().signal } as any)
    ).rejects.toThrow('Workflow script file not found:')
  })
})
