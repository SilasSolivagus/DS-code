import { describe, it, expect, beforeEach, vi } from 'vitest'
import { z } from 'zod'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 脚本化的 chatStream：每次调用从 script 取下一幕
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

import { runLoop, type LoopDeps } from '../src/loop.js'
import { readTool } from '../src/tools/read.js'
import {
  registerTask,
  enqueueNotification,
  getTask,
  clearAllTasks,
  drainNotifications,
  type BackgroundTask,
} from '../src/tasks.js'

const usage = { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0 }

function makeDeps(tools: any[]): LoopDeps {
  return {
    client: {} as any,
    tools,
    model: 'deepseek-v4-flash',
    thinking: false,
    permission: { mode: 'yolo', rules: [], saveRule: () => {}, ask: async () => 'no' },
    ctx: { cwd: () => '/tmp', setCwd: () => {}, signal: new AbortController().signal, fileState: new Map() },
  }
}

async function drain(gen: AsyncGenerator<any, any>) {
  const events: any[] = []
  let r
  while (!(r = await gen.next()).done) events.push(r.value)
  return { events, ret: r.value }
}

beforeEach(() => { script.length = 0; clearAllTasks(); drainNotifications() })

// 造一条 completed 后台任务并 enqueue 一条通知
function enqueueCompletedTask(id: string, result = '子代理结果'): void {
  const t: BackgroundTask = {
    id, type: 'local_agent', status: 'completed', description: '后台调查',
    startTime: 0, endTime: 1, outputFile: `/tmp/${id}.log`, outputOffset: 0,
    notified: false, result,
  }
  registerTask(t)
  enqueueNotification(getTask(id)!)
}

