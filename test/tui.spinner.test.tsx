// test/tui.spinner.test.tsx
// CC 风格工作 spinner：动画符号 + 中文动名词 + 耗时秒数 + 输出 token + esc 中断提示。
// 断言内容均由 props 确定（固定 turnStartAt），定时器只触发重渲染，不影响断言稳定性。
import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { Spinner, fmtTokens } from '../src/tui/components/Spinner.js'
import { SPINNER_SYMBOLS, THINKING_VERBS } from '../src/tui/theme.js'

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('fmtTokens', () => {
  it('≥1000 显示 k，否则整数', () => {
    expect(fmtTokens(500)).toBe('500')
    expect(fmtTokens(1234)).toBe('1.2k')
    expect(fmtTokens(2100)).toBe('2.1k')
    expect(fmtTokens(999)).toBe('999')
  })
})

describe('Spinner', () => {
  it('渲染单行：符号 + 动名词… + 耗时秒 + token + esc 中断', async () => {
    const { lastFrame, unmount } = render(
      <Spinner turnStartAt={Date.now()} turnOutTokens={1234} />,
    )
    await delay(0)
    const frame = lastFrame()!
    expect(frame).toContain('esc 中断')
    expect(frame).toContain('tokens')
    expect(frame).toMatch(/\ds /) // 耗时秒数
    expect(frame).toContain('1.2k')
    expect(frame).toContain('…')
    // 符号是 SPINNER_SYMBOLS 之一
    expect(SPINNER_SYMBOLS.some(s => frame.includes(s))).toBe(true)
    // 动名词是 THINKING_VERBS 之一
    expect(THINKING_VERBS.some(v => frame.includes(v))).toBe(true)
    unmount()
  })

  it('token 格式：500 显示 500（非 0.5k），1234 显示 1.2k', async () => {
    const a = render(<Spinner turnStartAt={Date.now()} turnOutTokens={500} />)
    await delay(0)
    expect(a.lastFrame()!).toContain('500')
    expect(a.lastFrame()!).not.toContain('0.5k')
    a.unmount()

    const b = render(<Spinner turnStartAt={Date.now()} turnOutTokens={1234} />)
    await delay(0)
    expect(b.lastFrame()!).toContain('1.2k')
    b.unmount()
  })

  it('turnStartAt 为 null 时耗时为 0s', async () => {
    const { lastFrame, unmount } = render(
      <Spinner turnStartAt={null} turnOutTokens={0} />,
    )
    await delay(0)
    expect(lastFrame()!).toContain('0s')
    unmount()
  })
})
