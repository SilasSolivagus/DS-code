import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { StatusFooter } from '../src/tui/components/StatusFooter.js'
import { ThemeProvider } from '../src/tui/theme.js'

const base = {
  model: 'm', mode: 'default', cwdBase: 'p', branch: null, memoryCount: 0,
  contextUsed: 0, contextWindow: 100, cost: 0, hitRate: 0, cacheSavings: 0,
  thinking: false, effortLevel: 'medium' as const, toolCounts: [],
}

describe('StatusFooter statusLine 段', () => {
  it('有 statusLineOutput 渲染该行', () => {
    const el = React.createElement(StatusFooter, { ...base, statusLineOutput: '主分支 ✓ 通过' })
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { initial: 'dark', children: el }),
    )
    expect(lastFrame()).toContain('主分支 ✓ 通过')
  })
  it('无 statusLineOutput 不渲染', () => {
    const el = React.createElement(StatusFooter, { ...base })
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { initial: 'dark', children: el }),
    )
    expect(lastFrame()).not.toContain('主分支')
  })
  it('statusLineOutput 为 null 不渲染', () => {
    const el = React.createElement(StatusFooter, { ...base, statusLineOutput: null })
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { initial: 'dark', children: el }),
    )
    expect(lastFrame()).not.toContain('主分支')
  })
})
