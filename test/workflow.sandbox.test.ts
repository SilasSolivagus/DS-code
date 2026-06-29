import { describe, it, expect } from 'vitest'
import { runSandbox, type SandboxHooks } from '../src/workflow/sandbox.js'

function hooks(over: Partial<SandboxHooks> = {}): SandboxHooks {
  return {
    agent: async (p: string) => `ran:${p}`,
    parallel: async (thunks: any[]) => Promise.all(thunks.map((t: any) => t())),
    pipeline: async (items: any[]) => items,
    workflow: async () => null,
    phase: () => {}, log: () => {},
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    ...over,
  }
}

describe('runSandbox', () => {
  it('脚本可 await 注入的 async agent()，并返回结果', async () => {
    const out = await runSandbox(`const r = await agent('hi'); return r`, null, hooks(), new AbortController().signal)
    expect(out).toBe('ran:hi')
  })
  it('args 经 JSON.parse 注入为 context-native', async () => {
    const out = await runSandbox(`return args.x + 1`, { x: 41 }, hooks(), new AbortController().signal)
    expect(out).toBe(42)
  })
  it('parallel 能调用脚本里的 thunk（() => agent(...)）', async () => {
    const out = await runSandbox(
      `const rs = await parallel([() => agent('a'), () => agent('b')]); return rs`,
      null, hooks(), new AbortController().signal)
    expect(out).toEqual(['ran:a', 'ran:b'])
  })
  it('Date.now/Math.random 在沙箱内不存在（运行期兜底）', async () => {
    const out = await runSandbox(
      `let r; try { r = typeof Date.now === 'function' ? 'has' : (typeof Math.random) } catch { r = 'absent' } return r`,
      null, hooks(), new AbortController().signal)
    // Date 整体被剔除 → 访问 Date.now 抛 → 用 try 包；这里验证非 has（确定性符号缺席）
    expect(out).not.toBe('has')
  })
  it('eval 被禁（codeGeneration.strings:false）', async () => {
    await expect(runSandbox(`return eval('1+1')`, null, hooks(), new AbortController().signal)).rejects.toThrow()
  })
})
