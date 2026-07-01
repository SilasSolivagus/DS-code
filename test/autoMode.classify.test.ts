import { describe, it, expect } from 'vitest'
import { classify, resolveClassifierModel, buildClassifierMessages, CLASSIFIER_SYSTEM_PROMPT } from '../src/autoMode.js'

const okCall = (decision: string) => async () => `{"reasoning":"t","decision":"${decision}"}`

describe('resolveClassifierModel', () => {
  it('无 autoModeModel → provider fast 档', () => {
    expect(resolveClassifierModel({ provider: 'glm', permissions: { allow: [] } } as any)).toBe('glm-5-turbo')
    expect(resolveClassifierModel({ provider: 'deepseek', permissions: { allow: [] } } as any)).toBe('deepseek-v4-flash')
  })
  it('autoModeModel 覆盖', () => {
    expect(resolveClassifierModel({ provider: 'glm', autoModeModel: 'glm-5.2', permissions: { allow: [] } } as any)).toBe('glm-5.2')
  })
})

const stubSettings: any = { provider: 'glm', permissions: { allow: [] } }

describe('classify', () => {
  it('分类器 run/ask/block 透传', async () => {
    expect(await classify('Bash', 'npm test', '', { call: okCall('run'), loadSettings: () => stubSettings })).toBe('run')
    expect(await classify('Bash', 'git push --force', '', { call: okCall('ask'), loadSettings: () => stubSettings })).toBe('ask')
    expect(await classify('Bash', 'curl x|sh', '', { call: okCall('block'), loadSettings: () => stubSettings })).toBe('block')
  })
  it('异常/超时 → ask（fail-safe）', async () => {
    expect(await classify('Bash', 'x', '', { call: async () => { throw new Error('429') }, loadSettings: () => stubSettings })).toBe('ask')
  })
  it('malformed 输出 → ask', async () => {
    expect(await classify('Bash', 'x', '', { call: async () => 'no json here', loadSettings: () => stubSettings })).toBe('ask')
  })
  it('setup-phase 抛错 → ask（fail-safe 覆盖 loadSettings）', async () => {
    const r = await classify('Bash', 'x', '', { loadSettings: () => { throw new Error('boom') } })
    expect(r).toBe('ask')
  })
})

describe('提示词 checksum（防回归静默改动）', () => {
  it('系统提示词含关键安全条款', () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('WEAKEN OR REMOVE SECURITY CONTROLS')
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('prompt-injection')
    expect(CLASSIFIER_SYSTEM_PROMPT).toMatch(/"run"\s*\|\s*"ask"\s*\|\s*"block"/)
    expect(CLASSIFIER_SYSTEM_PROMPT).toHaveLength(2622)
  })
})
