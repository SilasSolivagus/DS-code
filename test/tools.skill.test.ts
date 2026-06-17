import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { makeSkillTool } from '../src/tools/skill.js'
import type { SkillDefinition } from '../src/skillsLoader.js'

const baseDeps = { client: {} as any, onUsage: () => {}, getModel: () => 'm', agents: [], skillPool: [] }
const mkCtx = () => ({
  cwd: () => '/p', setCwd: () => {}, signal: new AbortController().signal,
  fileState: new Map(), injectUserMessage: vi.fn(), sessionId: () => 'sess1',
}) as any

const inlineSkill: SkillDefinition = {
  name: 'greet', description: '打招呼', context: 'inline',
  userInvocable: true, modelInvocable: true, skillDir: '/skills/greet', isLegacy: false,
  body: '对 $ARG1 说你好（dir=${DEEPCODE_SKILL_DIR}）',
}

describe('makeSkillTool', () => {
  it('inline：调 injectUserMessage 注入替换后正文，返回激活回执', async () => {
    const tool = makeSkillTool([inlineSkill], baseDeps)
    const ctx = mkCtx()
    const out = await tool.call({ skill: 'greet', args: 'Sam' }, ctx)
    expect(ctx.injectUserMessage).toHaveBeenCalledWith('对 Sam 说你好（dir=/skills/greet）')
    expect(out).toContain('greet') // 激活回执提到 skill 名
  })

  it('缺 skill → 抛错列出可用', async () => {
    const tool = makeSkillTool([inlineSkill], baseDeps)
    await expect(tool.call({ skill: 'nope' }, mkCtx())).rejects.toThrow(/greet/)
  })

  it('modelInvocable=false 的 skill 不可被模型调用', async () => {
    const userOnly = { ...inlineSkill, name: 'secret', modelInvocable: false }
    const tool = makeSkillTool([userOnly], baseDeps)
    await expect(tool.call({ skill: 'secret' }, mkCtx())).rejects.toThrow(/secret/)
  })

  it('forked：走 runSubagent（mock）返回其结果', async () => {
    vi.resetModules()
    vi.doMock('../src/subagentRunner.js', () => ({
      acquire: async () => {}, release: () => {},
      runSubagent: async () => '子代理结果',
    }))
    const { makeSkillTool: mk } = await import('../src/tools/skill.js')
    const forkSkill = { ...inlineSkill, name: 'audit', context: 'fork' as const }
    const tool = mk([forkSkill], baseDeps)
    const out = await tool.call({ skill: 'audit', args: 'x' }, mkCtx())
    expect(out).toBe('子代理结果')
    vi.doUnmock('../src/subagentRunner.js')
  })
})
