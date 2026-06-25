import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clearAllTasks, drainNotifications, listTasks, getTask } from '../src/tasks.js'

// 隔离真实 provider 配置：resolveSubModel 中 'flash'/'smart' 别名走 activeFastModel/activeSmartModel，
// 同时覆盖 resolveSubModel 本身以确保 Explore flash 别名解析到 deepseek 档。
vi.mock('../src/providers.js', async orig => {
  const actual = await orig() as any
  const fastModel = 'deepseek-v4-flash'
  const smartModel = 'deepseek-v4-pro'
  return {
    ...actual,
    activeFastModel: () => fastModel,
    activeSmartModel: () => smartModel,
    resolveSubModel: (alias: string | undefined, parent: string) => {
      if (!alias || alias === 'inherit') return parent
      if (alias === 'flash' || alias === 'fast') return fastModel
      if (alias === 'smart') return smartModel
      return alias
    },
  }
})

const script: Array<{ deltas?: any[]; result: any }> = []
vi.mock('../src/api.js', () => ({
  chatStream: vi.fn(() =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      for (const d of scene.deltas ?? []) yield typeof d === 'string' ? { type: 'text', delta: d } : d
      return scene.result
    })(),
  ),
}))

// subagentRunner mock：worktree 测试控制子代理行为（写文件/不写/抛错）。
// 默认 null = 走真实实现（其余测试照用 chatStream script）。
let subagentRunnerOverride: ((opts: any) => Promise<string>) | null = null
vi.mock('../src/subagentRunner.js', async orig => {
  const actual = await orig() as any
  return {
    ...actual,
    runSubagent: vi.fn(async (opts: any) => {
      if (subagentRunnerOverride) return subagentRunnerOverride(opts)
      return actual.runSubagent(opts)
    }),
  }
})

import { makeAgentTool, subagentPermissionDecision } from '../src/tools/agent.js'
import { BUILTIN_AGENTS } from '../src/tools/agentTypes.js'
import { parseAgentFile } from '../src/agentsLoader.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../src/tools/structuredOutput.js'

const usage = { prompt_tokens: 30, completion_tokens: 10, prompt_cache_hit_tokens: 0 }
const ctx = (): any => ({
  cwd: () => process.cwd(), setCwd: () => {}, signal: new AbortController().signal, fileState: new Map(),
})
const ctxWithHook = (dispatch: any): any => ({
  cwd: () => process.cwd(), setCwd: () => {}, signal: new AbortController().signal, fileState: new Map(),
  hookDispatch: dispatch,
})
const emptyOutcome = { block: false, preventContinuation: false, stop: false, results: [] }
beforeEach(() => { script.length = 0; vi.clearAllMocks(); clearAllTasks(); drainNotifications() })

/** 让脱钩的后台 async 跑完：轮询直到任务进入终态（或超时）。 */
async function waitForDone(id: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const t = getTask(id)
    if (t && t.status !== 'running') return
    await new Promise(r => setTimeout(r, 0))
  }
  throw new Error('timeout waiting for task done')
}

