import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 脚本化的 chatStream：每次调用从 script 取下一幕
const script: Array<{ deltas?: string[]; result: any }> = []
vi.mock('../src/api.js', () => ({
  chatStream: vi.fn(() =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      for (const d of scene.deltas ?? []) yield d
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
})
