import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'

vi.mock('../src/config.js', () => ({ saveApiKey: vi.fn() }))

import { Setup } from '../src/tui/setup.js'
import * as config from '../src/config.js'

const delay = (ms = 20) => new Promise(r => setTimeout(r, ms))

describe('Setup 首跑向导', () => {
  it('渲染欢迎与 key 提示', () => {
    const f = render(<Setup onDone={() => {}} />).lastFrame()!
    expect(f).toContain('deepcode')
    expect(f).toContain('API key')
  })

  it('输入 key 回车 → 调 saveApiKey 并 onDone', async () => {
    vi.mocked(config.saveApiKey).mockClear()
    const onDone = vi.fn()
    const { stdin } = render(<Setup onDone={onDone} />)
    await delay()
    stdin.write('sk-abc123')
    await delay()
    stdin.write('\r')
    await delay()
    expect(config.saveApiKey).toHaveBeenCalledWith('sk-abc123')
    expect(onDone).toHaveBeenCalled()
  })
})