describe('Agent 子代理', () => {
  it('递归跑 runLoop，返回子代理最终文本，usage 上报', async () => {
    script.push(
      {
        result: {
          content: '', toolCalls: [{ id: 's1', name: 'Glob', args: '{"pattern":"src/*.ts"}' }],
          usage, finishReason: 'tool_calls',
        },
      },
      { result: { content: '共 17 个 TS 文件，入口是 src/index.ts', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const reported: any[] = []
    const tool = makeAgentTool({ client: {} as any, onUsage: (u, m) => reported.push([u, m]), getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: '数文件', prompt: '统计 src 下 TS 文件数量' }, ctx())
    expect(out).toContain('17 个')
    expect(reported.length).toBe(2) // 两轮各上报一次
    expect(reported[0][1]).toBe('deepseek-v4-flash')
  })

  it('子代理使用全工具集（可写可递归），使用独立 fileState', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-agent-'))
    const tmpFile = path.join(dir, 'probe.txt')
    writeFileSync(tmpFile, 'probe content')
    // 第一幕：子代理调用 Read 读取文件
    script.push(
      {
        result: {
          content: '',
          toolCalls: [{ id: 'r1', name: 'Read', args: JSON.stringify({ file_path: tmpFile }) }],
          usage,
          finishReason: 'tool_calls',
        },
      },
      // 第二幕：子代理结束
      { result: { content: '结论', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const c = ctx()
    await tool.call({ description: 'x', prompt: 'y' }, c)
    const { chatStream } = await import('../src/api.js')
    // call[0] = 第一幕（子代理发起），call[1] = 第二幕（带 tool 结果）
    // general-purpose 通配 = 全池减全局 deny(仅 ExitPlanMode)，含 Edit/Write/NotebookEdit 可写、含 Agent 可递归
    const sentTools = (chatStream as any).mock.calls[0][1].tools.map((t: any) => t.function.name)
    expect(sentTools.sort()).toEqual(['Agent', 'Bash', 'Config', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'Read', 'WebFetch', 'Write'])
    // 递归门已开：general-purpose 池含 Agent 自身
    expect(sentTools).toContain('Agent')
    // 第二幕的 messages 应包含 Read 的 tool 结果（含文件内容），确保 Read 真正执行了
    const secondCallMessages: any[] = (chatStream as any).mock.calls[1][1].messages
    const toolResultMsg = secondCallMessages.find((m: any) => m.role === 'tool')
    expect(toolResultMsg).toBeDefined()
    expect(toolResultMsg.content).toContain('probe content')
    // 子代理读了文件，但主 ctx 的 fileState 不应被污染
    expect(c.fileState.size).toBe(0)
  })

  it('子代理无文本输出时返回兜底文案', async () => {
    script.push({ result: { content: '', toolCalls: [], usage, finishReason: 'stop' } })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: 'x', prompt: 'y' }, ctx())
    expect(out).toContain('无输出')
  })

  it('子代理抛错时 call 拒绝，第二次调用仍成功', async () => {
    // 脚本为空 → chatStream 抛 'script exhausted' → sub-loop 异常
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    await expect(tool.call({ description: 'err', prompt: 'boom' }, ctx())).rejects.toThrow('script exhausted')

    // 第二次调用应正常返回（无信号量阻塞）
    script.push({ result: { content: '正常结果', toolCalls: [], usage, finishReason: 'stop' } })
    const out = await tool.call({ description: 'ok', prompt: 'ok' }, ctx())
    expect(out).toContain('正常结果')
  })

  it('SubagentStart hook 的 additionalContext 注入子代理上下文', async () => {
    script.push({ result: { content: '已读到注入的上下文', toolCalls: [], usage, finishReason: 'stop' } })
    const seen: any[] = []
    const dispatch = vi.fn(async (event: string, _p: any) => {
      seen.push(event)
      if (event === 'SubagentStart') return { ...emptyOutcome, additionalContext: '注意：只看 src/' }
      return emptyOutcome
    })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: 'x', prompt: '查文件' }, ctxWithHook(dispatch))
    expect(out).toContain('已读到注入的上下文')
    expect(seen).toContain('SubagentStart')
    expect(seen).toContain('SubagentStop')
  })

  it('SubagentStop preventContinuation → 注入 reason 续跑子循环一次', async () => {
    // 两幕：第一次结束→SubagentStop block→续跑→第二次结束（守卫限一次）
    script.push(
      { result: { content: '第一版', toolCalls: [], usage, finishReason: 'stop' } },
      { result: { content: '修订版', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const dispatch = vi.fn(async (event: string, payload: any) => {
      if (event === 'SubagentStop' && payload.stop_hook_active === false) {
        return { ...emptyOutcome, preventContinuation: true, blockReason: '再核对一遍' }
      }
      return emptyOutcome
    })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: 'x', prompt: '审查' }, ctxWithHook(dispatch))
    expect(out).toContain('修订版')
  })

  it('signal 已中断 → 跳过 SubagentStop（不续跑、不 fire Stop）', async () => {
    // 不 push script：子代理 runLoop 首轮 chatStream 抛 exhausted → catch 见 aborted → return 'aborted'。
    const ac = new AbortController(); ac.abort()
    const seen: string[] = []
    const dispatch = vi.fn(async (event: string) => { seen.push(event); return emptyOutcome })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const ctxAborted: any = { cwd: () => process.cwd(), setCwd: () => {}, signal: ac.signal, fileState: new Map(), hookDispatch: dispatch }
    await tool.call({ description: 'x', prompt: 'y' }, ctxAborted)
    expect(seen).toContain('SubagentStart') // Start 在 runLoop 前无条件触发
    expect(seen).not.toContain('SubagentStop') // !signal.aborted 门把 Stop 跳过
  })
})

describe('Agent 子代理类型路由', () => {
  it('省略 subagent_type 默认 general-purpose（model inherit → getModel()）', async () => {
    script.push({ result: { content: '结论', toolCalls: [], usage, finishReason: 'stop' } })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-pro' })
    await tool.call({ description: 'x', prompt: 'y' }, ctx())
    const { chatStream } = await import('../src/api.js')
    expect((chatStream as any).mock.calls[0][1].model).toBe('deepseek-v4-pro')
  })

  it('未知类型抛错含 Available 与类型名', async () => {
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    await expect(tool.call({ description: 'x', prompt: 'y', subagent_type: 'nope' }, ctx())).rejects.toThrow(
      /Agent type 'nope' not found\. Available: .*general-purpose/,
    )
  })

  it('Explore 钉 flash（不受 getModel 影响），且真只读不含 Edit/Write/NotebookEdit/Agent', async () => {
    script.push({ result: { content: '结论', toolCalls: [], usage, finishReason: 'stop' } })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-pro' })
    await tool.call({ description: 'x', prompt: 'y', subagent_type: 'Explore' }, ctx())
    const { chatStream } = await import('../src/api.js')
    expect((chatStream as any).mock.calls[0][1].model).toBe('deepseek-v4-flash')
    const sentTools = (chatStream as any).mock.calls[0][1].tools.map((t: any) => t.function.name)
    expect(sentTools).not.toContain('Edit')
    expect(sentTools).not.toContain('Write')
    expect(sentTools).not.toContain('NotebookEdit') // disallowedTools 含 'NotebookEdit'：Explore 真只读
    expect(sentTools).not.toContain('Agent') // disallowedTools 含 'Agent'：Explore 递归门关闭
  })

  it('Plan 真只读不含 Edit/Write/NotebookEdit/Agent（disallowedTools 拦）', async () => {
    script.push({ result: { content: '结论', toolCalls: [], usage, finishReason: 'stop' } })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-pro' })
    await tool.call({ description: 'x', prompt: 'y', subagent_type: 'Plan' }, ctx())
    const { chatStream } = await import('../src/api.js')
    const sentTools = (chatStream as any).mock.calls[0][1].tools.map((t: any) => t.function.name)
    expect(sentTools).not.toContain('Agent')
    expect(sentTools).not.toContain('Edit')
    expect(sentTools).not.toContain('Write')
    expect(sentTools).not.toContain('NotebookEdit')
  })

  it('子代理 Bash 钳制：安全命令放行、危险命令拒绝', () => {
    expect(subagentPermissionDecision('ls -la')).toBe('yes')
    expect(subagentPermissionDecision('cat src/loop.ts')).toBe('yes')
    expect(subagentPermissionDecision('rm -rf /')).toBe('no')
    expect(subagentPermissionDecision('sudo reboot')).toBe('no')
  })
})

describe('Agent 后台化（run_in_background）', () => {
  it('后台调用立即返回 id 句柄，registry 多一条 running local_agent', async () => {
    // 脚本给一幕，但后台 async 尚未消费 → 调用应在 await 子循环前就返回
    script.push({ result: { content: '后台结果', toolCalls: [], usage, finishReason: 'stop' } })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: '后台调查', prompt: '调查 X', run_in_background: true }, ctx())
    expect(out).toMatch(/id=a[0-9a-z]{8}/)
    const running = listTasks().filter(t => t.type === 'local_agent' && t.status === 'running')
    expect(running.length).toBe(1)
    expect(running[0].description).toBe('后台调查')
    await waitForDone(running[0].id)
  })

  it('脱钩 async 跑完 → completed、result 写入、outputFile 落盘、通知入队', async () => {
    script.push({ result: { content: '最终答案 42', toolCalls: [], usage, finishReason: 'stop' } })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: 'q', prompt: 'p', run_in_background: true }, ctx())
    const id = out.match(/id=(a[0-9a-z]{8})/)![1]
    await waitForDone(id)
    const t = getTask(id)!
    expect(t.status).toBe('completed')
    expect(t.result).toBe('最终答案 42')
    expect(typeof t.endTime).toBe('number')
    expect(existsSync(t.outputFile)).toBe(true)
    expect(readFileSync(t.outputFile, 'utf8')).toBe('最终答案 42')
    const notes = drainNotifications()
    expect(notes.length).toBe(1)
    expect(notes[0].id).toBe(id)
    expect(notes[0].status).toBe('completed')
    expect(notes[0].result).toBe('最终答案 42')
  })

  it('后台子代理抛错 → failed，通知入队', async () => {
    // 空脚本 → chatStream 抛错 → 子循环异常
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: 'boom', prompt: 'p', run_in_background: true }, ctx())
    const id = out.match(/id=(a[0-9a-z]{8})/)![1]
    await waitForDone(id)
    expect(getTask(id)!.status).toBe('failed')
    expect(drainNotifications().map(n => n.id)).toContain(id)
  })

  it('abort 路径 → killed', async () => {
    // 子循环卡住：第一幕给一个工具调用但不给第二幕，让其在等下一帧前可被 abort
    // 更简单：起任务后立刻 abort，再让子循环抛错（脚本空）→ ac.aborted=true → killed
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: 'stopme', prompt: 'p', run_in_background: true }, ctx())
    const id = out.match(/id=(a[0-9a-z]{8})/)![1]
    getTask(id)!.abortController!.abort()
    await waitForDone(id)
    expect(getTask(id)!.status).toBe('killed')
  })

  it('run_in_background → TaskCreated 立即发，后台跑完后 TaskCompleted(completed)', async () => {
    script.push({ result: { content: '后台完成', toolCalls: [], usage, finishReason: 'stop' } })
    const events: Array<{ event: string; payload: any }> = []
    const dispatch = vi.fn(async (event: string, payload: any) => {
      events.push({ event, payload })
      return emptyOutcome
    })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: '后台钩子测试', prompt: 'p', run_in_background: true }, ctxWithHook(dispatch))
    expect(out).toContain('后台子代理已启动')
    expect(events.find(e => e.event === 'TaskCreated')).toBeTruthy()
    const id = out.match(/id=(a[0-9a-z]{8})/)![1]
    await waitForDone(id)
    expect(events.find(e => e.event === 'TaskCompleted')).toBeTruthy()
    expect(events.find(e => e.event === 'TaskCompleted')!.payload.status).toBe('completed')
  })

  it('后台子代理抛错 → TaskCompleted(failed)', async () => {
    // 空脚本 → chatStream 抛错 → failed
    const events: Array<{ event: string; payload: any }> = []
    const dispatch = vi.fn(async (event: string, payload: any) => {
      events.push({ event, payload })
      return emptyOutcome
    })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: '后台失败', prompt: 'p', run_in_background: true }, ctxWithHook(dispatch))
    const id = out.match(/id=(a[0-9a-z]{8})/)![1]
    await waitForDone(id)
    expect(events.find(e => e.event === 'TaskCompleted')!.payload.status).toBe('failed')
  })

  it('后台子代理 abort → TaskCompleted(killed)', async () => {
    const events: Array<{ event: string; payload: any }> = []
    const dispatch = vi.fn(async (event: string, payload: any) => {
      events.push({ event, payload })
      return emptyOutcome
    })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: '后台中止', prompt: 'p', run_in_background: true }, ctxWithHook(dispatch))
    const id = out.match(/id=(a[0-9a-z]{8})/)![1]
    getTask(id)!.abortController!.abort()
    await waitForDone(id)
    expect(events.find(e => e.event === 'TaskCompleted')!.payload.status).toBe('killed')
  })

  it('无 hookDispatch 的 ctx → 后台运行不崩', async () => {
    script.push({ result: { content: '无钩正常', toolCalls: [], usage, finishReason: 'stop' } })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: 'x', prompt: 'p', run_in_background: true }, ctx())
    const id = out.match(/id=(a[0-9a-z]{8})/)![1]
    await waitForDone(id)
    expect(getTask(id)!.status).toBe('completed')
  })

  it('多个后台任务串行跑完不卡', async () => {
    script.push(
      { result: { content: 'r1', toolCalls: [], usage, finishReason: 'stop' } },
      { result: { content: 'r2', toolCalls: [], usage, finishReason: 'stop' } },
      { result: { content: 'r3', toolCalls: [], usage, finishReason: 'stop' } },
      { result: { content: 'r4', toolCalls: [], usage, finishReason: 'stop' } },
      { result: { content: 'r5', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const out = await tool.call({ description: `t${i}`, prompt: 'p', run_in_background: true }, ctx())
      ids.push(out.match(/id=(a[0-9a-z]{8})/)![1])
    }
    for (const id of ids) await waitForDone(id)
    expect(ids.map(id => getTask(id)!.status)).toEqual(['completed', 'completed', 'completed', 'completed', 'completed'])
  })
})

