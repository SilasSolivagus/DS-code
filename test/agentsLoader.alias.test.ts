import { describe, it, expect } from 'vitest'
import { resolveAgentModelAlias } from '../src/agentsLoader.js'
import { BUILTIN_PROVIDERS } from '../src/providers.js'

const ds = BUILTIN_PROVIDERS.deepseek
const glm = BUILTIN_PROVIDERS.glm

describe('resolveAgentModelAlias 档语义 + 前缀透传', () => {
  it('inherit/空 → inherit', () => {
    expect(resolveAgentModelAlias('inherit', ds)).toBe('inherit')
    expect(resolveAgentModelAlias(undefined, ds)).toBeUndefined()
  })
  it('能力档别名 → smart/flash 词汇', () => {
    expect(resolveAgentModelAlias('opus', ds)).toBe('smart')
    expect(resolveAgentModelAlias('sonnet', ds)).toBe('smart')
    expect(resolveAgentModelAlias('best', ds)).toBe('smart')
    expect(resolveAgentModelAlias('haiku', ds)).toBe('flash')
    expect(resolveAgentModelAlias('flash', ds)).toBe('flash')
    expect(resolveAgentModelAlias('fast', ds)).toBe('flash')
  })
  it('归属 active provider 的具体 id → 透传（含未来新档）', () => {
    expect(resolveAgentModelAlias('deepseek-v4-pro', ds)).toBe('deepseek-v4-pro')
    expect(resolveAgentModelAlias('deepseek-v4.1-pro', ds)).toBe('deepseek-v4.1-pro') // 前向兼容
    expect(resolveAgentModelAlias('glm-4.6', glm)).toBe('glm-4.6')
    expect(resolveAgentModelAlias('glm-5.3', glm)).toBe('glm-5.3') // 前向兼容
  })
  it('跨 provider id → inherit（安全兜底）', () => {
    expect(resolveAgentModelAlias('deepseek-v4-pro', glm)).toBe('inherit')
    expect(resolveAgentModelAlias('glm-4.6', ds)).toBe('inherit')
    expect(resolveAgentModelAlias('claude-opus-4', ds)).toBe('inherit')
  })
})
