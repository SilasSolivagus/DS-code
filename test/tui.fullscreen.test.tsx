import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { FullscreenApp } from '../src/tui/FullscreenApp.js'

const tmp = () => '/tmp/dc-fs-' + Math.random().toString(36).slice(2)

describe('FullscreenApp 装配', () => {
  it('挂载渲染输入框 + 页脚，不崩', async () => {
    const { lastFrame, unmount } = render(
      <FullscreenApp client={{} as any} yolo={false} cwd="/tmp" sessionDir={tmp()} />
    )
    await new Promise(r => setTimeout(r, 40))
    const f = lastFrame()!
    expect(f).toContain('❯')
    expect(f).toContain('Context')
    unmount()
  })

  it('PageUp/PageDown/Ctrl+G 不抛错', async () => {
    const { stdin, unmount } = render(
      <FullscreenApp client={{} as any} yolo={false} cwd="/tmp" sessionDir={tmp()} />
    )
    await new Promise(r => setTimeout(r, 20))
    stdin.write('\x1B[5~')
    stdin.write('\x1B[6~')
    stdin.write('\x07')
    await new Promise(r => setTimeout(r, 20))
    unmount()
    expect(true).toBe(true)
  })
})