describe('Agent 自定义 agent 路由 (L-040 B)', () => {
  it('deps.agents 含自定义 agent → 可路由', async () => {
    const custom = parseAgentFile('---\nname: my-reviewer\ndescription: 审查\ntools: Read\n---\n你是审查员')!
    script.push({ result: { content: '审查完毕', toolCalls: [], usage, finishReason: 'stop' } })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash', agents: [...BUILTIN_AGENTS, custom] })
    const out = await tool.call({ description: 't', prompt: 'x', subagent_type: 'my-reviewer' }, ctx())
    expect(out).toBe('审查完毕')
  })

  it('无 deps.agents → 退回 BUILTIN_AGENTS（零回归）', async () => {
    script.push({ result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' } })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: 't', prompt: 'x', subagent_type: 'general-purpose' }, ctx())
    expect(out).toBe('ok')
  })
})

describe('Agent 结构化输出强约束 (L-044)', () => {
  const TEST_TYPE = '__l044_test__'
  const testDef = {
    agentType: TEST_TYPE, whenToUse: 'test',
    disallowedTools: ['Edit', 'Write', 'Agent'], model: 'flash' as const,
    outputSchema: z.object({ count: z.number(), note: z.string() }),
    getSystemPrompt: () => '你是测试子代理。',
  }
  beforeEach(() => { BUILTIN_AGENTS.push(testDef) })
  afterEach(() => { const i = BUILTIN_AGENTS.indexOf(testDef); if (i >= 0) BUILTIN_AGENTS.splice(i, 1) })

  it('子代理调用 StructuredOutput → 返回校验后 JSON（非自由文本）', async () => {
    script.push(
      { result: { content: '', toolCalls: [{ id: 'so1', name: STRUCTURED_OUTPUT_TOOL_NAME, args: JSON.stringify({ count: 3, note: '三个' }) }], usage, finishReason: 'tool_calls' } },
      { result: { content: '完成了', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: 't', prompt: '数一下', subagent_type: TEST_TYPE }, ctx())
    expect(JSON.parse(out)).toEqual({ count: 3, note: '三个' })
  })

  it('首轮未调 StructuredOutput → 注入提醒续跑，次轮调了 → 成功', async () => {
    script.push(
      { result: { content: '我直接说答案：3 个', toolCalls: [], usage, finishReason: 'stop' } },
      { result: { content: '', toolCalls: [{ id: 'so1', name: STRUCTURED_OUTPUT_TOOL_NAME, args: JSON.stringify({ count: 3, note: 'x' }) }], usage, finishReason: 'tool_calls' } },
      { result: { content: 'done', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: 't', prompt: '数一下', subagent_type: TEST_TYPE }, ctx())
    expect(JSON.parse(out)).toEqual({ count: 3, note: 'x' })
  })

  it('连续不调 → 重试耗尽后兜底返回末条文本（不死循环）', async () => {
    for (let i = 0; i < 8; i++) script.push({ result: { content: '就是不调工具', toolCalls: [], usage, finishReason: 'stop' } })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: 't', prompt: '数一下', subagent_type: TEST_TYPE }, ctx())
    expect(out).toBe('就是不调工具')
  })

  it('无 outputSchema 的内建 agent → 行为不变（返回末条文本）', async () => {
    script.push({ result: { content: '普通文本结果', toolCalls: [], usage, finishReason: 'stop' } })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: 't', prompt: 'x', subagent_type: 'general-purpose' }, ctx())
    expect(out).toBe('普通文本结果')
  })
})

