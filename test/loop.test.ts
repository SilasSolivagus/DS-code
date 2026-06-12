import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
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

beforeEach(() => { script.length = 0 })

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
})
