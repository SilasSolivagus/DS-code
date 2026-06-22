// test/loop.steering.test.ts
import { describe, it, expect, vi } from 'vitest'

// 复用 loop.test.ts 的 vi.mock 模式：脚本化 chatStream
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
import { z } from 'zod'

const usage = { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0 }

const echoTool: any = {
  name: 'echo',
  description: '',
  isReadOnly: false,
  needsPermission: () => false,
  inputSchema: z.object({}),
  call: async () => 'ok',
}

function baseDeps(over: Partial<LoopDeps>): LoopDeps {
  return {
    client: {} as any,
    tools: [echoTool],
    model: 'deepseek-v4-flash',
    thinking: false,
    permission: { mode: 'yolo', rules: [], saveRule: () => {}, ask: async () => 'no' },
    ctx: { cwd: () => '/tmp', setCwd: () => {}, signal: new AbortController().signal, fileState: new Map() },
    ...over,
  }
}

async function drain(gen: AsyncGenerator<any, any>) {
  const events: any[] = []
  let r
  while (!(r = await gen.next()).done) events.push(r.value)
  return { events, ret: r.value }
}

describe('loop drainSteering', () => {
  it('tool_result 边界后把 drainSteering 返回项作为 user 消息注入', async () => {
    script.length = 0
    // 脚本：第一轮带工具调用，第二轮无工具调用结束
    script.push(
      {
        result: {
          content: '',
          toolCalls: [{ id: 't1', name: 'echo', args: '{}' }],
          usage,
          finishReason: 'tool_calls',
        },
      },
      { result: { content: 'done', toolCalls: [], usage, finishReason: 'stop' } },
    )

    // drainSteering：只在第一次 drain 时返回一条 steering 消息
    let drained = false
    const messages: any[] = [{ role: 'user', content: 'hi' }]
    const deps = baseDeps({
      drainSteering: () => {
        if (drained) return []
        drained = true
        return ['<queued-user-message>\nX\n</queued-user-message>']
      },
    })

    // 拦截 chatStream 调用以捕获第二轮发送的 messages 参数
    const { chatStream } = await import('../src/api.js')
    const capturedMessages: any[][] = []
    vi.mocked(chatStream).mockImplementationOnce((_client, opts) => {
      capturedMessages.push([...(opts.messages as any[])])
      return (async function* () {
        const scene = script.shift()!
        for (const d of scene.deltas ?? []) yield typeof d === 'string' ? { type: 'text', delta: d } : d
        return scene.result
      })()
    })
    vi.mocked(chatStream).mockImplementationOnce((_client, opts) => {
      capturedMessages.push([...(opts.messages as any[])])
      return (async function* () {
        const scene = script.shift()!
        for (const d of scene.deltas ?? []) yield typeof d === 'string' ? { type: 'text', delta: d } : d
        return scene.result
      })()
    })

    await drain(runLoop(messages, deps))

    // 第二轮（index 1）发送的 messages 应包含 drainSteering 注入的 user 消息
    expect(capturedMessages.length).toBeGreaterThanOrEqual(2)
    const secondCallMessages = capturedMessages[1]
    const steeringMsg = secondCallMessages.find(
      (m: any) => m.role === 'user' && String(m.content).includes('queued-user-message'),
    )
    expect(steeringMsg).toBeTruthy()
  })

  it('drainSteering 缺省时不影响现有行为', async () => {
    script.length = 0
    script.push(
      {
        result: {
          content: '',
          toolCalls: [{ id: 't2', name: 'echo', args: '{}' }],
          usage,
          finishReason: 'tool_calls',
        },
      },
      { result: { content: 'done', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const messages: any[] = [{ role: 'user', content: 'hi' }]
    const deps = baseDeps({}) // 无 drainSteering
    const { events } = await drain(runLoop(messages, deps))
    expect(events.some((e: any) => e.type === 'turn_end')).toBe(true)
  })
})
