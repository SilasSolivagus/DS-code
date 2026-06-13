// test/tui.transcript.test.tsx
import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { Transcript } from '../src/tui/components/Transcript.js'
import { transcriptReducer } from '../src/tui/useChat.js'
import type { TranscriptItem } from '../src/tui/useChat.js'

describe('Transcript', () => {
  it('user 块带 › 前缀，完成的 assistant 块走 markdown 渲染', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', text: '你好' },
      { kind: 'assistant', text: '**重点** 内容', done: true },
    ]
    const { lastFrame } = render(<Transcript items={items} />)
    expect(lastFrame()).toContain('› 你好')
    expect(lastFrame()).toContain('重点')   // markdown 渲染后无 ** 字面量
    expect(lastFrame()).not.toContain('**重点**')
  })

  it('运行中工具行显示 spinner 字符，完成后显示 ⎿ 预览与耗时', () => {
    const running: TranscriptItem[] = [{ kind: 'tool', id: 't', name: 'Read', desc: '{"f":1}', running: true }]
    const f1 = render(<Transcript items={running} />).lastFrame()!
    expect(f1).toContain('Read')
    expect(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(f1)).toBe(true)
    const done: TranscriptItem[] = [{ kind: 'tool', id: 't', name: 'Read', desc: '', running: false, ok: true, preview: '42 行', ms: 230 }]
    const f2 = render(<Transcript items={done} />).lastFrame()!
    expect(f2).toContain('⎿ 42 行')
    expect(f2).toContain('0.2s')
  })

  it('进行中 reasoning 块带思考前缀，完成后折叠为一行', () => {
    const live: TranscriptItem[] = [{ kind: 'reasoning', text: '第一行\n第二行\n第三行', done: false }]
    expect(render(<Transcript items={live} />).lastFrame()).toContain('✻ 思考中')
    const done: TranscriptItem[] = [{ kind: 'reasoning', text: '第一行\n第二行', done: true }]
    const f = render(<Transcript items={done} />).lastFrame()!
    expect(f).toContain('✻ 已思考')
    expect(f).not.toContain('第二行')   // 折叠
  })

  it('usage 行渲染入/缓存/出/累计', () => {
    const items: TranscriptItem[] = [{ kind: 'usage', in: 100, hit: 80, out: 9, totalIn: 100, totalOut: 9, cost: 0.0001 }]
    const f = render(<Transcript items={items} />).lastFrame()!
    expect(f).toContain('100')
    expect(f).toContain('80')
  })

  // 回归测试：前导文本 + 工具调用场景下 Static done-list 严格追加
  // 真实事件顺序：delta('前导') → tool_start(t1) → tool_end(t1) → turn_end
  // 修复前：assistant 文本块在 tool_start 之后才被 seal（turn_end 时），进入 doneItems
  // 的位置在 tool 条目之后，导致 ink Static 重复渲染工具行且文本块永久丢失。
  // 修复后：tool_start 先 seal 文本块，done 列表严格追加，文本与工具均正确渲染一次。
  it('前导文本 + 工具调用：文本与工具预览各出现恰好一次（Static append-only 回归）', () => {
    const usage = { prompt_tokens: 50, completion_tokens: 10, prompt_cache_hit_tokens: 0 }

    let state: TranscriptItem[] = []
    state = transcriptReducer(state, { type: 'delta', delta: '前导', reasoning: false })
    state = transcriptReducer(state, { type: 'tool_start', id: 't1', name: 'Read', desc: '{}' })
    state = transcriptReducer(state, { type: 'tool_end', id: 't1', ok: true, preview: 'UNIQUE-PREVIEW', ms: 50 })
    state = transcriptReducer(state, { type: 'turn_end', usage })

    const { rerender, lastFrame } = render(<Transcript items={state} />)

    // 重渲染同一状态（模拟 ink 典型 re-render，验证 Static dedup 正确）
    rerender(<Transcript items={state} />)

    const frame = lastFrame()!
    // 前导文本必须出现
    expect(frame).toContain('前导')
    // 工具预览只出现一次（Static dedup 正确，没有中间插入导致的重复）
    const occurrences = frame.split('UNIQUE-PREVIEW').length - 1
    expect(occurrences).toBe(1)
  })

  // 额外测试：Static dedup —— done 项从动态区迁移到 Static 后不应出现两次
  it('item 从 running 变为 done 后预览文字只出现一次（Static dedup）', () => {
    const running: TranscriptItem[] = [{ kind: 'tool', id: 't2', name: 'Write', desc: 'x', running: true }]
    const { rerender, lastFrame } = render(<Transcript items={running} />)
    const done: TranscriptItem[] = [{ kind: 'tool', id: 't2', name: 'Write', desc: 'x', running: false, ok: true, preview: 'saved-file.ts', ms: 100 }]
    rerender(<Transcript items={done} />)
    const frame = lastFrame()!
    // 'saved-file.ts' should appear exactly once (Static rendered it once, dynamic region removed it)
    const occurrences = frame.split('saved-file.ts').length - 1
    expect(occurrences).toBe(1)
  })
})
