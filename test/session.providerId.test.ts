import { describe, it, expect } from 'vitest'
import { resolveResumeModel } from '../src/tui/resumeModel.js'
import { BUILTIN_PROVIDERS } from '../src/providers.js'

describe('resolveResumeModel 漂移校验', () => {
  it('session model 归属 active provider → 保留', () => {
    expect(resolveResumeModel('deepseek-v4-pro', BUILTIN_PROVIDERS.deepseek)).toBe('deepseek-v4-pro')
  })
  it('session model 跨 provider（glm 模型 + active=deepseek）→ 回落 active fast', () => {
    expect(resolveResumeModel('glm-5.2', BUILTIN_PROVIDERS.deepseek)).toBe('deepseek-v4-flash')
  })
  it('未来新档（同 provider 前缀）→ 保留', () => {
    expect(resolveResumeModel('deepseek-v4.1-pro', BUILTIN_PROVIDERS.deepseek)).toBe('deepseek-v4.1-pro')
  })
})
