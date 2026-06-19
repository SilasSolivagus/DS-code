// test/configTool.test.ts
import { describe, it, expect } from 'vitest'
import { configTool, CONFIG_KEYS } from '../src/tools/configTool.js'
import { loadRawUserSettings, saveRawUserSettings } from '../src/config.js'
import { allTools } from '../src/tools/index.js'

const ctx: any = { cwd: () => process.cwd(), signal: new AbortController().signal, fileState: new Map() }

describe('configTool 白名单', () => {
  it('CONFIG_KEYS 恰好 6 键', () => {
    expect(Object.keys(CONFIG_KEYS).sort()).toEqual(
      ['compactTokens', 'costWarnCNY', 'inline', 'maxToolResultChars', 'model', 'skills.listingBudgetChars'].sort(),
    )
  })
  it('GET 已知键返回 "key = value"', async () => {
    const out = await configTool.call({ setting: 'compactTokens' }, ctx)
    expect(out).toMatch(/^compactTokens = /)
  })
  it('未知键被拒', async () => {
    expect(await configTool.call({ setting: 'nope' }, ctx)).toContain('未知设置')
  })
  it('敏感键 GET/SET 都被拒，且不写文件', async () => {
    const before = loadRawUserSettings()
    try {
      expect(await configTool.call({ setting: 'apiKey' }, ctx)).toContain('受保护')
      expect(await configTool.call({ setting: 'hooks', value: 'x' }, ctx)).toContain('受保护')
      expect(await configTool.call({ setting: 'permissions.allow', value: 'x' }, ctx)).toContain('受保护')
      expect(loadRawUserSettings().apiKey).toBe(before.apiKey) // 未被触碰
    } finally { saveRawUserSettings(before) }
  })
})

describe('configTool 类型校验', () => {
  it('compactTokens 非正整数被拒', async () => {
    expect(await configTool.call({ setting: 'compactTokens', value: -1 }, ctx)).toContain('正整数')
    expect(await configTool.call({ setting: 'compactTokens', value: 1.5 }, ctx)).toContain('正整数')
  })
  it('inline 接受 bool 与 "true"/"false"，拒其它', async () => {
    const before = loadRawUserSettings()
    try {
      expect(await configTool.call({ setting: 'inline', value: 'true' }, ctx)).toContain('已设置')
      expect(loadRawUserSettings().inline).toBe(true)
      expect(await configTool.call({ setting: 'inline', value: 'maybe' }, ctx)).toContain('true 或 false')
    } finally { saveRawUserSettings(before) }
  })
  it('model 空串被拒', async () => {
    expect(await configTool.call({ setting: 'model', value: '  ' }, ctx)).toContain('非空')
  })
})

describe('configTool SET 走 raw user RMW', () => {
  it('SET compactTokens 持久化且不动其它键，回显原值', async () => {
    const before = loadRawUserSettings()
    try {
      const out = await configTool.call({ setting: 'compactTokens', value: 12345 }, ctx)
      expect(out).toContain('已设置 compactTokens = 12345')
      expect(loadRawUserSettings().compactTokens).toBe(12345)
      expect(loadRawUserSettings().costWarnCNY).toBe(before.costWarnCNY) // 其它键不变
    } finally { saveRawUserSettings(before) }
  })
  it('SET skills.listingBudgetChars 不破坏既有 skills.deny', async () => {
    const before = loadRawUserSettings()
    try {
      const seed = { ...before, skills: { deny: ['cso'], listingBudgetChars: 8000 } }
      saveRawUserSettings(seed)
      await configTool.call({ setting: 'skills.listingBudgetChars', value: 4000 }, ctx)
      const after = loadRawUserSettings()
      expect(after.skills?.listingBudgetChars).toBe(4000)
      expect(after.skills?.deny).toEqual(['cso'])
    } finally { saveRawUserSettings(before) }
  })
})

describe('configTool 权限', () => {
  it('GET needsPermission=false（auto-allow），SET=desc', () => {
    expect(configTool.needsPermission({ setting: 'model' })).toBe(false)
    expect(configTool.needsPermission({ setting: 'model', value: 'pro' })).toBe('Config(set model)')
    expect(configTool.isReadOnly).toBe(false)
  })
  it('skills 父键（非嵌套）被拒为未知', async () => {
    expect(await configTool.call({ setting: 'skills' }, ctx)).toContain('未知设置')
    expect(await configTool.call({ setting: 'skills.deny', value: 'x' }, ctx)).toContain('未知设置')
  })
  it('needsPermission：非白名单 SET 也 auto-allow（false），不弹误导提示', () => {
    expect(configTool.needsPermission({ setting: 'apiKey', value: 'x' })).toBe(false)
    expect(configTool.needsPermission({ setting: 'model', value: 'pro' })).toBe('Config(set model)')
  })
})

describe('configTool compactTokens 语义', () => {
  it('GET compactTokens 未设时显示「走模型派生阈值」友好文案', async () => {
    const before = loadRawUserSettings()
    try {
      // 确保 raw settings 中无 compactTokens
      const seed = { ...before }
      delete seed.compactTokens
      saveRawUserSettings(seed)
      const out = await configTool.call({ setting: 'compactTokens' }, ctx)
      expect(out).toContain('未设')
      expect(out).toContain('派生阈值')
    } finally { saveRawUserSettings(before) }
  })
  it('GET compactTokens 显式设值时返回数字', async () => {
    const before = loadRawUserSettings()
    try {
      saveRawUserSettings({ ...before, compactTokens: 200000 })
      const out = await configTool.call({ setting: 'compactTokens' }, ctx)
      expect(out).toBe('compactTokens = 200000')
    } finally { saveRawUserSettings(before) }
  })
})

describe('configTool 注册', () => {
  it('Config 工具在 allTools 中', () => {
    expect(allTools.find(t => t.name === 'Config')).toBeTruthy()
  })
})
