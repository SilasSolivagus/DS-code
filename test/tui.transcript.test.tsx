// test/tui.transcript.test.tsx
import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { Transcript } from '../src/tui/components/Transcript.js'
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
