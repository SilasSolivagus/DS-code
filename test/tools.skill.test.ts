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
  userInvocable: true, modelInvocable: true, skillDir: '/skills/greet', isLegacy: false, priority: 0,
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

describe('makeSkillTool 清单预算', () => {
  const mkSkill = (name: string, description: string) => ({
    name, description, context: 'inline' as const,
    userInvocable: true, modelInvocable: true, skillDir: '/x', isLegacy: false, body: 'b', priority: 0,
  })
  const deps = () => ({
    client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash',
    agents: [], skillPool: [], listingBudgetChars: 250,
  })
  it('超预算 description 含省略行', () => {
    const skills = [0, 1, 2, 3, 4].map(i => mkSkill('n' + i, 'd'.repeat(100)))
    const tool = makeSkillTool(skills, deps())
    expect(tool.description).toMatch(/另有 \d+ 个技能/)
  })
})

describe('makeSkillTool — 未知 agent 类型回落 general-purpose', () => {
  it('skill.agent 指向不存在的类型 → 回落 general-purpose 的 def（含 disallowedTools）', async () => {
    vi.resetModules()
    let capturedTools: string[] | undefined
    vi.doMock('../src/subagentRunner.js', () => ({
      runSubagent: async (opts: any) => { capturedTools = opts.tools?.map((t: any) => t.name); return '结果' },
    }))
    const { makeSkillTool: mk } = await import('../src/tools/skill.js')
    // general-purpose 有 disallowedTools=['Bash']，用于区分：
    //   空 def（tools=undefined→通配）包含 Bash；gp def（disallowedTools=['Bash']）不含 Bash
    const gpDef = {
      agentType: 'general-purpose', whenToUse: '',
      disallowedTools: ['Bash'] as string[],
      getSystemPrompt: () => 'gp-prompt',
    }
    const fakeRead = { name: 'Read', description: '', inputSchema: {} as any, isReadOnly: true, needsPermission: (): false => false, call: async () => '' }
    const fakeBash = { name: 'Bash', description: '', inputSchema: {} as any, isReadOnly: false, needsPermission: (): false => false, call: async () => '' }
    const depsWithGp = {
      client: {} as any, onUsage: () => {}, getModel: () => 'm',
      agents: [gpDef],
      skillPool: [fakeRead, fakeBash],
    }
    const forkSkill: SkillDefinition = {
      name: 'audit', description: '审查', context: 'fork' as const,
      userInvocable: true, modelInvocable: true, skillDir: '/s', isLegacy: false, priority: 0, body: '审查',
      agent: 'unknown-agent', // 不存在的类型 → 应回落 general-purpose
    }
    const tool = mk([forkSkill], depsWithGp)
    await tool.call({ skill: 'audit', args: '' }, mkCtx())
    // 回落 gp def 后 Bash 被 disallowedTools 排除；若用空 def（tools=undefined）则通配包含 Bash
    expect(capturedTools).toContain('Read')
    expect(capturedTools).not.toContain('Bash')
    vi.doUnmock('../src/subagentRunner.js')
  })
})
