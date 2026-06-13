import { describe, it, expect, vi } from 'vitest'
import { makeAskUserQuestionTool, type Answer } from '../src/tools/askUserQuestion.js'

const ctx: any = { cwd: () => '/tmp', setCwd: () => {}, signal: new AbortController().signal, fileState: new Map() }

const Q = [{
  question: '认证方式用哪个？', header: '认证', multiSelect: false,
  options: [{ label: 'OAuth', description: '第三方登录' }, { label: '密码', description: '本地' }],
}]

describe('AskUserQuestion 工具', () => {
  it('isReadOnly / 不需权限 / schema 基本校验', () => {
    const tool = makeAskUserQuestionTool({ ask: async () => null })
    expect(tool.name).toBe('AskUserQuestion')
    expect(tool.isReadOnly).toBe(true)
    expect(tool.needsPermission({ questions: Q } as any)).toBe(false)
    expect(tool.inputSchema.safeParse({ questions: Q }).success).toBe(true)
    // 少于 2 个选项应失败
    expect(tool.inputSchema.safeParse({ questions: [{ ...Q[0], options: [Q[0].options[0]] }] }).success).toBe(false)
  })

  it('call 返回 JSON：键为 question，值含 selected/note/freeText', async () => {
    const answers: Answer[] = [{ header: '认证', question: '认证方式用哪个？', selected: ['OAuth'], note: '先用 Google' }]
    const tool = makeAskUserQuestionTool({ ask: async () => answers })
    const out = await tool.call({ questions: Q }, ctx)
    const parsed = JSON.parse(out)
    expect(parsed['认证方式用哪个？'].selected).toEqual(['OAuth'])
    expect(parsed['认证方式用哪个？'].note).toBe('先用 Google')
  })

  it('多选 + freeText 进 JSON', async () => {
    const answers: Answer[] = [{ header: '功能', question: '要哪些？', selected: ['A', 'B'], freeText: '还要C' }]
    const tool = makeAskUserQuestionTool({ ask: async () => answers })
    const out = await tool.call({ questions: Q }, ctx)
    const p = JSON.parse(out)['要哪些？']
    expect(p.selected).toEqual(['A', 'B'])
    expect(p.other).toBe('还要C')
  })

  it('ask 返回 null（取消）→ 返回取消文案', async () => {
    const tool = makeAskUserQuestionTool({ ask: async () => null })
    const out = await tool.call({ questions: Q }, ctx)
    expect(out).toContain('取消')
  })
})
