import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { QuestionDialog } from '../src/tui/components/QuestionDialog.js'
import type { Question } from '../src/tools/askUserQuestion.js'

const delay = (ms = 25) => new Promise(r => setTimeout(r, ms))

const single: Question[] = [{
  question: '认证方式？', header: '认证', multiSelect: false,
  options: [{ label: 'OAuth', description: '第三方' }, { label: '密码', description: '本地' }],
}]

describe('QuestionDialog', () => {
  it('渲染问句、选项、进度', () => {
    const f = render(<QuestionDialog questions={single} onDone={() => {}} />).lastFrame()!
    expect(f).toContain('认证方式？')
    expect(f).toContain('OAuth')
    expect(f).toContain('其他')
    expect(f).toContain('(1/1)')
  })

  it('数字键直选 → onDone 带 selected（无备注则按 Enter 跳过 note）', async () => {
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={single} onDone={onDone} />)
    await delay()
    stdin.write('1')       // 选 OAuth → 进 note
    await delay()
    stdin.write('\r')      // note 空 → 确认，单题结束
    await delay()
    expect(onDone).toHaveBeenCalledTimes(1)
    const ans = onDone.mock.calls[0][0]
    expect(ans[0].selected).toEqual(['OAuth'])
    expect(ans[0].note).toBeUndefined()
  })

  it('备注：选完输入备注 → 进 answer', async () => {
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={single} onDone={onDone} />)
    await delay()
    stdin.write('1'); await delay()        // 选 OAuth → note 模式
    stdin.write('先用谷歌'); await delay()
    stdin.write('\r'); await delay()
    expect(onDone.mock.calls[0][0][0].note).toBe('先用谷歌')
  })

  it('多选：空格勾选两项 + Enter', async () => {
    const multi: Question[] = [{
      question: '要哪些？', header: '功能', multiSelect: true,
      options: [{ label: 'A', description: '' }, { label: 'B', description: '' }, { label: 'C', description: '' }],
    }]
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={multi} onDone={onDone} />)
    await delay()
    stdin.write(' ');                 await delay()  // 勾 A
    stdin.write('\x1B[B'); stdin.write(' '); await delay()  // ↓ 到 B，勾 B
    stdin.write('\r');                await delay()  // 提交 → note
    stdin.write('\r');                await delay()  // note 空 → 确认
    expect(onDone.mock.calls[0][0][0].selected).toEqual(['A', 'B'])
  })

  it('其他（自由输入）→ freeText', async () => {
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={single} onDone={onDone} />)
    await delay()
    stdin.write('3'); await delay()        // 第3项=「其他」
    stdin.write('自定义答案'); await delay()
    stdin.write('\r'); await delay()       // other 提交 → note
    stdin.write('\r'); await delay()       // note 空 → 确认
    const a = onDone.mock.calls[0][0][0]
    expect(a.freeText).toBe('自定义答案')
    expect(a.selected).toEqual(['自定义答案'])
  })

  it('Esc → onDone(null)', async () => {
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={single} onDone={onDone} />)
    await delay()
    stdin.write('\x1B'); await delay()
    expect(onDone).toHaveBeenCalledWith(null)
  })

  it('有 preview 时并排渲染聚焦项预览', () => {
    const wp: Question[] = [{
      question: '选布局', header: '布局', multiSelect: false,
      options: [{ label: 'A', description: '', preview: '预览内容XYZ' }, { label: 'B', description: '' }],
    }]
    const f = render(<QuestionDialog questions={wp} onDone={() => {}} />).lastFrame()!
    expect(f).toContain('预览内容XYZ')
  })

  it('多题：连续作答两题（同步突发）→ 两题答案各归各题', async () => {
    const two: Question[] = [
      { question: 'Q1?', header: 'H1', multiSelect: false,
        options: [{ label: 'A1', description: '' }, { label: 'B1', description: '' }] },
      { question: 'Q2?', header: 'H2', multiSelect: false,
        options: [{ label: 'A2', description: '' }, { label: 'B2', description: '' }] },
    ]
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={two} onDone={onDone} />)
    await delay()
    stdin.write('1'); stdin.write('\r')   // Q1: select A1 → note → commit  (synchronous burst)
    stdin.write('1'); stdin.write('\r')   // Q2: select A2 → note → commit  (synchronous burst)
    await delay()
    expect(onDone).toHaveBeenCalledTimes(1)
    const ans = onDone.mock.calls[0][0]
    expect(ans).toHaveLength(2)
    expect(ans[0]).toMatchObject({ question: 'Q1?', header: 'H1', selected: ['A1'] })
    expect(ans[1]).toMatchObject({ question: 'Q2?', header: 'H2', selected: ['A2'] })
  })
})
