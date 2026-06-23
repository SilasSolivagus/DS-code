import { describe, it, expect } from 'vitest'
import { parseProvidersConfig } from '../src/config.js'

describe('parseProvidersConfig', () => {
  it('非对象 → undefined', () => {
    expect(parseProvidersConfig(null)).toBeUndefined()
    expect(parseProvidersConfig('x')).toBeUndefined()
  })
  it('glm.apiKey 字符串保留', () => {
    const p = parseProvidersConfig({ glm: { apiKey: 'k.123' } })
    expect(p?.glm?.apiKey).toBe('k.123')
  })
  it('custom 须有 baseURL + models.fast/smart 才保留', () => {
    expect(parseProvidersConfig({ custom: { models: { fast: 'a', smart: 'b' } } })?.custom).toBeUndefined()
    const ok = parseProvidersConfig({ custom: { baseURL: 'https://x/v1', models: { fast: 'a', smart: 'b' }, dialect: 'glm' } })
    expect(ok?.custom?.baseURL).toBe('https://x/v1')
    expect(ok?.custom?.dialect).toBe('glm')
  })
  it('custom dialect 非法值丢弃', () => {
    const p = parseProvidersConfig({ custom: { baseURL: 'https://x/v1', models: { fast: 'a', smart: 'b' }, dialect: 'bogus' } })
    expect(p?.custom?.dialect).toBeUndefined()
  })
})
