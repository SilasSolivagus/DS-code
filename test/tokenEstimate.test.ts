import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('../src/config.js', () => ({ loadSettings: vi.fn(() => ({ provider: 'deepseek', permissions: { allow: [] }, costWarnCNY: 15, maxToolResultChars: 100000 })) }))

import { estimateTextTokens, estimateMessagesTokens, resolveContextWindow, computeCompactThreshold, effectiveThreshold } from '../src/tokenEstimate.js'

describe('estimateTextTokens', () => {
  it('空/undefined/null → 0', () => {
    expect(estimateTextTokens('')).toBe(0)
    expect(estimateTextTokens(undefined)).toBe(0)
    expect(estimateTextTokens(null)).toBe(0)
  })
  it('纯英文按 ×0.3/字（ceil）', () => {
    // 10 个 ASCII 字符 → ceil(10*0.3)=3
    expect(estimateTextTokens('abcdefghij')).toBe(3)
  })
  it('纯中文按 ×0.6/字（ceil）', () => {
    // 5 个中文 → ceil(5*0.6)=3
    expect(estimateTextTokens('你好世界啊')).toBe(3)
  })
  it('中英混排分别加权', () => {
    // 「你好abc」= 2*0.6 + 3*0.3 = 1.2+0.9=2.1 → ceil=3
    expect(estimateTextTokens('你好abc')).toBe(3)
  })
  it('数字标点空白按 ×0.3（非 CJK）', () => {
    // 「a 1!」= 4 字符 *0.3 = 1.2 → ceil=2
    expect(estimateTextTokens('a 1!')).toBe(2)
  })
})

describe('estimateMessagesTokens', () => {
  it('空数组 → 0', () => {
    expect(estimateMessagesTokens([])).toBe(0)
  })
  it('累加各条 content（string）', () => {
    const msgs = [
      { role: 'system', content: 'abcdefghij' }, // 3
      { role: 'user', content: '你好世界啊' },     // 3
    ]
    expect(estimateMessagesTokens(msgs)).toBe(6)
  })
  it('content 为 null 不抛、计 0；assistant tool_calls 估 name+arguments', () => {
    const msgs = [
      { role: 'assistant', content: null, tool_calls: [
        { function: { name: 'Read', arguments: '{"file":"a"}' } }, // 'Read{"file":"a"}'=16字符*0.3=4.8→单条但整体 ceil
      ] },
    ]
    // 'Read' + '{"file":"a"}' = 4+12 = 16 ASCII → 16*0.3=4.8 → ceil=5
    expect(estimateMessagesTokens(msgs)).toBe(5)
  })
  it('tool 消息 content 计入', () => {
    const msgs = [{ role: 'tool', tool_call_id: 'x', content: 'abcdefghij' }] // 3
    expect(estimateMessagesTokens(msgs)).toBe(3)
  })
})

describe('resolveContextWindow', () => {
  const ORIG = process.env.DEEPCODE_MAX_CONTEXT_TOKENS
  afterEach(() => { if (ORIG === undefined) delete process.env.DEEPCODE_MAX_CONTEXT_TOKENS; else process.env.DEEPCODE_MAX_CONTEXT_TOKENS = ORIG })
  it('flash/pro → 1M', () => {
    expect(resolveContextWindow('deepseek-v4-flash')).toBe(1_000_000)
    expect(resolveContextWindow('deepseek-v4-pro')).toBe(1_000_000)
  })
  it('未知模型 → active provider defaultMeta（deepseek = 1M）', () => {
    expect(resolveContextWindow('some-other-model')).toBe(1_000_000)
  })
  it('env 覆盖优先', () => {
    process.env.DEEPCODE_MAX_CONTEXT_TOKENS = '500000'
    expect(resolveContextWindow('deepseek-v4-flash')).toBe(500_000)
  })
  it('env 非法值忽略，回落模型表', () => {
    process.env.DEEPCODE_MAX_CONTEXT_TOKENS = 'abc'
    expect(resolveContextWindow('deepseek-v4-flash')).toBe(1_000_000)
  })
})

describe('computeCompactThreshold', () => {
  it('flash = 1M − 16k − 13k = 971k', () => {
    expect(computeCompactThreshold('deepseek-v4-flash')).toBe(971_000)
  })
  it('未知模型 = active defaultMeta window − 29k（deepseek = 1M − 29k = 971k）', () => {
    expect(computeCompactThreshold('x')).toBe(971_000)
  })
})

describe('effectiveThreshold', () => {
  it('未设 compactTokens → 派生 971k', () => {
    expect(effectiveThreshold('deepseek-v4-flash', undefined)).toBe(971_000)
  })
  it('设了更小 → 取 compactTokens', () => {
    expect(effectiveThreshold('deepseek-v4-flash', 200_000)).toBe(200_000)
  })
  it('设了更大 → 取派生', () => {
    expect(effectiveThreshold('deepseek-v4-flash', 5_000_000)).toBe(971_000)
  })
})

describe('resolveContextWindow 多 provider', () => {
  const orig = process.env.DEEPCODE_MAX_CONTEXT_TOKENS
  afterEach(() => { if (orig === undefined) delete process.env.DEEPCODE_MAX_CONTEXT_TOKENS; else process.env.DEEPCODE_MAX_CONTEXT_TOKENS = orig })
  it('已知 deepseek 档 = 1M', () => {
    delete process.env.DEEPCODE_MAX_CONTEXT_TOKENS
    expect(resolveContextWindow('deepseek-v4-flash')).toBe(1_000_000)
  })
  it('未来 deepseek-v4.1-pro 走 defaultMeta = 1M（非全局 200k）', () => {
    delete process.env.DEEPCODE_MAX_CONTEXT_TOKENS
    expect(resolveContextWindow('deepseek-v4.1-pro')).toBe(1_000_000)
  })
  it('env 覆盖优先', () => {
    process.env.DEEPCODE_MAX_CONTEXT_TOKENS = '50000'
    expect(resolveContextWindow('deepseek-v4-flash')).toBe(50000)
  })
})
