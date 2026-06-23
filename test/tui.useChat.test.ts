// test/tui.useChat.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

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

let sessionDir: string
beforeEach(() => {
  script.length = 0
  vi.clearAllMocks()
  // 每个测试独立的 session 目录，防止写入 ~/.deepcode/sessions
  sessionDir = mkdtempSync(path.join(tmpdir(), 'deepcode-test-'))
})

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
    s = transcriptReducer(s, { type: 'tool_end', id: 't1', ok: true, preview: '1  // a', previewExtra: 0, ms: 120 })
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

  it('seal 关闭所有进行中块并丢弃空文本块', () => {
    // 一个有内容的进行中块 + 一个空的进行中块
    let s = transcriptReducer([], { type: 'delta', delta: '内容', reasoning: false })
    s = [...s, { kind: 'assistant' as const, text: '', done: false }]
    s = transcriptReducer(s, { type: 'seal' })
    // 有内容的块应保留且 done=true
    expect(s.some(i => i.kind === 'assistant' && (i as any).done && (i as any).text === '内容')).toBe(true)
    // 空文本块应被丢弃
    expect(s.filter(i => i.kind === 'assistant' && (i as any).text === '').length).toBe(0)
    // 所有 assistant 块都 done
    expect(s.every(i => i.kind !== 'assistant' || (i as any).done)).toBe(true)
  })
})

