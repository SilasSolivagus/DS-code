import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { InputBox } from '../src/tui/components/InputBox.js'

const delay = (ms = 0) => new Promise(r => setTimeout(r, ms))

it('粘贴 >800 字符折叠成占位符，提交时回传完整原文', async () => {
  const onSubmit = vi.fn()
  const { stdin } = render(<InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={[]} busy={false} />)
  await delay()              // 等 ink useInput effect 注册
  const big = 'x'.repeat(900)
  stdin.write(big)          // 模拟粘贴（ink 合并为单 input）
  await new Promise(r => setTimeout(r, 20))
  stdin.write('\r')         // 提交
  await new Promise(r => setTimeout(r, 20))
  expect(onSubmit).toHaveBeenCalledTimes(1)
  const [text, attachments] = onSubmit.mock.calls[0]
  expect(text).toMatch(/\[Pasted text #1\]/)         // 显示文本是占位符
  expect(attachments[0].content).toBe(big)            // 附件携带完整原文
})

it('Backspace 整体删除粘贴占位符', async () => {
  const onSubmit = vi.fn()
  const { stdin, lastFrame } = render(<InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={[]} busy={false} />)
  await delay()              // 等 ink useInput effect 注册
  const big = 'x'.repeat(900)
  stdin.write(big)           // 粘贴 → 折叠为 [Pasted text #1]
  await delay(20)
  expect(lastFrame()).toMatch(/\[Pasted text/)
  stdin.write('\x7f')        // Backspace → 整体删除占位符
  await delay(20)
  expect(lastFrame()).not.toMatch(/\[Pasted text/)
})

it('普通文字 Backspace 逐字删除', async () => {
  const onSubmit = vi.fn()
  const { stdin } = render(<InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={[]} busy={false} />)
  await delay()              // 等 ink useInput effect 注册
  stdin.write('abc')
  await delay(20)
  stdin.write('\x7f')        // Backspace 删最后一个字符
  await delay(20)
  stdin.write('\r')          // 提交
  await delay(20)
  expect(onSubmit).toHaveBeenCalledTimes(1)
  const [text] = onSubmit.mock.calls[0]
  expect(text).toBe('ab')
})
