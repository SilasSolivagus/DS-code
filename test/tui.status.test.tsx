// test/tui.status.test.tsx
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { StatusLine } from '../src/tui/components/StatusLine.js'
import { Banner } from '../src/tui/components/Banner.js'
import { SelectList } from '../src/tui/components/SelectList.js'

describe('StatusLine', () => {
  it('渲染模型短名、缓存命中率、花费、tok/s', () => {
    const f = render(
      <StatusLine model="deepseek-v4-flash" thinking={false} permMode="default" cacheHitRate={0.87} cost={0.0042} tokPerSec={38} />,
    ).lastFrame()!
    expect(f).toContain('flash')
    expect(f).toContain('87%')
    expect(f).toContain('$0.0042')
    expect(f).toContain('38 tok/s')
  })
  it('thinking/accept 标志与无数据占位', () => {
    const f = render(
      <StatusLine model="deepseek-v4-pro" thinking={true} permMode="acceptEdits" cacheHitRate={0} cost={0} tokPerSec={null} />,
    ).lastFrame()!
    expect(f).toContain('pro')
    expect(f).toContain('think')
    expect(f).toContain('accept')
  })
})

describe('Banner', () => {
  it('显示鲸鱼、名称与模型', () => {
    const f = render(<Banner model="deepseek-v4-flash" yolo={false} version="0.5.0" />).lastFrame()!
    expect(f).toContain('🐳')
    expect(f).toContain('deepcode')
    expect(f).toContain('0.5.0')
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
