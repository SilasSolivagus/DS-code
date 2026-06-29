import { describe, it, expect } from 'vitest'
import { BUILTIN_PROVIDERS } from '../src/providers.js'
describe('GLM 视觉模型', () => {
  it('收录 glm-4.6v + supportsVision', () => {
    const m = BUILTIN_PROVIDERS.glm.meta['glm-4.6v']
    expect(m).toBeDefined()
    expect(m.supportsVision).toBe(true)
    expect(m.contextWindow).toBe(128_000)
  })
})