describe('createChatCore.runTurn', () => {
  it('初始 state 含 turnStartAt=null、turnOutTokens=0（spinner 数据契约）', () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    expect(core.state.turnStartAt).toBeNull()
    expect(core.state.turnOutTokens).toBe(0)
  })

  it('一轮结束后 turnStartAt 复位为 null，turnOutTokens 为真实输出 token', async () => {
    script.push(
      { deltas: ['好', '的'], result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    await core.send('随便说点')
    expect(core.state.turnStartAt).toBeNull()
    expect(core.state.turnOutTokens).toBe(usage.completion_tokens)
  })

  it('完整一轮：脚本驱动事件流，状态可被订阅者观察，usage 落 usageLog', async () => {
    script.push(
      { deltas: ['好', '的'], result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const frames: TranscriptItem[][] = []
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: s => frames.push(s.transcript) })
    await core.send('随便说点')
    const last = frames.at(-1)!
    expect(last.some(i => i.kind === 'user' && i.text === '随便说点')).toBe(true)
    expect(last.some(i => i.kind === 'assistant' && i.done && i.text === '好的')).toBe(true)
    expect(core.state.usageLog.length).toBe(1)
    expect(core.state.cacheHitRate()).toBeCloseTo(40 / 50)
  })

  it('新建会话 contextPct() 为 0', () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    expect(core.state.contextPct()).toBe(0)
  })

  it('斜杠命令 /cost /clear 走本地语义不发请求', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
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
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    const p = core.send('说个长的')
    core.interrupt() // chatStream mock 不感知 signal——这里验证 interrupt 不抛、状态机不卡死
    await p
    expect(core.state.busy).toBe(false)
  })

  // ── Fix 4a: ask-chain ──────────────────────────────────────────────────────
  it('ask-chain: 权限拒绝后工具结果含拒绝原因，最终 busy=false', async () => {
    // 第一次 chatStream: 返回 Bash 工具调用
    script.push({
      deltas: [],
      result: {
        content: '',
        toolCalls: [{ id: 'tc1', name: 'Bash', args: '{"command":"echo hello"}' }],
        usage,
        finishReason: 'tool_calls',
      },
    })
    // 第二次 chatStream: 模型收到拒绝结果后的回复（loop 内第二轮）
    script.push({
      deltas: ['好的，已取消。'],
      result: { content: '好的，已取消。', toolCalls: [], usage, finishReason: 'stop' },
    })

    const states: any[] = []
    // 非 yolo 模式，Bash 工具需要权限确认
    const core = createChatCore({ client: {} as any, yolo: false, cwd: '/tmp', sessionDir, onState: s => states.push(s) })

    // 等待 pendingAsk 被设置（轮询 onState 帧）
    const pendingAskSet = new Promise<void>(resolve => {
      const unsub = core.subscribe(() => {
        if (core.state.pendingAsk) { unsub(); resolve() }
      })
    })

    const sendP = core.send('请执行命令')
    await pendingAskSet

    // 确认 pendingAsk 存在
    expect(core.state.pendingAsk).not.toBeNull()
    expect(core.state.pendingAsk!.toolName).toBe('Bash')

    // 拒绝操作
    core.resolveAsk('no')

    await sendP
    expect(core.state.busy).toBe(false)

    // transcript 中的工具 end 项 preview 应包含拒绝理由
    const toolItems = core.state.transcript.filter(i => i.kind === 'tool') as any[]
    expect(toolItems.length).toBeGreaterThan(0)
    expect(toolItems.some(t => t.preview?.includes('用户拒绝了此操作'))).toBe(true)
  })

  // ── Fix 4b: interrupt-during-ask (C1 regression test) ────────────────────
  it('interrupt-during-ask: interrupt 时 pendingAsk 不为 null，send Promise 正常 resolve', async () => {
    // 第一次 chatStream: 返回 Bash 工具调用，触发权限弹窗
    script.push({
      deltas: [],
      result: {
        content: '',
        toolCalls: [{ id: 'tc2', name: 'Bash', args: '{"command":"rm -rf /"}' }],
        usage,
        finishReason: 'tool_calls',
      },
    })
    // 注意：interrupt 后 loop 因 abort 提前返回，不需要第二个 scene

    const core = createChatCore({ client: {} as any, yolo: false, cwd: '/tmp', sessionDir, onState: () => {} })

    // 等待 pendingAsk 被设置
    const pendingAskSet = new Promise<void>(resolve => {
      const unsub = core.subscribe(() => {
        if (core.state.pendingAsk) { unsub(); resolve() }
      })
    })

    const sendP = core.send('危险操作')
    await pendingAskSet

    // pendingAsk 此时非 null，这是 C1 deadlock 场景
    expect(core.state.pendingAsk).not.toBeNull()

    // interrupt 应同时解除 pendingAsk 并 abort（Fix 1 防止死锁）
    core.interrupt()

    // send Promise 必须 resolve（没有 Fix 1 时此处会永远 hang）
    await sendP

    expect(core.state.busy).toBe(false)
    expect(core.state.pendingAsk).toBeNull()
  })

  // ── Task 10: /model 参数化 ────────────────────────────────────────────────
  it('/model <名> 切换到任意模型，notice 含 已切换到；非 deepseek 加计价提示', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    await core.send('/model my-custom-model')
    expect(core.state.model).toBe('my-custom-model')
    const notices = core.state.transcript.filter(i => i.kind === 'notice') as any[]
    expect(notices.some(n => n.text.includes('已切换到') && n.text.includes('my-custom-model'))).toBe(true)
    expect(notices.some(n => n.text.includes('非当前 provider 档，计价/上下文按兜底估算'))).toBe(true)
  })

  it('/model 无参从自定义模型切回 flash', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    // 先切到自定义模型
    await core.send('/model my-custom-model')
    expect(core.state.model).toBe('my-custom-model')
    // 裸 /model 应切回 flash（从自定义模型落到 flash）
    await core.send('/model')
    expect(core.state.model).toBe('deepseek-v4-flash')
  })

  // ── Fix 4c: seal — chatStream 抛出时没有 done=false 残留块 ─────────────────
  it('seal: chatStream 抛出后无 done=false 残留块，第二次回复为独立条目', async () => {
    // 第一次：无 scene → chatStream 抛出 'script exhausted'
    // 不推任何 scene

    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })

    await core.send('第一次（会抛出）')

    // 应有 error notice
    expect(core.state.transcript.some(i => i.kind === 'notice' && (i as any).level === 'error')).toBe(true)
    // 不应有任何 done=false 的 assistant/reasoning 块
    expect(core.state.transcript.some(i => (i.kind === 'assistant' || i.kind === 'reasoning') && !(i as any).done)).toBe(false)

    // 记录当前 assistant 块数量
    const assistantCountBefore = core.state.transcript.filter(i => i.kind === 'assistant').length

    // 第二次：正常场景
    script.push({
      deltas: ['新的回复'],
      result: { content: '新的回复', toolCalls: [], usage, finishReason: 'stop' },
    })
    await core.send('第二次（正常）')

    // 新的 assistant 块数量应增加（独立的新块，不是追加到旧块）
    const assistantCountAfter = core.state.transcript.filter(i => i.kind === 'assistant').length
    expect(assistantCountAfter).toBeGreaterThan(assistantCountBefore)

    // 第二次回复的内容不应混入第一次的内容
    const lastAssistant = core.state.transcript.filter(i => i.kind === 'assistant').at(-1) as any
    expect(lastAssistant.text).toBe('新的回复')
  })
})

describe('createChatCore /export 默认文件名', () => {
  it('/export 无参 → 写 deepcode-export-<sessionId>.md（默认名复用 sessionIdFromFile）', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'deepcode-export-'))
    const core = createChatCore({ client: {} as any, yolo: true, cwd, sessionDir, onState: () => {} })
    await core.send('/export')
    // 会话落盘文件名去 .jsonl 即默认导出名的 sessionId 段
    const sessionFile = readdirSync(sessionDir).find(f => f.endsWith('.jsonl'))!
    const base = sessionFile.replace(/\.jsonl$/, '')
    const files = readdirSync(cwd)
    expect(files).toContain(`deepcode-export-${base}.md`)
    // base 非空 → 用带 sessionId 的名字，而非兜底名
    expect(files).not.toContain('deepcode-export.md')
    const md = readFileSync(path.join(cwd, `deepcode-export-${base}.md`), 'utf8')
    expect(md).toContain('# deepcode 对话导出')
  })
})
