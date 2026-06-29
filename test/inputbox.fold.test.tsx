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
  stdin.write(big)           // 粘贴 → 去抖后折叠为 [Pasted text #1]
  await delay(70)            // 等粘贴合并去抖 flush（PASTE_COALESCE_MS=40）
  expect(lastFrame()).toMatch(/\[Pasted text/)
  stdin.write('\x7f')        // Backspace → 整体删除占位符
  await delay(20)
  expect(lastFrame()).not.toMatch(/\[Pasted text/)
})

it('分块到达的粘贴合并成单个占位符（回归：终端把大粘贴拆多块送来）', async () => {
  const onSubmit = vi.fn()
  const { stdin } = render(<InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={[]} busy={false} />)
  await delay()              // 等 ink useInput effect 注册
  // 模拟终端把一次多行粘贴拆成多个 stdin data 块（冒烟暴露的真实行为）
  stdin.write('第001行 内容\n第002行 内容\n')
  stdin.write('第003行 内容\n第004行 内容\n')
  stdin.write('第005行 内容\n第006行 内容')
  await delay(70)            // 等去抖合并 flush
  stdin.write('\r')          // 提交
  await delay(20)
  expect(onSubmit).toHaveBeenCalledTimes(1)
  const [text, attachments] = onSubmit.mock.calls[0]
  expect(text).toBe('[Pasted text #1 +5 lines]')                  // 仅一个占位符
  expect((text.match(/\[Pasted text/g) || []).length).toBe(1)     // 不是多个
  expect(text).not.toMatch(/第00\d行/)                            // 无原文泄漏到显示
  expect(attachments[0].content).toContain('第001行')             // 完整原文在附件
  expect(attachments[0].content).toContain('第006行')
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
