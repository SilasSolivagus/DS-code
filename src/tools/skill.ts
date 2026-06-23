// src/tools/skill.ts —— 单个 Skill 工具：模型调用一个本地 skill。inline 经 injectUserMessage 走 user 通道；forked 走 runSubagent。
import { z } from 'zod'
import type OpenAI from 'openai'
import type { Tool, ToolContext } from './types.js'
import type { Usage } from '../api.js'
import type { SkillDefinition } from '../skillsLoader.js'
import { substituteSkillArgs, formatSkillListing } from '../skillsLoader.js'
import { acquire, release, runSubagent } from '../subagentRunner.js'
import { resolveAgentTools, GLOBAL_SUBAGENT_DENY, type AgentDefinition } from './agentTypes.js'
import { resolveSubModel } from '../providers.js'
import { generateTaskId } from '../tasks.js'

const schema = z.object({
  skill: z.string().describe('技能名'),
  args: z.string().optional().describe('传给技能的参数'),
})

export function makeSkillTool(
  skills: SkillDefinition[],
  deps: { client: OpenAI; onUsage: (u: Usage, model: string) => void; getModel: () => string; agents: AgentDefinition[]; skillPool: Tool<any>[]; listingBudgetChars?: number },
): Tool<typeof schema> {
  const callable = skills.filter(s => s.modelInvocable)
  const { text: listing } = formatSkillListing(callable, { budgetChars: deps.listingBudgetChars })
  return {
    name: 'Skill',
    description: `调用一个技能（skill）。调用后该技能的指令会以独立消息交付给你，按其执行。可用技能：\n${listing || '（无）'}`,
    inputSchema: schema,
    isReadOnly: true,
    needsPermission: () => false,
    async call(input, ctx: ToolContext) {
      const skill = callable.find(s => s.name === input.skill)
      if (!skill) {
        throw new Error(`技能 '${input.skill}' 不存在或不可由模型调用。可用：${callable.map(s => s.name).join(', ') || '（无）'}`)
      }
      const filled = substituteSkillArgs(skill.body, input.args ?? '', {
        argNames: skill.argNames, skillDir: skill.skillDir, sessionId: ctx.sessionId?.(),
      })
      if (skill.context === 'fork') {
        // forked：子代理工具集 = skillPool 经 agent def + skill.allowedTools 收窄（只能收窄不能提权）。
        const type = skill.agent ?? 'general-purpose'
        // 未知 agent 类型回落 general-purpose，避免静默拿全池（空 def 的 tools=undefined → 通配）
        const def: AgentDefinition = deps.agents.find(a => a.agentType === type)
          ?? deps.agents.find(a => a.agentType === 'general-purpose')
          ?? { agentType: type, whenToUse: '', getSystemPrompt: () => '' }
        const effectiveDef: AgentDefinition = skill.allowedTools ? { ...def, tools: skill.allowedTools } : def
        const tools = resolveAgentTools(effectiveDef, deps.skillPool, GLOBAL_SUBAGENT_DENY)
        const model = resolveSubModel(skill.model, deps.getModel())
        await acquire()
        try {
          const result = await runSubagent({
            client: deps.client, onUsage: deps.onUsage,
            systemPrompt: filled, userPrompt: input.args ?? '（无参数）',
            tools, model, ctx, signal: ctx.signal,
            agentId: generateTaskId('local_agent'), agentType: type,
          })
          return result ?? '（技能子代理无输出）'
        } finally { release() }
      }
      // inline：正文走 user 通道注入（无信任例外）；返回简短激活回执。
      if (!ctx.injectUserMessage) {
        // 兜底：宿主未接注入通道（不应发生于主会话/headless）。直接返回正文，附说明。
        return `技能 '${skill.name}' 指令：\n${filled}`
      }
      ctx.injectUserMessage(filled)
      return `已激活技能 '${skill.name}'，其指令见下一条消息，请按其执行。`
    },
  }
}
