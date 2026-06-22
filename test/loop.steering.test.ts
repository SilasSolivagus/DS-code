// test/loop.steering.test.ts
import { describe, it, expect, vi } from 'vitest'

// 复用 loop.test.ts 的 vi.mock 模式：脚本化 chatStream
const script: Array<{ deltas?: any[]; result?: any; throw?: any }> = []
// spy 数组记录每次 chatStream 调用传入的 opts.messages
const callMessages: any[][] = []

vi.mock('../src/api.js', () => ({
  chatStream: vi.fn((_client, opts) => {
    callMessages.push([...(opts.messages as any[])])
    return (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      if (scene.throw) throw scene.throw
      for (const d of scene.deltas ?? []) yield typeof d === 'string' ? { type: 'text', delta: d } : d
      return scene.result
    })()
  }),
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
    callMessages.length = 0
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

    await drain(runLoop(messages, deps))

    // 第二轮（index 1）发送的 messages 应包含 drainSteering 注入的 user 消息
    expect(callMessages.length).toBeGreaterThanOrEqual(2)
    const secondCallMessages = callMessages[1]
    expect(secondCallMessages).toBeDefined()
    const steeringMsg = secondCallMessages.find(
      (m: any) => m.role === 'user' && String(m.content).includes('queued-user-message'),
    )
    expect(steeringMsg).toBeTruthy()
  })

  it('drainSteering 缺省时不影响现有行为', async () => {
    script.length = 0
    callMessages.length = 0
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
    // 反向断言：缺省零行为变化，没有 queued-user-message 注入
    const allSentMessages = callMessages.flat()
    expect(
      allSentMessages.some(
        (m: any) => m.role === 'user' && String(m.content).includes('queued-user-message'),
      ),
    ).toBe(false)
  })
})

describe('loop interrupt 软中断', () => {
  it('reason=interrupt：保留进度 + 重建 signal + 注入 steering 续跑（不返回 aborted）', async () => {
    script.length = 0
    callMessages.length = 0

    const abortErr: any = new Error('aborted')
    abortErr.name = 'AbortError'

    // 第一轮：chatStream 抛 AbortError（signal 已 aborted with reason='interrupt'）
    // 第二轮：正常返回
    script.push(
      { throw: abortErr },
      { result: { content: 'redirected', toolCalls: [], usage, finishReason: 'stop' } },
    )

    const ac = { current: new AbortController() }
    ac.current.abort('interrupt')
    let resetCalls = 0
    let drained = false

    const messages: any[] = [{ role: 'user', content: 'hello' }]
    const deps = baseDeps({
      ctx: {
        cwd: () => '/tmp', setCwd: () => {}, fileState: new Map(),
        get signal() { return ac.current.signal },
        resetSignal: () => { resetCalls++; ac.current = new AbortController() },
      },
      drainSteering: () => {
        if (drained) return []
        drained = true
        return ['<queued-user-message>\nGO\n</queued-user-message>']
      },
    })

    const { ret } = await drain(runLoop(messages, deps))

    expect(resetCalls).toBe(1)                   // 重建 signal 一次
    expect(ret).not.toBe('aborted')              // 软中断不终止
    // 续跑那次（第二次调用）的 messages 应包含 drainSteering 注入的 user 消息
    expect(callMessages.length).toBeGreaterThanOrEqual(2)
    const secondCallMessages = callMessages[1]
    expect(secondCallMessages.some((m: any) => String(m.content).includes('queued-user-message'))).toBe(true)
  })

  it('reason=user-cancel：维持现状返回 aborted', async () => {
    script.length = 0
    callMessages.length = 0

    const abortErr: any = new Error('aborted')
    abortErr.name = 'AbortError'

    script.push({ throw: abortErr })

    const ac = new AbortController()
    ac.abort('user-cancel')

    const messages: any[] = [{ role: 'user', content: 'hello' }]
    const deps = baseDeps({
      ctx: {
        cwd: () => '/tmp', setCwd: () => {}, fileState: new Map(),
        get signal() { return ac.signal },
        resetSignal: () => {},
      },
      drainSteering: () => [],
    })

    const { ret } = await drain(runLoop(messages, deps))
    expect(ret).toBe('aborted')
  })
})

describe('loop point-B（mid-tool abort）', () => {
  it('point-B × interrupt：rw 工具跳过 + resetSignal + 注入 steering 续跑（不返回 aborted）', async () => {
    script.length = 0
    callMessages.length = 0

    // 第一幕：chatStream 返回带 toolCalls 的结果（不抛），signal 预先 aborted with reason='interrupt'
    // 第二幕：正常结束
    script.push(
      {
        result: {
          content: '',
          toolCalls: [{ id: 't1', name: 'echo', args: '{}' }],
          usage,
          finishReason: 'tool_calls',
        },
      },
      { result: { content: 'redirected', toolCalls: [], usage, finishReason: 'stop' } },
    )

    const ac = { current: new AbortController() }
    ac.current.abort('interrupt')   // 预先 abort，触发 point-B 路径
    let resetCalls = 0
    let drained = false

    const messages: any[] = [{ role: 'user', content: 'hello' }]
    const deps = baseDeps({
      ctx: {
        cwd: () => '/tmp', setCwd: () => {}, fileState: new Map(),
        get signal() { return ac.current.signal },
        resetSignal: () => { resetCalls++; ac.current = new AbortController() },
      },
      drainSteering: () => {
        if (drained) return []
        drained = true
        return ['<queued-user-message>\nGO\n</queued-user-message>']
      },
    })

    const { ret } = await drain(runLoop(messages, deps))

    expect(ret).not.toBe('aborted')                 // 软中断不终止
    expect(resetCalls).toBe(1)                      // 重建 signal 一次
    expect(callMessages.length).toBeGreaterThanOrEqual(2)
    const secondCallMessages = callMessages[1]
    // 第二轮 messages 应含 role:'tool' 消息（进度保留）
    expect(secondCallMessages.some((m: any) => m.role === 'tool')).toBe(true)
    // 第二轮 messages 应含注入的 queued-user-message
    expect(
      secondCallMessages.some((m: any) => m.role === 'user' && String(m.content).includes('queued-user-message')),
    ).toBe(true)
  })

  it('point-B × user-cancel：返回 aborted', async () => {
    script.length = 0
    callMessages.length = 0

    // 第一幕：返回带 toolCalls 的结果，signal 预先 aborted with reason='user-cancel'
    script.push({
      result: {
        content: '',
        toolCalls: [{ id: 't2', name: 'echo', args: '{}' }],
        usage,
        finishReason: 'tool_calls',
      },
    })

    const ac = new AbortController()
    ac.abort('user-cancel')

    const messages: any[] = [{ role: 'user', content: 'hello' }]
    const deps = baseDeps({
      ctx: {
        cwd: () => '/tmp', setCwd: () => {}, fileState: new Map(),
        get signal() { return ac.signal },
        resetSignal: () => {},
      },
      drainSteering: () => [],
    })

    const { ret } = await drain(runLoop(messages, deps))
    expect(ret).toBe('aborted')
  })
})
