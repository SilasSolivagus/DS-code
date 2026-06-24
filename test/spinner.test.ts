import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { Spinner } from '../src/tui/components/Spinner.js'
import { ThemeProvider } from '../src/tui/theme.js'

describe('Spinner hook 进度', () => {
  it('有 hookLabel 时显示该文案', () => {
    const spinnerEl = React.createElement(Spinner, { turnStartAt: Date.now(), turnOutTokens: 0, hookLabel: '正在运行 PreCompact 钩子…' })
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { initial: 'dark', children: spinnerEl }),
    )
    expect(lastFrame()).toContain('正在运行 PreCompact 钩子…')
  })
  it('无 hookLabel 时显示常规 spinner', () => {
    const spinnerEl = React.createElement(Spinner, { turnStartAt: Date.now(), turnOutTokens: 0 })
    const { lastFrame } = render(
      React.createElement(ThemeProvider, { initial: 'dark', children: spinnerEl }),
    )
    expect(lastFrame()).toContain('esc 中断')
  })
})
