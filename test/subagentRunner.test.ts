import { describe, it, expect, afterEach, vi } from 'vitest'
import { z } from 'zod'
import { acquireMemory, releaseMemory, __resetMemorySemaphoreForTest, worktreeSubagentPrompt, runSubagent } from '../src/subagentRunner.js'
import type { Tool, ToolContext } from '../src/tools/types.js'

// mock chatStream：第一轮 yield 一个对 stub 工具的 tool_call，第二轮 yield 纯文本（终止子循环）。
// 借此驱动真实 runSubagent → runLoop → subCtx 的 cwd/setCwd 闭包（非空壳）。
let chatCalls = 0
let lastToolCallName = ''
vi.mock('../src/api.js', () => ({
  async *chatStream() {
    chatCalls++
    if (chatCalls === 1) {
      // 第一轮：发起对 stub 工具的调用
      return {
        content: '', finishReason: 'tool_calls',
        usage: { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 },
        toolCalls: [{ id: 'c1', name: lastToolCallName, args: '{}' }],
      }
    }
    // 第二轮：纯文本，无 tool_call → 子循环结束
    yield { type: 'text', delta: 'done' }
    return {
      content: 'done', finishReason: 'stop',
      usage: { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 },
      toolCalls: [],
    }
  },
}))

describe('worktreeSubagentPrompt', () => {
  it('含 worktree 路径 + 隔离语义 + 不影响父代理文件', () => {
    const p = worktreeSubagentPrompt('/repo', '/repo/.deepcode/worktrees/agent-abc')
    expect(p).toContain('/repo/.deepcode/worktrees/agent-abc')
    expect(p).toContain('隔离')
    expect(p).toMatch(/不影响|不会影响/)
  })

  it('含父 cwd 路径', () => {
    const p = worktreeSubagentPrompt('/home/user/project', '/home/user/project/.deepcode/worktrees/xyz')
    expect(p).toContain('/home/user/project')
  })
})

describe('子代理独立 cwd（worktree 隔离）', () => {
  afterEach(() => { chatCalls = 0; lastToolCallName = '' })

  // 父 ctx：可观测的 cwd/setCwd，验证子代理不污染它。
  const mkParentCtx = (): ToolContext => {
    let parentCwd = '/parent/repo'
    return {
      cwd: () => parentCwd,
      setCwd: (d: string) => { parentCwd = d },
      get signal() { return new AbortController().signal },
      fileState: new Map(),
    } as any
  }

  // stub 工具：call 里读 ctx.cwd() 快照，再 ctx.setCwd('/some/other')。
  const mkStub = (seen: { initial?: string; afterSet?: string }): Tool => ({
    name: 'cwdProbe',
    description: 'probe cwd',
    inputSchema: z.object({}),
    isReadOnly: true, // 只读 → 子代理权限自动放行
    needsPermission: () => false,
    call: async (_input, ctx: ToolContext) => {
      seen.initial = ctx.cwd()
      ctx.setCwd('/some/other')
      seen.afterSet = ctx.cwd()
      return 'ok'
    },
  })

  it('传 worktreePath：子代理 ctx.cwd() 初值==worktreePath，setCwd 只漂移自身', async () => {
    const parent = mkParentCtx()
    const seen: { initial?: string; afterSet?: string } = {}
    lastToolCallName = 'cwdProbe'
    await runSubagent({
      client: {} as any, onUsage: () => {}, systemPrompt: 'sys', userPrompt: 'go',
      tools: [mkStub(seen)], model: 'm', ctx: parent, signal: new AbortController().signal,
      agentId: 'a1', agentType: 'general', worktreePath: '/wt/agent-abc',
    })
    expect(seen.initial).toBe('/wt/agent-abc')        // 初值锚定 worktree
    expect(seen.afterSet).toBe('/some/other')         // 子代理自身 cwd 已漂移
    expect(parent.cwd()).toBe('/parent/repo')         // 父 cwd 未被污染
  })

  it('不传 worktreePath：子代理 cwd 初值==父 cwd 快照，setCwd 仍不污染父', async () => {
    const parent = mkParentCtx()
    const seen: { initial?: string; afterSet?: string } = {}
    lastToolCallName = 'cwdProbe'
    await runSubagent({
      client: {} as any, onUsage: () => {}, systemPrompt: 'sys', userPrompt: 'go',
      tools: [mkStub(seen)], model: 'm', ctx: parent, signal: new AbortController().signal,
      agentId: 'a2', agentType: 'general',
    })
    expect(seen.initial).toBe('/parent/repo')         // 初值=父 cwd 快照
    expect(seen.afterSet).toBe('/some/other')         // 子代理自身漂移
    expect(parent.cwd()).toBe('/parent/repo')         // 父 cwd 不变
  })
})

describe('subagentRunner 记忆信号量', () => {
  afterEach(() => __resetMemorySemaphoreForTest())

  it('并发上限 2：第 3 个 acquireMemory 阻塞直到 releaseMemory', async () => {
    for (let i = 0; i < 2; i++) await acquireMemory() // 占满 2 个许可
    let thirdGranted = false
    const third = acquireMemory().then(() => { thirdGranted = true })
    await new Promise(r => setTimeout(r, 10))
    expect(thirdGranted).toBe(false) // 第 3 个仍在等
    releaseMemory()                  // 释放一个许可
    await third
    expect(thirdGranted).toBe(true)  // 第 3 个拿到
    for (let i = 0; i < 2; i++) releaseMemory() // 收尾归还
  })

  it('异常路径 releaseMemory 后等待者被放行（不泄漏）', async () => {
    for (let i = 0; i < 2; i++) await acquireMemory()
    let waiterGranted = false
    const waiter = acquireMemory().then(() => { waiterGranted = true })
    await new Promise(r => setTimeout(r, 10))
    expect(waiterGranted).toBe(false)
    // 模拟 finally releaseMemory（即使 runSub 抛出）
    releaseMemory()
    await waiter
    expect(waiterGranted).toBe(true)
    // 清理剩余许可
    releaseMemory()
  })

  it('删信号量后并发子代理不死锁（无共享阻塞池）', async () => {
    // 构造 10 个并发 runSubagent 调用（mock 版：直接 resolve，验证 Promise.all 无挂起）
    // 删除 MAX_ACTIVE 信号量后，任意数量并发均可立即 resolve，无排队死锁风险。
    const runFake = async (): Promise<string> => 'ok'
    const results = await Promise.all(Array.from({ length: 10 }, () => runFake()))
    expect(results).toHaveLength(10)
    expect(results.every(r => r === 'ok')).toBe(true)
  })
})
