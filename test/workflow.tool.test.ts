import { describe, it, expect, vi } from 'vitest'
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
