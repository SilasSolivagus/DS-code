// src/tools/agentTypes.ts
// L-040 子代理类型化：AgentDefinition 接口 + 内建注册表 + 纯函数工具解析（对齐 CC）。
import type { z } from 'zod'
import type { Tool } from './types.js'

export interface AgentDefinition {
  agentType: string // 路由键
  whenToUse: string // 喂模型决定何时用（= CC 的 description）
  tools?: string[] // allow 列表；undefined 或 ['*'] = 通配（全池减 deny）
  disallowedTools?: string[] // deny 列表
  model?: 'inherit' | string // 省略 = 'inherit'（父当前模型）；可钉具体档（如 'flash'）
  /** L-044：声明则强制子代理用 StructuredOutput 工具按此 schema 产出，结果取校验对象的 JSON（非自由文本）。 */
  outputSchema?: z.ZodTypeAny
  getSystemPrompt(): string // 每类一段独立 prompt
}

// 全局子代理 deny：仅 ExitPlanMode（子代理无 plan 模式 UI）。
// Edit/Write/NotebookEdit 移除→可写；Agent 移除→可递归派子代理（照搬 CC，删信号量后无死锁）。
export const GLOBAL_SUBAGENT_DENY = ['ExitPlanMode']

/**
 * 照搬 CC resolveAgentTools 三步：deny 永远赢 allow；无 allow = 通配 = 全池减 deny。
 * 1. 基础池 = pool 减全局 deny。
 * 2. 类型 deny = 再减 def.disallowedTools。
 * 3. allow 解析：def.tools undefined 或 ['*'] → 通配（步②结果）；否则逐个按名在「已减 deny 的池」查、命中保留。
 */
export function resolveAgentTools(def: AgentDefinition, pool: Tool<any>[], globalDeny: string[]): Tool<any>[] {
  const denied = new Set([...globalDeny, ...(def.disallowedTools ?? [])])
  const base = pool.filter(t => !denied.has(t.name))
  const allow = def.tools
  if (!allow || (allow.length === 1 && allow[0] === '*')) return base
  const allowSet = new Set(allow)
  return base.filter(t => allowSet.has(t.name))
}

const GENERAL_SYSTEM = `你是一个通用子代理，在终端代码库中工作。可用完整工具集（Read/Edit/Write/Bash/Agent/WebFetch 等）。
适合开放式搜索、跨多文件理解架构、执行多步任务（含代码修改）；可并行委派子代理。
你的最终回复会作为工具结果原文返回给主代理：只输出结论与证据（带文件路径与行号），不要寒暄、不要提问。
查不到就明确说查不到，不要编造。`

const EXPLORE_SYSTEM = `你是一个只读搜索专家（READ-ONLY），在终端代码库中工作。
任务是快速定位代码/实现位置，可按 quick / medium / very thorough 调整搜索力度。
优先用 Glob 按文件名/路径定位、用 Grep 按内容定位，再用 Read 看关键片段。
你严格只读：绝不修改任何文件。
最终回复作为工具结果原文返回：只给定位结论与证据（文件路径与行号），不寒暄、不提问，查不到就明说。`

const PLAN_SYSTEM = `你是一个软件架构师子代理（READ-ONLY），在终端代码库中工作。
先用只读工具（Read/Glob/Grep）探索代码，理解现状与约束，再产出可执行的实施计划。
你严格只读：探索阶段绝不修改任何文件。
最终回复作为工具结果原文返回：给出分步实施计划与架构取舍，并在末尾列出「实施关键文件」清单（路径）。
不寒暄、不提问。`

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    agentType: 'general-purpose',
    whenToUse: '研究复杂问题、搜代码、执行多步任务；不确定能否一次命中时用它',
    tools: ['*'],
    model: 'inherit',
    getSystemPrompt: () => GENERAL_SYSTEM,
  },
  {
    agentType: 'Explore',
    whenToUse: '快速只读搜代码/定位实现，可指定 quick/medium/very thorough 力度',
    disallowedTools: ['Edit', 'Write', 'Agent'],
    model: 'flash',
    getSystemPrompt: () => EXPLORE_SYSTEM,
  },
  {
    agentType: 'Plan',
    whenToUse: '软件架构师，设计实施计划',
    disallowedTools: ['Edit', 'Write', 'Agent'],
    model: 'inherit',
    getSystemPrompt: () => PLAN_SYSTEM,
  },
]

/** CC formatAgentLine 口径：- {agentType}: {whenToUse} (Tools: {toolsDesc}) */
export function formatAgentLine(def: AgentDefinition): string {
  const allow = def.tools
  const wildcard = !allow || (allow.length === 1 && allow[0] === '*')
  let toolsDesc: string
  if (!wildcard) toolsDesc = allow!.join(',')
  else if (def.disallowedTools && def.disallowedTools.length) toolsDesc = `All tools except ${def.disallowedTools.join(',')}`
  else toolsDesc = 'All tools'
  return `- ${def.agentType}: ${def.whenToUse} (Tools: ${toolsDesc})`
}

/** 把 agents 列表拼成完整 Agent 工具 description（缺省内建，保后向兼容）。 */
export function buildAgentDescription(agents: AgentDefinition[] = BUILTIN_AGENTS): string {
  const lines = agents.map(formatAgentLine).join('\n')
  return `派出一个专才子代理执行任务。子代理看不到当前对话，prompt 必须自包含。返回子代理的最终结论。可用类型：
${lines}
省略 subagent_type 则用 general-purpose。避免重复子代理正在做的工作；独立查询可并行委派多个子代理。`
}
