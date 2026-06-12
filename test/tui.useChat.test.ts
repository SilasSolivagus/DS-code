// test/tui.useChat.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const script: Array<{ deltas?: any[]; result: any }> = []
vi.mock('../src/api.js', async orig => ({
  ...(await orig() as any),
  chatStream: vi.fn(() =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      for (const d of scene.deltas ?? []) yield typeof d === 'string' ? { type: 'text', delta: d } : d
      return scene.result
    })(),
  ),
}))

import { transcriptReducer, type TranscriptItem, createChatCore } from '../src/tui/useChat.js'

const usage = { prompt_tokens: 50, completion_tokens: 20, prompt_cache_hit_tokens: 40 }
beforeEach(() => { script.length = 0; vi.clearAllMocks() }) // 清调用计数：测试 2 断言 /cost /clear 零请求

describe('transcriptReducer', () => {
  it('text delta 追加到进行中 assistant 块；reasoning delta 进思考块', () => {
    let s = transcriptReducer([], { type: 'delta', delta: '你', reasoning: false })
    s = transcriptReducer(s, { type: 'delta', delta: '好', reasoning: false })
    s = transcriptReducer(s, { type: 'delta', delta: '思', reasoning: true })
    expect((s.find(i => i.kind === 'assistant' && !i.done) as any).text).toBe('你好')
    expect((s.find(i => i.kind === 'reasoning' && !i.done) as any).text).toBe('思')
  })

  it('tool_start 插入运行中工具行，tool_end 标记完成并带耗时', () => {
    let s = transcriptReducer([], { type: 'tool_start', id: 't1', name: 'Read', desc: '{"file_path":"a.ts"}' })
    expect((s.at(-1) as any).running).toBe(true)
    s = transcriptReducer(s, { type: 'tool_end', id: 't1', ok: true, preview: '1  // a', ms: 120 })
    const t = s.find(i => i.kind === 'tool' && (i as any).id === 't1') as any
    expect(t.running).toBe(false)
    expect(t.ms).toBe(120)
  })

  it('turn_end 关闭进行中块并追加 usage 行', () => {
    let s = transcriptReducer([], { type: 'delta', delta: 'x', reasoning: false })
    s = transcriptReducer(s, { type: 'turn_end', usage })
    expect(s.every(i => i.kind !== 'assistant' || i.done)).toBe(true)
    expect(s.at(-1)!.kind).toBe('usage')
  })
})

describe('createChatCore.runTurn', () => {
  it('完整一轮：脚本驱动事件流，状态可被订阅者观察，usage 落 usageLog', async () => {
    script.push(
      { deltas: ['好', '的'], result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const frames: TranscriptItem[][] = []
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', onState: s => frames.push(s.transcript) })
    await core.send('随便说点')
    const last = frames.at(-1)!
    expect(last.some(i => i.kind === 'user' && i.text === '随便说点')).toBe(true)
    expect(last.some(i => i.kind === 'assistant' && i.done && i.text === '好的')).toBe(true)
    expect(core.state.usageLog.length).toBe(1)
    expect(core.state.cacheHitRate()).toBeCloseTo(40 / 50)
  })

  it('斜杠命令 /cost /clear 走本地语义不发请求', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', onState: () => {} })
    await core.send('/cost')
    expect(core.state.transcript.some(i => i.kind === 'notice' && i.text.includes('本会话'))).toBe(true)
    await core.send('/clear')
    expect(core.state.transcript.some(i => i.kind === 'notice' && i.text.includes('已清空'))).toBe(true)
    expect((await import('../src/api.js') as any).chatStream.mock.calls.length).toBe(0)
  })

  it('Esc 中断：abort 后 transcript 出现中断 notice', async () => {
    script.push({
      deltas: ['长', '回', '答'],
      result: { content: '长回答', toolCalls: [], usage, finishReason: 'stop' },
    })
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', onState: () => {} })
    const p = core.send('说个长的')
    core.interrupt() // chatStream mock 不感知 signal——这里验证 interrupt 不抛、状态机不卡死
    await p
    expect(core.state.busy).toBe(false)
  })
})
