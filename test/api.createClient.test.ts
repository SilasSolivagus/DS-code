import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/config.js', () => ({
  loadSettings: vi.fn(),
}))
import { loadSettings } from '../src/config.js'
import { createClient } from '../src/api.js'

const base = (over: any = {}): any => ({ permissions: { allow: [] }, costWarnCNY: 15, maxToolResultChars: 100000, ...over })

describe('createClient 多 provider', () => {
  const origEnv = { ...process.env }
  afterEach(() => { process.env = { ...origEnv }; vi.clearAllMocks() })

  it('provider:glm → bigmodel baseURL + 读 ZHIPUAI_API_KEY', () => {
    process.env.ZHIPUAI_API_KEY = 'zk.123'
    delete process.env.DEEPSEEK_API_KEY
    ;(loadSettings as any).mockReturnValue(base({ provider: 'glm' }))
    const c = createClient()
    expect(c.baseURL).toBe('https://open.bigmodel.cn/api/paas/v4')
  })

  it('provider:glm 用 settings.providers.glm.apiKey 兜底', () => {
    delete process.env.ZHIPUAI_API_KEY
    ;(loadSettings as any).mockReturnValue(base({ provider: 'glm', providers: { glm: { apiKey: 'zk.settings' } } }))
    expect(() => createClient()).not.toThrow()
  })

  it('provider:glm key 全缺 → 错误文案带 glm 与 ZHIPUAI_API_KEY', () => {
    delete process.env.ZHIPUAI_API_KEY
    ;(loadSettings as any).mockReturnValue(base({ provider: 'glm' }))
    expect(() => createClient()).toThrow(/glm|ZHIPUAI_API_KEY/)
  })

  it('缺省（deepseek）行为不变：读 DEEPSEEK_API_KEY + api.deepseek.com', () => {
    process.env.DEEPSEEK_API_KEY = 'sk.1'
    ;(loadSettings as any).mockReturnValue(base())
    const c = createClient()
    expect(c.baseURL).toBe('https://api.deepseek.com')
  })
})
