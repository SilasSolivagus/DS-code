import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clearAllTasks, drainNotifications, listTasks, getTask } from '../src/tasks.js'

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

import { makeAgentTool, subagentPermissionDecision } from '../src/tools/agent.js'

const usage = { prompt_tokens: 30, completion_tokens: 10, prompt_cache_hit_tokens: 0 }
const ctx = (): any => ({
  cwd: () => process.cwd(), setCwd: () => {}, signal: new AbortController().signal, fileState: new Map(),
})
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

  it('子代理只有只读工具，使用独立 fileState', async () => {
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
    // general-purpose 通配 = 全池减全局 deny(Edit/Write/Agent)，含 Bash/WebFetch 等只读检索工具
    const sentTools = (chatStream as any).mock.calls[0][1].tools.map((t: any) => t.function.name)
    expect(sentTools.sort()).toEqual(['Bash', 'Glob', 'Grep', 'Read', 'WebFetch'])
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

  it('子代理抛错时 call 拒绝，且信号量槽位已释放（第二次调用仍成功）', async () => {
    // 脚本为空 → chatStream 抛 'script exhausted' → sub-loop 异常
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    await expect(tool.call({ description: 'err', prompt: 'boom' }, ctx())).rejects.toThrow('script exhausted')

    // 第二次调用要能拿到信号量并正常返回，证明 finally 的 release 执行了
    script.push({ result: { content: '正常结果', toolCalls: [], usage, finishReason: 'stop' } })
    const out = await tool.call({ description: 'ok', prompt: 'ok' }, ctx())
    expect(out).toContain('正常结果')
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

  it('Explore 钉 flash（不受 getModel 影响），且工具集不含 Edit/Write/Agent', async () => {
    script.push({ result: { content: '结论', toolCalls: [], usage, finishReason: 'stop' } })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-pro' })
    await tool.call({ description: 'x', prompt: 'y', subagent_type: 'Explore' }, ctx())
    const { chatStream } = await import('../src/api.js')
    expect((chatStream as any).mock.calls[0][1].model).toBe('deepseek-v4-flash')
    const sentTools = (chatStream as any).mock.calls[0][1].tools.map((t: any) => t.function.name)
    expect(sentTools).not.toContain('Edit')
    expect(sentTools).not.toContain('Write')
    expect(sentTools).not.toContain('Agent')
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

  it('信号量不泄漏：多个后台任务串行跑完不卡', async () => {
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
