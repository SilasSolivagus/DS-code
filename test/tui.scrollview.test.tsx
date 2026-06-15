import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { ScrollView } from '../src/tui/ScrollView.js'
import type { TranscriptItem } from '../src/tui/useChat.js'

const items: TranscriptItem[] = Array.from({ length: 10 }, (_, i) =>
  ({ kind: 'user', text: `行${i}` } as any))

describe('ScrollView', () => {
  it('挂载不崩；上报内容高 totalH（measure 回调被调用）', async () => {
    const onMeasureTotal = vi.fn()
    render(<ScrollView items={items} scrollOffset={0} height={20} onMeasureTotal={onMeasureTotal} />)
    await new Promise(r => setTimeout(r, 30))
    expect(onMeasureTotal).toHaveBeenCalled()
    const th = onMeasureTotal.mock.calls[onMeasureTotal.mock.calls.length - 1][0]
    expect(typeof th).toBe('number')
  })

  it('offset=0 时顶部项可见', () => {
    const f = render(<ScrollView items={items} scrollOffset={0} height={20} onMeasureTotal={() => {}} />).lastFrame()!
    expect(f).toContain('行0')
  })
})