describe('runLoop', () => {
  it('工具调用 → 结果回灌 → 第二轮收尾', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-'))
    const f = path.join(dir, 'a.txt')
    writeFileSync(f, 'hello-from-file')
    script.push(
      {
        deltas: ['让我看看'],
        result: {
          content: '让我看看',
          toolCalls: [{ id: 't1', name: 'Read', args: JSON.stringify({ file_path: f }) }],
          usage,
          finishReason: 'tool_calls',
        },
      },
      { deltas: ['内容已读'], result: { content: '内容已读', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const messages: any[] = [{ role: 'system', content: 's' }, { role: 'user', content: '读文件' }]
    const { events, ret } = await drain(runLoop(messages, makeDeps([readTool])))

    expect(ret).toBe('done')
    expect(events.filter(e => e.type === 'text').map(e => e.delta).join('')).toBe('让我看看内容已读')
    expect(events.some(e => e.type === 'tool_start' && e.name === 'Read')).toBe(true)
    const toolMsg = messages.find(m => m.role === 'tool')
    expect(toolMsg.tool_call_id).toBe('t1')
    expect(toolMsg.content).toContain('hello-from-file')
    const asst = messages.find(m => m.role === 'assistant' && m.tool_calls)
    expect(asst.tool_calls[0].function.name).toBe('Read')
  })

  it('未知工具返回错误结果而不是崩溃', async () => {
    script.push(
      {
        result: {
          content: '',
          toolCalls: [{ id: 'x1', name: 'Nope', args: '{}' }],
          usage,
          finishReason: 'tool_calls',
        },
      },
      { result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const messages: any[] = [{ role: 'user', content: 'hi' }]
    const { ret } = await drain(runLoop(messages, makeDeps([readTool])))
    expect(ret).toBe('done')
    expect(messages.find(m => m.role === 'tool').content).toContain('不存在')
  })

  it('参数非法 JSON 返回可自我修正的错误', async () => {
    script.push(
      {
        result: {
          content: '',
          toolCalls: [{ id: 'x2', name: 'Read', args: '{broken' }],
          usage,
          finishReason: 'tool_calls',
        },
      },
      { result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const messages: any[] = [{ role: 'user', content: 'hi' }]
    await drain(runLoop(messages, makeDeps([readTool])))
    expect(messages.find(m => m.role === 'tool').content).toContain('JSON')
  })

  it('权限拒绝时把理由写进工具结果', async () => {
    const { z } = await import('zod')
    const dummy: any = {
      name: 'Bash', isReadOnly: false, needsPermission: () => 'rm -rf /x',
      inputSchema: z.object({}), call: async () => 'should not run',
    }
    script.push(
      {
        result: {
          content: '',
          toolCalls: [{ id: 'x3', name: 'Bash', args: '{}' }],
          usage,
          finishReason: 'tool_calls',
        },
      },
      { result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const deps = makeDeps([dummy])
    deps.permission = { mode: 'default', rules: [], saveRule: () => {}, ask: async () => 'no' }
    const messages: any[] = [{ role: 'user', content: 'hi' }]
    await drain(runLoop(messages, deps))
    expect(messages.find(m => m.role === 'tool').content).toContain('用户拒绝')
  })

  it('maxTurns 熔断', async () => {
    for (let i = 0; i < 3; i++) {
      script.push({
        result: {
          content: '',
          toolCalls: [{ id: `t${i}`, name: 'Glob', args: '{"pattern":"*"}' }],
          usage,
          finishReason: 'tool_calls',
        },
      })
    }
    const { globTool } = await import('../src/tools/glob.js')
    const deps = makeDeps([globTool])
    deps.maxTurns = 3
    const { ret } = await drain(runLoop([{ role: 'user', content: 'hi' }], deps))
    expect(ret).toBe('max_turns')
  })

  it('混合只读+写调用按原始顺序回灌', async () => {
    const { z } = await import('zod')
    const order: string[] = []
    const mk = (name: string, ro: boolean): any => ({
      name, isReadOnly: ro, needsPermission: () => false,
      inputSchema: z.object({}), call: async () => { order.push(name); return `${name}-result` },
    })
    script.push(
      {
        result: {
          content: '',
          toolCalls: [
            { id: 'c1', name: 'RoA', args: '{}' },
            { id: 'c2', name: 'Rw', args: '{}' },
            { id: 'c3', name: 'RoB', args: '{}' },
          ],
          usage, finishReason: 'tool_calls',
        },
      },
      { result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const messages: any[] = [{ role: 'user', content: 'hi' }]
    await drain(runLoop(messages, makeDeps([mk('RoA', true), mk('Rw', false), mk('RoB', true)])))
    const toolMsgs = messages.filter(m => m.role === 'tool')
    expect(toolMsgs.map(m => m.tool_call_id)).toEqual(['c1', 'c2', 'c3'])
    expect(toolMsgs.map(m => m.content)).toEqual(['RoA-result', 'Rw-result', 'RoB-result'])
  })

  it('中断后写工具不执行，且 messages 以收尾 assistant 结束', async () => {
    const { z } = await import('zod')
    const ac = new AbortController()
    let rwRan = false
    const roAborter: any = {
      name: 'Ro', isReadOnly: true, needsPermission: () => false,
      inputSchema: z.object({}), call: async () => { ac.abort(); return 'ro-done' },
    }
    const rwTool: any = {
      name: 'Rw', isReadOnly: false, needsPermission: () => false,
      inputSchema: z.object({}), call: async () => { rwRan = true; return 'rw-done' },
    }
    script.push({
      result: {
        content: '',
        toolCalls: [
          { id: 'a1', name: 'Ro', args: '{}' },
          { id: 'a2', name: 'Rw', args: '{}' },
        ],
        usage, finishReason: 'tool_calls',
      },
    })
    const deps = makeDeps([roAborter, rwTool])
    deps.ctx = { cwd: () => '/tmp', setCwd: () => {}, signal: ac.signal, fileState: new Map() }
    const messages: any[] = [{ role: 'user', content: 'hi' }]
    const { ret } = await drain(runLoop(messages, deps))
    expect(ret).toBe('aborted')
    expect(rwRan).toBe(false)
    expect(messages.find(m => m.tool_call_id === 'a2').content).toContain('中断')
    expect(messages[messages.length - 1].role).toBe('assistant')
  })

  it('finish_reason length 时自动追加续写请求并继续', async () => {
    script.push(
      { deltas: ['前半段'], result: { content: '前半段', toolCalls: [], usage, finishReason: 'length' } },
      { deltas: ['后半段'], result: { content: '后半段', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const messages: any[] = [{ role: 'user', content: '写很长的东西' }]
    const { events, ret } = await drain(runLoop(messages, makeDeps([readTool])))
    expect(ret).toBe('done')
    expect(events.filter(e => e.type === 'text').map(e => e.delta).join('')).toBe('前半段后半段')
    const continueMsg = messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('截断'))
    expect(continueMsg).toBeDefined()
  })

  it('token budget：未达目标→注入续跑 nudge，下一轮达标后 done', async () => {
    const small = { prompt_tokens: 10, completion_tokens: 1000, prompt_cache_hit_tokens: 0 }   // 第1轮远未达标
    const big = { prompt_tokens: 10, completion_tokens: 460_000, prompt_cache_hit_tokens: 0 }   // 第2轮累计达标×90%
    script.push(
      { deltas: ['第一段'], result: { content: '第一段', toolCalls: [], usage: small, finishReason: 'stop' } },
      { deltas: ['第二段'], result: { content: '第二段', toolCalls: [], usage: big, finishReason: 'stop' } },
    )
    const deps = makeDeps([readTool]); deps.tokenBudget = 500_000
    const messages: any[] = [{ role: 'user', content: '大任务 +500k' }]
    const { ret } = await drain(runLoop(messages, deps))
    expect(ret).toBe('done')
    const nudge = messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('token 预算'))
    expect(nudge).toBeDefined() // 第1轮后注入了一次续跑
  })

  it('token budget：达目标×90%→不续跑直接 done', async () => {
    const u = { prompt_tokens: 10, completion_tokens: 460_000, prompt_cache_hit_tokens: 0 }
    script.push({ deltas: ['一大段'], result: { content: '一大段', toolCalls: [], usage: u, finishReason: 'stop' } })
    const deps = makeDeps([readTool]); deps.tokenBudget = 500_000
    const messages: any[] = [{ role: 'user', content: 'do it +500k' }]
    const { ret } = await drain(runLoop(messages, deps))
    expect(ret).toBe('done')
    expect(messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('token 预算'))).toBeUndefined()
  })

  it('token budget：收益递减→续跑≥3 且最近两次小 delta 时熔断停', async () => {
    const big = { prompt_tokens: 10, completion_tokens: 10_000, prompt_cache_hit_tokens: 0 }
    const tiny = { prompt_tokens: 10, completion_tokens: 100, prompt_cache_hit_tokens: 0 }
    // 4 轮：big, big, tiny, tiny —— 第 4 轮后 continuations≥3 且最近两 delta<500 熔断
    script.push(
      { result: { content: 'a', toolCalls: [], usage: big, finishReason: 'stop' } },
      { result: { content: 'b', toolCalls: [], usage: big, finishReason: 'stop' } },
      { result: { content: 'c', toolCalls: [], usage: tiny, finishReason: 'stop' } },
      { result: { content: 'd', toolCalls: [], usage: tiny, finishReason: 'stop' } },
    )
    const deps = makeDeps([readTool]); deps.tokenBudget = 5_000_000 // 高目标，逼熔断而非达标
    const { ret } = await drain(runLoop([{ role: 'user', content: 'x +5m' }], deps))
    expect(ret).toBe('done') // 熔断后正常结束，未跑满 maxTurns
  })

  it('token budget 未设：行为不变（回归，单轮 done）', async () => {
    script.push({ result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' } })
    const { ret } = await drain(runLoop([{ role: 'user', content: 'hi' }], makeDeps([readTool])))
    expect(ret).toBe('done')
  })

  it('reminders 返回非空时，附加到本轮最后一条 tool 消息（不另起消息）', async () => {
    script.push(
      {
        result: {
          content: '', toolCalls: [{ id: 'r1', name: 'Glob', args: '{"pattern":"*"}' }],
          usage, finishReason: 'tool_calls',
        },
      },
      { result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const { globTool } = await import('../src/tools/glob.js')
    const deps = makeDeps([globTool])
    let calls = 0
    deps.reminders = () => { calls++; return calls === 1 ? ['提醒A', '提醒B'] : [] }
    const messages: any[] = [{ role: 'user', content: 'hi' }]
    await drain(runLoop(messages, deps))
    const toolMsgs = messages.filter(m => m.role === 'tool')
    const last = toolMsgs[toolMsgs.length - 1]
    expect(last.content).toContain('<system-reminder>')
    expect(last.content).toContain('提醒A')
    expect(last.content).toContain('提醒B')
    // 没有因 reminder 多出独立消息
    expect(messages.filter(m => m.role === 'user').length).toBe(1)
    // 仅在含工具调用的 turn 调用一次
    expect(calls).toBe(1)
  })

  it('tool_end 事件带毫秒耗时', async () => {
    script.push(
      {
        result: {
          content: '', toolCalls: [{ id: 'm1', name: 'Glob', args: '{"pattern":"*"}' }],
          usage, finishReason: 'tool_calls',
        },
      },
      { result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const { globTool } = await import('../src/tools/glob.js')
    const { events } = await drain(runLoop([{ role: 'user', content: 'hi' }], makeDeps([globTool])))
    const end = events.find(e => e.type === 'tool_end')
    expect(end.ms).toBeTypeOf('number')
    expect(end.ms).toBeGreaterThanOrEqual(0)
  })

  it('tool_end 的 preview 不含 ESC/CR 控制字符（全屏程序输出不污染画面）', async () => {
    const { z } = await import('zod')
    const fullscreen: any = {
      name: 'Bash', isReadOnly: true,
      inputSchema: z.object({}),
      // 模拟贪吃蛇等全屏程序的输出：备用屏切换 + 颜色 + CR
      call: async () => '\x1b[?1049h\x1b[31m蛇头\r\x1b[0m第一行\n第二行',
    }
    script.push(
      {
        result: {
          content: '', toolCalls: [{ id: 's1', name: 'Bash', args: '{}' }],
          usage, finishReason: 'tool_calls',
        },
      },
      { result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const { events } = await drain(runLoop([{ role: 'user', content: 'hi' }], makeDeps([fullscreen])))
    const end = events.find(e => e.type === 'tool_end')
    expect(end.preview).not.toMatch(/\x1b/)
    expect(end.preview).not.toMatch(/\r/)
    expect(end.preview).toContain('第一行')
    expect(end.preview).toContain('第二行') // 多行预览（≤6 行）：两行都显示，但控制字符已剥
    expect(end.previewExtra).toBe(0)        // 共 2 行，未超 6 行上限
  })

  it('tool_end 的 ms 不含权限等待时间', async () => {
    const { z } = await import('zod')
    const slow: any = {
      name: 'Bash', isReadOnly: false, needsPermission: () => 'echo hi',
      inputSchema: z.object({}), call: async () => 'done',
    }
    script.push(
      {
        result: {
          content: '', toolCalls: [{ id: 'p1', name: 'Bash', args: '{}' }],
          usage, finishReason: 'tool_calls',
        },
      },
      { result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const deps = makeDeps([slow])
    deps.permission = {
      mode: 'default', rules: [], saveRule: () => {},
      ask: async () => { await new Promise(r => setTimeout(r, 120)); return 'yes' },
    }
    const { events } = await drain(runLoop([{ role: 'user', content: 'hi' }], deps))
    const end = events.find(e => e.type === 'tool_end')
    expect(end.ok).toBe(true)
    expect(end.ms).toBeLessThan(100) // 120ms 的人工等待不得计入
  })

  it('reasoning delta 透传为带 reasoning 标志的 text 事件', async () => {
    script.push({
      deltas: [{ type: 'reasoning', delta: '思考中' }, '答案'],
      result: { content: '答案', toolCalls: [], usage, finishReason: 'stop' },
    })
    const messages: any[] = [{ role: 'user', content: 'hi' }]
    const { events } = await drain(runLoop(messages, makeDeps([readTool])))
    const r = events.find(e => e.type === 'text' && e.reasoning === true)
    expect(r?.delta).toBe('思考中')
    const plain = events.find(e => e.type === 'text' && !e.reasoning)
    expect(plain?.delta).toBe('答案')
    // reasoning 不进 messages
    expect(messages.find(m => m.role === 'assistant').content).toBe('答案')
  })

  it('终止点有后台通知时：注入 user 消息续跑而非立即结束', async () => {
    const { chatStream } = await import('../src/api.js')
    ;(chatStream as any).mockClear()
    enqueueCompletedTask('atest1234', '调查完成：找到 3 处')
    script.push(
      // 第一幕：模型无工具调用 → 本应结束，但有通知应续跑
      { result: { content: '我先看看', toolCalls: [], usage, finishReason: 'stop' } },
      // 第二幕：模型据通知决策，仍无工具调用、此时无通知 → 正常结束
      { result: { content: '收到通知，已处理', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const deps = makeDeps([readTool])
    deps.injectTaskNotifications = true
    const messages: any[] = [{ role: 'user', content: 'hi' }]
    const { ret } = await drain(runLoop(messages, deps))

    expect(ret).toBe('done')
    // chatStream 被调两次（注入后又发了一轮）
    expect((chatStream as any).mock.calls.length).toBe(2)
    // 注入的 user 消息含 <task-notification>
    const note = messages.find(
      m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('<task-notification>'),
    )
    expect(note).toBeDefined()
    expect(note.content).toContain('atest1234')
    expect(note.content).toContain('completed')
    // 注入 user 消息位于第一条 assistant（我先看看）之后
    const asstIdx = messages.findIndex(m => m.role === 'assistant' && m.content === '我先看看')
    const noteIdx = messages.indexOf(note)
    expect(noteIdx).toBeGreaterThan(asstIdx)
  })

  it('终止点无后台通知时：正常 return done，chatStream 只调一次（回归）', async () => {
    const { chatStream } = await import('../src/api.js')
    ;(chatStream as any).mockClear()
    script.push({ result: { content: '完事', toolCalls: [], usage, finishReason: 'stop' } })
    const deps = makeDeps([readTool])
    deps.injectTaskNotifications = true // 开启注入但队列为空 → 仍正常结束
    const messages: any[] = [{ role: 'user', content: 'hi' }]
    const { ret } = await drain(runLoop(messages, deps))
    expect(ret).toBe('done')
    expect((chatStream as any).mock.calls.length).toBe(1)
    expect(messages.some(m => m.role === 'user' && String(m.content).includes('<task-notification>'))).toBe(false)
  })

  it('持续有通知也不超过 maxTurns（注入受轮数约束，不死循环）', async () => {
    // 每幕模型都无工具调用；每幕之前都再塞一条新通知 → 若无约束会无限续跑
    script.push(
      { result: { content: 'a', toolCalls: [], usage, finishReason: 'stop' } },
      { result: { content: 'b', toolCalls: [], usage, finishReason: 'stop' } },
      { result: { content: 'c', toolCalls: [], usage, finishReason: 'stop' } },
      { result: { content: 'd', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const { chatStream } = await import('../src/api.js')
    ;(chatStream as any).mockClear()
    // 每次 drainNotifications 被调时模拟「又有新任务完成」：用 spy 在每轮塞一条
    enqueueCompletedTask('aloop0001')
    const orig = (chatStream as any).getMockImplementation()
    let n = 0
    ;(chatStream as any).mockImplementation((...args: any[]) => {
      // 在每次发起 API 前确保队列里再有一条新通知（模拟后台不断完成）
      n++
      enqueueCompletedTask(`aloop${String(n).padStart(4, '0')}`)
      return orig(...args)
    })
    const deps = makeDeps([readTool])
    deps.maxTurns = 3
    deps.injectTaskNotifications = true
    const messages: any[] = [{ role: 'user', content: 'hi' }]
    const { ret } = await drain(runLoop(messages, deps))
    ;(chatStream as any).mockImplementation(orig)
    expect(ret).toBe('max_turns')
    // 不无限：调用次数受 maxTurns 约束
    expect((chatStream as any).mock.calls.length).toBe(3)
  })

  it('PreToolUse 配 prompt hook：经 loop 触达 hookDeps.llm，{ok:false} 阻断工具', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-hook-'))
    const f = path.join(dir, 'a.txt'); writeFileSync(f, 'x')
    let called = false
    script.push(
      { result: { content: '', toolCalls: [{ id: 't1', name: 'Read', args: JSON.stringify({ file_path: f }) }], usage, finishReason: 'tool_calls' } },
      { result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const deps = makeDeps([readTool])
    deps.hooks = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'prompt', prompt: '评估 $ARGUMENTS' }] }] } as any
    deps.hookDeps = { llm: async () => { called = true; return '{"ok":false,"reason":"judge 拒绝"}' } }
    const messages: any[] = [{ role: 'system', content: 's' }, { role: 'user', content: '读' }]
    await drain(runLoop(messages, deps))
    expect(called).toBe(true)
    const toolMsg = messages.find(m => m.role === 'tool')
    expect(toolMsg.content).toContain('PreToolUse hook 阻止')
  })
})

// 记录收到入参、固定返回 ORIGINAL 的非只读工具
function recTool() {
  const calls: any[] = []
  const tool = {
    name: 'Rec', description: 'rec',
    inputSchema: z.object({ v: z.string() }),
    isReadOnly: false,
    needsPermission: () => 'rec-desc',
    call: async (input: any) => { calls.push(input); return 'ORIGINAL' },
  }
  return { tool, calls }
}

// 驱动一轮 Rec 工具调用 + 收尾；返回回灌的 tool 消息 content。
async function runOneToolCall(deps: LoopDeps, args = { v: 'orig' }) {
  script.push(
    { result: { content: '', toolCalls: [{ id: 't1', name: 'Rec', args: JSON.stringify(args) }], usage, finishReason: 'tool_calls' } },
    { result: { content: '完', toolCalls: [], usage, finishReason: 'stop' } },
  )
  const messages: any[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'go' }]
  await drain(runLoop(messages, deps))
  return messages.find(m => m.role === 'tool')?.content as string
}

describe('execCall + hooks', () => {
  it('PreToolUse exit 2 → 工具不执行，结果含阻止文案', async () => {
    const { tool, calls } = recTool()
    const deps = makeDeps([tool])
    deps.hooks = { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo 拒绝 1>&2; exit 2' }] }] }
    const content = await runOneToolCall(deps)
    expect(calls.length).toBe(0)
    expect(content).toContain('PreToolUse hook 阻止')
    expect(content).toContain('拒绝')
  })

  it('PreToolUse updatedInput 合法 → 工具收到改写后入参', async () => {
    const { tool, calls } = recTool()
    const deps = makeDeps([tool])
    deps.hooks = { PreToolUse: [{ hooks: [{ type: 'command', command: `printf '%s' '{"hookSpecificOutput":{"updatedInput":{"v":"CHANGED"}}}'` }] }] }
    await runOneToolCall(deps, { v: 'orig' })
    expect(calls[0].v).toBe('CHANGED')
  })

  it('PreToolUse updatedInput 不符合 schema → 拒绝执行', async () => {
    const { tool, calls } = recTool()
    const deps = makeDeps([tool])
    deps.hooks = { PreToolUse: [{ hooks: [{ type: 'command', command: `printf '%s' '{"hookSpecificOutput":{"updatedInput":{"v":123}}}'` }] }] }
    const content = await runOneToolCall(deps)
    expect(calls.length).toBe(0)
    expect(content).toContain('不符合工具 schema')
  })

  it('PreToolUse permission allow → 跳过 ask，工具执行', async () => {
    const { tool, calls } = recTool()
    const ask = vi.fn(async () => 'yes' as const)
    const deps = makeDeps([tool])
    deps.permission = { mode: 'default', rules: [], saveRule: () => {}, ask }
    deps.hooks = { PreToolUse: [{ hooks: [{ type: 'command', command: `printf '%s' '{"hookSpecificOutput":{"permissionDecision":"allow"}}'` }] }] }
    await runOneToolCall(deps)
    expect(ask).not.toHaveBeenCalled()
    expect(calls.length).toBe(1)
  })

  it('PermissionDenied payload 含 tool_input（用户拒绝时）', async () => {
    const { tool, calls } = recTool()
    const deps = makeDeps([tool])
    // mode default + ask 返回 no → checkPermission 落到 onDenied → 触发 PermissionDenied hook
    deps.permission = { mode: 'default', rules: [], saveRule: () => {}, ask: async () => 'no' }
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-pd-'))
    const payloadFile = path.join(dir, 'payload.json')
    // command hook 把 stdin（hook payload JSON）原样落盘，供断言读取
    deps.hooks = { PermissionDenied: [{ hooks: [{ type: 'command', command: `cat > ${payloadFile}` }] }] }
    await runOneToolCall(deps, { v: 'orig' })
    expect(calls.length).toBe(0) // 工具被拒，未执行
    const payload = JSON.parse(readFileSync(payloadFile, 'utf8'))
    expect(payload.hook_event_name).toBe('PermissionDenied')
    expect(payload.tool_name).toBe('Rec')
    expect(payload.tool_input).toEqual({ v: 'orig' })
    rmSync(dir, { recursive: true, force: true })
  })

  it('PostToolUse updatedOutput → 替换工具结果', async () => {
    const { tool } = recTool()
    const deps = makeDeps([tool])
    deps.hooks = { PostToolUse: [{ hooks: [{ type: 'command', command: `printf '%s' '{"hookSpecificOutput":{"updatedOutput":"REPLACED"}}'` }] }] }
    const content = await runOneToolCall(deps)
    expect(content).toBe('REPLACED')
  })

  it('PostToolUse additionalContext → 追加 <hook-context>', async () => {
    const { tool } = recTool()
    const deps = makeDeps([tool])
    deps.hooks = { PostToolUse: [{ hooks: [{ type: 'command', command: `printf '%s' '{"hookSpecificOutput":{"additionalContext":"NOTE"}}'` }] }] }
    const content = await runOneToolCall(deps)
    expect(content).toContain('ORIGINAL')
    expect(content).toContain('<hook-context>')
    expect(content).toContain('NOTE')
  })
})

describe('runLoop + Stop hook', () => {
  it('Stop hook decision:block → 注入 reason 作 user 消息续跑一次', async () => {
    script.push(
      { result: { content: '先到这', toolCalls: [], usage, finishReason: 'stop' } },
      { result: { content: '续跑完成', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const deps = makeDeps([readTool])
    deps.hooks = { Stop: [{ hooks: [{ type: 'command', command: `printf '%s' '{"decision":"block","reason":"还有事没做"}'` }] }] }
    const messages: any[] = [{ role: 'user', content: 'go' }]
    const { ret } = await drain(runLoop(messages, deps))
    expect(ret).toBe('done')
    expect(messages.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('还有事没做'))).toBe(true)
  })

  it('Stop hook 反复 block → 守卫只续跑一次（防无限循环）', async () => {
    // 只放两幕：第一次 done→block→续跑（第二幕）→第二次 done 时 stopHookFired 已 true→不再续跑。
    // 若守卫失效会第三次 shift 空 script 抛 'script exhausted'。
    script.push(
      { result: { content: 'a', toolCalls: [], usage, finishReason: 'stop' } },
      { result: { content: 'b', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const deps = makeDeps([readTool])
    deps.hooks = { Stop: [{ hooks: [{ type: 'command', command: `printf '%s' '{"decision":"block","reason":"再来"}'` }] }] }
    const { ret } = await drain(runLoop([{ role: 'user', content: 'go' }], deps))
    expect(ret).toBe('done')
  })

  it('Stop hook continue:false 与 block 并存 → 硬停优先，不续跑', async () => {
    // 一个 hook continue:false（stop），一个 decision:block（preventContinuation）；合并后 stop 压倒续跑。
    // 仅一幕：若硬停失效会续跑→第二次 shift 空 script 抛 exhausted。
    script.push({ result: { content: 'a', toolCalls: [], usage, finishReason: 'stop' } })
    const deps = makeDeps([readTool])
    deps.hooks = { Stop: [{ hooks: [
      { type: 'command', command: `printf '%s' '{"continue":false}'` },
      { type: 'command', command: `printf '%s' '{"decision":"block","reason":"想续跑"}'` },
    ] }] }
    const { ret } = await drain(runLoop([{ role: 'user', content: 'go' }], deps))
    expect(ret).toBe('done')
  })

  it('未配置 Stop hook → 正常 done，不续跑', async () => {
    script.push({ result: { content: '完成', toolCalls: [], usage, finishReason: 'stop' } })
    const { ret } = await drain(runLoop([{ role: 'user', content: 'go' }], makeDeps([readTool])))
    expect(ret).toBe('done')
  })
})

describe('drainInjections', () => {
  it('工具经 injectUserMessage 注入的内容在 tool 结果后作为 user 消息入队', async () => {
    const buffer: string[] = []
    const injectTool: any = {
      name: 'Inject', description: '', isReadOnly: true,
      inputSchema: z.object({}),
      needsPermission: () => false as const,
      call: async (_i: any, c: any) => { c.injectUserMessage?.('注入的指令'); return '已激活' },
    }
    script.push(
      {
        result: {
          content: '',
          toolCalls: [{ id: 't1', name: 'Inject', args: '{}' }],
          usage,
          finishReason: 'tool_calls',
        },
      },
      { result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const deps = makeDeps([injectTool])
    deps.ctx.injectUserMessage = (c: string) => buffer.push(c)
    deps.drainInjections = () => buffer.splice(0)
    const messages: any[] = [{ role: 'user', content: 'go' }]
    await drain(runLoop(messages, deps))
    // tool 结果后应有一条 user 消息 = 注入内容
    const toolIdx = messages.findIndex(m => m.role === 'tool')
    expect(messages[toolIdx].content).toBe('已激活')
    expect(messages[toolIdx + 1]).toEqual({ role: 'user', content: '注入的指令' })
  })
})

describe('turn_end sentLen', () => {
  it('turn_end 事件带 sentLen = 发送前 messages 长度', async () => {
    script.push({
      result: { content: '回答', toolCalls: [], usage, finishReason: 'stop' },
    })
    const messages: any[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }]
    const { events } = await drain(runLoop(messages, makeDeps([readTool])))
    const te = events.find(e => e.type === 'turn_end')
    expect(te).toBeDefined()
    // 发送时 messages.length = 2（[system, user]）；发送后 assistant push 使 messages.length = 3
    expect(te.sentLen).toBe(2)
    expect(messages.length).toBe(3) // 确认 assistant 已 push
  })

  it('工具调用路径 turn_end 也带正确 sentLen', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-sl-'))
    const f = path.join(dir, 'a.txt')
    writeFileSync(f, 'content')
    script.push(
      {
        result: {
          content: '',
          toolCalls: [{ id: 't1', name: 'Read', args: JSON.stringify({ file_path: f }) }],
          usage,
          finishReason: 'tool_calls',
        },
      },
      { result: { content: '已读', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const messages: any[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'go' }]
    const { events } = await drain(runLoop(messages, makeDeps([readTool])))
    const turnEnds = events.filter(e => e.type === 'turn_end')
    // 第一轮（含工具）：发送时 messages.length=2，sentLen=2
    expect(turnEnds[0].sentLen).toBe(2)
    // 第二轮（收尾）：发送时 messages 包含 [system, user, assistant(tool_calls), tool_result]，sentLen=4
    expect(turnEnds[1].sentLen).toBe(4)
  })
})

describe('runLoop + StopFailure hook', () => {
  it('API 抛错（非中断）→ StopFailure hook 触发后继续抛', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-sf-'))
    const flag = path.join(dir, 'fired.txt')
    // 不 push script → mock chatStream 抛 'script exhausted'，进 catch（signal 未 abort）
    const deps = makeDeps([readTool])
    deps.hooks = { StopFailure: [{ hooks: [{ type: 'command', command: `printf fired > ${flag}` }] }] }
    await expect(drain(runLoop([{ role: 'user', content: 'go' }], deps))).rejects.toThrow()
    expect(existsSync(flag)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('runLoop 前缀稳定性（缓存守卫）', () => {
  it('reminder 注入不修改已存在的前缀消息（缓存守卫）', async () => {
    script.push(
      {
        result: {
          content: '', toolCalls: [{ id: 'g1', name: 'Glob', args: '{"pattern":"*"}' }],
          usage, finishReason: 'tool_calls',
        },
      },
      { result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const { globTool } = await import('../src/tools/glob.js')
    const deps = makeDeps([globTool])
    deps.reminders = () => ['前缀守卫提醒']
    const messages: any[] = [
      { role: 'system', content: 'SYS-PREFIX' },
      { role: 'user', content: 'hi' },
    ]
    await drain(runLoop(messages, deps))
    // 前缀（system / user）字节不变——reminder 不回头改前缀，DeepSeek 自动缓存才命中
    expect(messages[0]).toEqual({ role: 'system', content: 'SYS-PREFIX' })
    expect(messages[1]).toEqual({ role: 'user', content: 'hi' })
    // reminder 只落在最后一条 tool 消息
    const toolMsgs = messages.filter(m => m.role === 'tool')
    expect(toolMsgs[toolMsgs.length - 1].content).toContain('前缀守卫提醒')
  })

  it('超大工具结果按 maxToolResultChars 截断后再回灌 messages（缓存/上下文保护）', async () => {
    const big = 'Z'.repeat(5000)
    const huge = {
      name: 'Huge', isReadOnly: true, needsPermission: () => false,
      inputSchema: z.object({}), call: async () => big,
    }
    script.push(
      { result: { content: '', toolCalls: [{ id: 'h1', name: 'Huge', args: '{}' }], usage, finishReason: 'tool_calls' } },
      { result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const deps = makeDeps([huge as any])
    deps.maxToolResultChars = 200
    const messages: any[] = [{ role: 'user', content: 'hi' }]
    await drain(runLoop(messages, deps))
    const toolMsg = messages.find(m => m.role === 'tool')
    expect(toolMsg.content.length).toBeLessThan(5000)
    expect(toolMsg.content).toContain('已截断')
  })
})
