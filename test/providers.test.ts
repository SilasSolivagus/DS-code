import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
vi.mock('../src/config.js', () => ({
  loadSettings: () => ({ permissions: { allow: [] }, costWarnCNY: 15, maxToolResultChars: 100000 }),
}))
import {
  BUILTIN_PROVIDERS, resolveActiveProvider, modelMeta, belongsToProvider,
  resolveSubModel, __resetProviderCache, type ProviderPreset, type Settings,
} from '../src/providers.js'

beforeEach(() => __resetProviderCache())

const baseSettings = (over: Partial<any> = {}): any => ({
  permissions: { allow: [] }, costWarnCNY: 15, maxToolResultChars: 100000, ...over,
})

describe('providers 内置表', () => {
  it('deepseek 默认 + glm 内置，档位/方言/前缀正确', () => {
    expect(BUILTIN_PROVIDERS.deepseek.models).toEqual({ fast: 'deepseek-v4-flash', smart: 'deepseek-v4-pro' })
    expect(BUILTIN_PROVIDERS.deepseek.dialect).toBe('deepseek')
    expect(BUILTIN_PROVIDERS.deepseek.baseURL).toBe('https://api.deepseek.com')
    expect(BUILTIN_PROVIDERS.glm.models).toEqual({ fast: 'glm-5-turbo', smart: 'glm-5.2' })
    expect(BUILTIN_PROVIDERS.glm.dialect).toBe('glm')
    expect(BUILTIN_PROVIDERS.glm.apiKeyEnv).toBe('ZHIPUAI_API_KEY')
    expect(BUILTIN_PROVIDERS.glm.meta['glm-5.2'].contextWindow).toBe(1_000_000)
    expect(BUILTIN_PROVIDERS.glm.meta['glm-5.2'].out).toBeGreaterThan(0)
  })
})

describe('resolveActiveProvider', () => {
  it('缺省 → deepseek', () => {
    expect(resolveActiveProvider(baseSettings()).id).toBe('deepseek')
  })
  it('provider:glm → glm preset', () => {
    expect(resolveActiveProvider(baseSettings({ provider: 'glm' })).id).toBe('glm')
  })
  it('provider:custom + providers.custom → 自定义 preset（dialect 缺省 openai）', () => {
    const p = resolveActiveProvider(baseSettings({
      provider: 'custom',
      providers: { custom: { baseURL: 'https://x.test/v1', models: { fast: 'm-s', smart: 'm-l' } } },
    }))
    expect(p.id).toBe('custom')
    expect(p.baseURL).toBe('https://x.test/v1')
    expect(p.dialect).toBe('openai')
    expect(p.models).toEqual({ fast: 'm-s', smart: 'm-l' })
  })
  it('provider:custom 但无 providers.custom → 回落 deepseek', () => {
    expect(resolveActiveProvider(baseSettings({ provider: 'custom' })).id).toBe('deepseek')
  })
})

describe('modelMeta fail-safe', () => {
  it('已知 id → meta；未知 id → defaultMeta', () => {
    const ds = BUILTIN_PROVIDERS.deepseek
    expect(modelMeta(ds, 'deepseek-v4-flash').miss).toBe(1)
    // 未来 v4.1：不在 meta → defaultMeta（1M window，非全局 200k）
    expect(modelMeta(ds, 'deepseek-v4.1-pro').contextWindow).toBe(1_000_000)
    expect(modelMeta(ds, 'deepseek-v4.1-pro').out).toBeGreaterThan(0)
  })
})

describe('belongsToProvider', () => {
  it('有 modelPrefix → 前缀判定（含未来新档）', () => {
    expect(belongsToProvider(BUILTIN_PROVIDERS.deepseek, 'deepseek-v4.1-pro')).toBe(true)
    expect(belongsToProvider(BUILTIN_PROVIDERS.deepseek, 'glm-4.6')).toBe(false)
    expect(belongsToProvider(BUILTIN_PROVIDERS.glm, 'glm-5.3')).toBe(true)
  })
  it('前缀过宽守卫：无连字符的相近前缀不误判', () => {
    expect(belongsToProvider(BUILTIN_PROVIDERS.deepseek, 'deepseekfoo')).toBe(false)
    expect(belongsToProvider(BUILTIN_PROVIDERS.glm, 'glmbar')).toBe(false)
  })
  it('custom 无前缀 → meta∪models 成员判定', () => {
    const p: ProviderPreset = {
      id: 'custom', baseURL: 'x', apiKeyEnv: 'K', dialect: 'openai',
      models: { fast: 'a', smart: 'b' }, meta: { c: { hit: 0, miss: 0, out: 0, contextWindow: 1, supportsThinking: false } },
      defaultMeta: { hit: 0, miss: 0, out: 0, contextWindow: 1, supportsThinking: false },
    }
    expect(belongsToProvider(p, 'a')).toBe(true)
    expect(belongsToProvider(p, 'c')).toBe(true)
    expect(belongsToProvider(p, 'zzz')).toBe(false)
  })
})

describe('resolveSubModel', () => {
  it('inherit/undefined → 父；flash/fast → active fast；smart → active smart；具体 → 透传', () => {
    // active = deepseek（默认）
    expect(resolveSubModel(undefined, 'P')).toBe('P')
    expect(resolveSubModel('inherit', 'P')).toBe('P')
    expect(resolveSubModel('flash', 'P')).toBe('deepseek-v4-flash')
    expect(resolveSubModel('fast', 'P')).toBe('deepseek-v4-flash')
    expect(resolveSubModel('smart', 'P')).toBe('deepseek-v4-pro')
    expect(resolveSubModel('deepseek-v4-pro', 'P')).toBe('deepseek-v4-pro')
  })
})
