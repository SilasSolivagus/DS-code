import { describe, it, expect } from 'vitest'
import { rotateModel } from '../src/tui/resumeModel.js'
import { BUILTIN_PROVIDERS } from '../src/providers.js'

describe('rotateModel /model 无参轮换', () => {
  it('在 active fast↔smart 间切', () => {
    const glm = BUILTIN_PROVIDERS.glm
    expect(rotateModel('glm-5-turbo', glm)).toBe('glm-5.2')
    expect(rotateModel('glm-5.2', glm)).toBe('glm-5-turbo')
  })
  it('当前是自定义档（非 fast/smart）→ 落 fast', () => {
    expect(rotateModel('glm-4.6', BUILTIN_PROVIDERS.glm)).toBe('glm-5-turbo')
  })
  it('deepseek 默认', () => {
    expect(rotateModel('deepseek-v4-flash', BUILTIN_PROVIDERS.deepseek)).toBe('deepseek-v4-pro')
  })
})
