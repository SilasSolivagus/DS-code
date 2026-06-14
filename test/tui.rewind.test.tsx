import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { App } from '../src/tui/App.js'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dc-app-rw-'))

describe('App /rewind UX', () => {
  it('输入 /rewind 回车：无还原点时给提示、不崩', async () => {
    const { stdin, lastFrame, unmount } = render(
      <App client={{} as any} yolo={false} cwd="/tmp" sessionDir={tmp()} />
    )
    await new Promise(r => setTimeout(r, 30))
    stdin.write('/rewind'); await new Promise(r => setTimeout(r, 10))
    stdin.write('\r'); await new Promise(r => setTimeout(r, 30))
    expect(lastFrame()).toContain('暂无可回退')
    unmount()
  })
})
