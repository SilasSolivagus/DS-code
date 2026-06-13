// test/tui.status.test.tsx
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { Banner } from '../src/tui/components/Banner.js'
import { SelectList } from '../src/tui/components/SelectList.js'

describe('Banner', () => {
  it('显示欢迎框：鲸鱼名称、/help 提示、cwd 与模型', () => {
    const f = render(<Banner cwd="/tmp/demo" model="deepseek-v4-flash" />).lastFrame()!
    expect(f).toContain('🐳 deepcode')
    expect(f).toContain('/help')
    expect(f).toContain('cwd:')
    expect(f).toContain('/tmp/demo')
    expect(f).toContain('模型:')
    expect(f).toContain('deepseek-v4-flash')
  })
})

const delay = (ms = 0) => new Promise(res => setTimeout(res, ms))

describe('SelectList', () => {
  it('↑↓ 移动选中，Enter 回调，Esc 取消', async () => {
    const onPick = vi.fn(); const onCancel = vi.fn()
    const r = render(<SelectList items={['会话A', '会话B']} onPick={onPick} onCancel={onCancel} />)
    await delay()
    r.stdin.write('\x1b[B')
    await delay()
    r.stdin.write('\r')
    await delay()
    expect(onPick).toHaveBeenCalledWith(1)
    const r2 = render(<SelectList items={['x']} onPick={onPick} onCancel={onCancel} />)
    await delay()
    r2.stdin.write('\x1b')
    await delay()
    expect(onCancel).toHaveBeenCalled()
  })
})