// ── worktree 辅助 ──────────────────────────────────────────────────────────────
function initGitRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dc-wt-'))
  execSync('git init', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  writeFileSync(path.join(dir, 'README.md'), 'init')
  execSync('git add README.md', { cwd: dir, stdio: 'pipe' })
  execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' })
  return dir
}

describe('Agent isolation:worktree', () => {
  let repo: string
  beforeEach(() => { repo = initGitRepo(); subagentRunnerOverride = null })
  afterEach(() => { subagentRunnerOverride = null; try { rmSync(repo, { recursive: true, force: true }) } catch {} })

  it('子代理写文件→主树不变、worktree 有改动、回传 path+branch', async () => {
    subagentRunnerOverride = async (opts) => {
      // 在 worktreePath 写一个新文件模拟子代理改动
      if (opts.worktreePath) writeFileSync(path.join(opts.worktreePath, 'new-file.ts'), '// new')
      return 'done'
    }
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const c: any = { cwd: () => repo, setCwd: () => {}, signal: new AbortController().signal, fileState: new Map() }
    const out = await tool.call({ description: 't', prompt: 'p', isolation: 'worktree' }, c)
    // 返回文本含 worktree 路径 + 分支名
    expect(out).toContain('[worktree]')
    expect(out).toContain('worktree-agent-')
    expect(out).toContain('done')
    // 主树无新文件
    expect(existsSync(path.join(repo, 'new-file.ts'))).toBe(false)
    // worktree 路径保留（有改动，未删）
    const pathMatch = out.match(/改动保留在 (.+?)（/)
    expect(pathMatch).toBeTruthy()
    const wtPath = pathMatch![1]
    expect(existsSync(path.join(wtPath, 'new-file.ts'))).toBe(true)
  })

  it('子代理无改动→worktree 自动删', async () => {
    subagentRunnerOverride = async (_opts) => 'noop'
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const c: any = { cwd: () => repo, setCwd: () => {}, signal: new AbortController().signal, fileState: new Map() }
    const out = await tool.call({ description: 't', prompt: 'p', isolation: 'worktree' }, c)
    expect(out).not.toContain('[worktree]')
    expect(out).toBe('noop')
    // worktree 目录被删（.deepcode/worktrees/ 无残留）
    const worktreesDir = path.join(repo, '.deepcode', 'worktrees')
    const remaining = existsSync(worktreesDir) ? require('node:fs').readdirSync(worktreesDir) : []
    expect(remaining.length).toBe(0)
  })

  it('非 git 仓库→抛含提示的错误', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'dc-nongit-'))
    subagentRunnerOverride = async () => 'noop'
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const c: any = { cwd: () => tmpDir, setCwd: () => {}, signal: new AbortController().signal, fileState: new Map() }
    await expect(tool.call({ description: 't', prompt: 'p', isolation: 'worktree' }, c)).rejects.toThrow(/git 仓库/)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('isolation:worktree 后台子代理写文件→结果含 path+branch', async () => {
    subagentRunnerOverride = async (opts) => {
      if (opts.worktreePath) writeFileSync(path.join(opts.worktreePath, 'bg-file.ts'), '// bg')
      return 'bg-done'
    }
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const c: any = { cwd: () => repo, setCwd: () => {}, signal: new AbortController().signal, fileState: new Map() }
    const out = await tool.call({ description: 'bg', prompt: 'p', run_in_background: true, isolation: 'worktree' }, c)
    const id = out.match(/id=(a[0-9a-z]{8})/)![1]
    await waitForDone(id)
    const t = getTask(id)!
    expect(t.status).toBe('completed')
    expect(t.result).toContain('[worktree]')
    expect(t.result).toContain('bg-done')
  })
})

describe('Agent 无死锁并发（删 MAX_ACTIVE 信号量后）', () => {
  it('10 个前台子代理并发启动，全部 resolve，无挂起（无共享阻塞池）', async () => {
    // 每个子代理对应一幕脚本：直接返回文本，单轮结束。
    for (let i = 0; i < 10; i++) {
      script.push({ result: { content: `结果${i}`, toolCalls: [], usage, finishReason: 'stop' } })
    }
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    // 并发起 10 个前台 call（若信号量仍存在且上限<10，Promise.all 将死锁；删除后应全部 settle）。
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        tool.call({ description: `并发${i}`, prompt: `任务${i}` }, ctx()),
      ),
    )
    expect(results).toHaveLength(10)
    expect(results.every((r, i) => r === `结果${i}`)).toBe(true)
  })
})
