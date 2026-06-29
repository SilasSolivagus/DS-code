// test/inputbox.image.test.tsx — Task 7: InputBox 图片抓取
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { InputBox } from '../src/tui/components/InputBox.js'

describe('InputBox image capture', () => {
  it('拖入图片文件路径 → [Image #N] + 附件携带 base64', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-ib-'))
    const f = path.join(dir, 'shot.png')
    fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const onSubmit = vi.fn()
    const { stdin } = render(<InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={[]} busy={false} />)
    await new Promise(r => setTimeout(r, 0))  // 等 ink useInput effect 注册
    stdin.write(`'${f}'`)            // 终端拖文件粘的带引号路径
    await new Promise(r => setTimeout(r, 20))
    stdin.write('\r')
    await new Promise(r => setTimeout(r, 20))
    const [text, attachments] = onSubmit.mock.calls[0]
    expect(text).toMatch(/\[Image #1\]/)
    expect(attachments[0]).toMatchObject({ type: 'image', mime: 'image/png', source: 'file' })
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
