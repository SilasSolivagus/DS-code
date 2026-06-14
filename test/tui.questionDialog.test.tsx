import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { QuestionDialog } from '../src/tui/components/QuestionDialog.js'
import type { Question } from '../src/tools/askUserQuestion.js'

const delay = (ms = 30) => new Promise(r => setTimeout(r, ms))
const DOWN = '\x1B[B', LEFT = '\x1B[D'

const single: Question[] = [{
  question: '认证方式？', header: '认证', multiSelect: false,
  options: [{ label: 'OAuth', description: '第三方' }, { label: '密码', description: '本地' }],
}]

const two: Question[] = [
  { question: 'Q1?', header: 'H1', multiSelect: false,
    options: [{ label: 'A1', description: '' }, { label: 'B1', description: '' }] },
  { question: 'Q2?', header: 'H2', multiSelect: false,
    options: [{ label: 'A2', description: '' }, { label: 'B2', description: '' }] },
]

describe('QuestionDialog v2', () => {
  it('渲染 tab 导航条、问句、选项、进度', () => {
    const f = render(<QuestionDialog questions={single} onDone={() => {}} />).lastFrame()!
    expect(f).toContain('认证方式？')
    expect(f).toContain('OAuth')
    expect(f).toContain('其他')
    expect(f).toContain('(1/1)')
    expect(f).toContain('认证')
  })

  it('单选数字键：单个单选题选完即结束（hideSubmitTab，无复核页）', async () => {
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={single} onDone={onDone} />)
    await delay()
    stdin.write('1'); await delay()
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone.mock.calls[0][0][0].selected).toEqual(['OAuth'])
  })

  it('单选 Enter：在聚焦项确认即结束', async () => {
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={single} onDone={onDone} />)
    await delay()
    stdin.write('\r'); await delay()
    expect(onDone.mock.calls[0][0][0].selected).toEqual(['OAuth'])
  })

  it('多题：答完两题 → 复核页 → 提交，答案各归各题', async () => {
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={two} onDone={onDone} />)
    await delay()
    stdin.write('1'); await delay()
    stdin.write('1'); await delay()
    stdin.write('\r'); await delay()
    expect(onDone).toHaveBeenCalledTimes(1)
    const ans = onDone.mock.calls[0][0]
    expect(ans).toHaveLength(2)
    expect(ans[0]).toMatchObject({ question: 'Q1?', selected: ['A1'] })
    expect(ans[1]).toMatchObject({ question: 'Q2?', selected: ['A2'] })
  })

  it('回上一题重选（←）：选择被覆盖', async () => {
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={two} onDone={onDone} />)
    await delay()
    stdin.write('1'); await delay()
    stdin.write(LEFT); await delay()
    stdin.write('2'); await delay()
    stdin.write('1'); await delay()
    stdin.write('\r'); await delay()
    const ans = onDone.mock.calls[0][0]
    expect(ans[0].selected).toEqual(['B1'])
    expect(ans[1].selected).toEqual(['A2'])
  })

  it('多选：空格勾两项 + 移到动作行 Enter 确认 → 复核页 → 提交', async () => {
    const multi: Question[] = [{
      question: '要哪些？', header: '功能', multiSelect: true,
      options: [{ label: 'A', description: '' }, { label: 'B', description: '' }, { label: 'C', description: '' }],
    }]
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={multi} onDone={onDone} />)
    await delay()
    stdin.write(' '); await delay()
    stdin.write(DOWN); stdin.write(' '); await delay()
    stdin.write(DOWN); stdin.write(DOWN); stdin.write(DOWN); await delay()
    stdin.write('\r'); await delay()
    stdin.write('\r'); await delay()
    expect(onDone.mock.calls[0][0][0].selected).toEqual(['A', 'B'])
  })

  it('多选：选项行 Enter 不提交', async () => {
    const multi: Question[] = [{
      question: '要哪些？', header: '功能', multiSelect: true,
      options: [{ label: 'A', description: '' }, { label: 'B', description: '' }],
    }]
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={multi} onDone={onDone} />)
    await delay()
    stdin.write(' '); await delay()
    stdin.write('\r'); await delay()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('其他（自由输入）→ freeText（单个单选题即结束）', async () => {
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={single} onDone={onDone} />)
    await delay()
    stdin.write(DOWN); stdin.write(DOWN); await delay()
    stdin.write('\r'); await delay()
    stdin.write('自定义答案'); await delay()
    stdin.write('\r'); await delay()
    const a = onDone.mock.calls[0][0][0]
    expect(a.freeText).toBe('自定义答案')
    expect(a.selected).toContain('自定义答案')
  })

  it('复核页取消 → onDone(null)', async () => {
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={two} onDone={onDone} />)
    await delay()
    stdin.write('1'); await delay()
    stdin.write('1'); await delay()
    stdin.write(DOWN); await delay()
    stdin.write('\r'); await delay()
    expect(onDone).toHaveBeenCalledWith(null)
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
})
