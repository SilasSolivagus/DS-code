import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/config.js', () => ({ loadSettings: vi.fn(() => ({ provider: 'glm', permissions: { allow: [] }, costWarnCNY: 15, maxToolResultChars: 100000 })) }))
import { resolveSubModel, activeFastModel, __resetProviderCache } from '../src/providers.js'

beforeEach(() => __resetProviderCache())

describe('active=glm 下子调用 model', () => {
  it('activeFastModel = glm-5-turbo', () => {
    expect(activeFastModel()).toBe('glm-5-turbo')
  })
  it('resolveSubModel flash → glm-5-turbo；smart → glm-5.2；inherit → 父', () => {
    expect(resolveSubModel('flash', 'parent-x')).toBe('glm-5-turbo')
    expect(resolveSubModel('smart', 'parent-x')).toBe('glm-5.2')
    expect(resolveSubModel('inherit', 'parent-x')).toBe('parent-x')
  })
})
