import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { Box } from 'ink'
import { renderItem, isDone } from '../src/tui/renderItem.js'
import { DEFAULT_THEME } from '../src/tui/theme.js'
import type { TranscriptItem } from '../src/tui/useChat.js'

describe('renderItem 抽取', () => {
  it('isDone：tool running=false 为完成，assistant done 决定', () => {
    expect(isDone({ kind: 'tool', name: 'Read', running: false } as any)).toBe(true)
    expect(isDone({ kind: 'tool', name: 'Read', running: true } as any)).toBe(false)
    expect(isDone({ kind: 'assistant', text: 'x', done: true } as any)).toBe(true)
    expect(isDone({ kind: 'user', text: 'hi' } as any)).toBe(true)
  })

  it('renderItem：user 项渲染文本与 > 提示符', () => {
    const item: TranscriptItem = { kind: 'user', text: '你好世界' } as any
    const f = render(<Box>{renderItem(item, 0, DEFAULT_THEME)}</Box>).lastFrame()!
    expect(f).toContain('你好世界')
    expect(f).toContain('>')
  })
})
