// test/tui.gridization.test.tsx
import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { Transcript } from '../src/tui/components/Transcript.js'
import { ScrollView } from '../src/tui/ScrollView.js'
import type { TranscriptItem } from '../src/tui/useChat.js'

/** frame 中 a、b 两行之间至少夹一行空白 */
function hasBlankBetween(frame: string, a: string, b: string): boolean {
  const lines = frame.split('\n')
  const ia = lines.findIndex(l => l.includes(a))
  const ib = lines.findIndex(l => l.includes(b))
  if (ia < 0 || ib < 0 || ib <= ia) return false
  return lines.slice(ia + 1, ib).some(l => l.trim() === '')
}

describe('Transcript 块间距', () => {
  it('相邻两块之间有空行', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', text: 'AAA-PROMPT' } as TranscriptItem,
      { kind: 'notice', level: 'info', text: 'BBB-NOTICE' } as TranscriptItem,
    ]
    const { lastFrame } = render(<Transcript items={items} />)
    expect(hasBlankBetween(lastFrame()!, 'AAA-PROMPT', 'BBB-NOTICE')).toBe(true)
  })

  it('live 区项间有空行', () => {
    const items: TranscriptItem[] = [
      { kind: 'assistant', text: 'LIVE-A', done: false } as TranscriptItem,
      { kind: 'tool', name: 'X', desc: 'Y', running: true } as TranscriptItem,
    ]
    const { lastFrame } = render(<Transcript items={items} />)
    expect(hasBlankBetween(lastFrame()!, 'LIVE-A', 'Y')).toBe(true)
  })

  it('屏顶无内容时首个 live 项不顶空行', () => {
    const items: TranscriptItem[] = [
      { kind: 'tool', name: 'TOP-TOOL', desc: 'TOP-DESC', running: true } as TranscriptItem,
    ]
    const { lastFrame } = render(<Transcript items={items} />)
    const frame = lastFrame()!
    const lines = frame.split('\n')
    // 首行应包含顶部内容（不应以空行开头）
    expect(lines[0].length).toBeGreaterThan(0)
    expect(lines[0]).not.toMatch(/^\s*$/)
  })
})

describe('ScrollView 块间距', () => {
  it('相邻两块之间有空行', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', text: 'CCC-PROMPT' } as TranscriptItem,
      { kind: 'notice', level: 'info', text: 'DDD-NOTICE' } as TranscriptItem,
    ]
    const { lastFrame } = render(
      <ScrollView items={items} scrollOffset={0} height={20} onMeasureTotal={() => {}} />,
    )
    expect(hasBlankBetween(lastFrame()!, 'CCC-PROMPT', 'DDD-NOTICE')).toBe(true)
  })

  it('不传 banner 时首项不顶空行', () => {
    const items: TranscriptItem[] = [
      { kind: 'notice', level: 'info', text: 'FIRST-ITEM' } as TranscriptItem,
    ]
    const { lastFrame } = render(
      <ScrollView items={items} scrollOffset={0} height={20} onMeasureTotal={() => {}} />,
    )
    const frame = lastFrame()!
    const lines = frame.split('\n')
    // 首行应包含顶部内容（不应以空行开头）
    expect(lines[0].length).toBeGreaterThan(0)
    expect(lines[0]).not.toMatch(/^\s*$/)
  })
})
