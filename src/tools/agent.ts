// src/tools/agent.ts
import { z } from 'zod'
import type OpenAI from 'openai'
import type { Tool, ToolContext } from './types.js'
import type { Usage } from '../api.js'
import { runLoop } from '../loop.js'
import { allTools } from './index.js'
import { makeWebFetchTool } from './webfetch.js'
import { SUB_MODEL } from './constants.js'
import { isDangerous, type Decision } from '../permissions.js'
import { BUILTIN_AGENTS, GLOBAL_SUBAGENT_DENY, resolveAgentTools, buildAgentDescription } from './agentTypes.js'

/** 子代理无审批 UI：安全命令自动放行、危险命令拒绝（yolo + isDangerous 钳制）。desc = 工具 needsPermission 文本（Bash 即命令原文）。 */
export function subagentPermissionDecision(desc: string): Decision {
  return isDangerous(desc) ? 'no' : 'yes'
}

const schema = z.object({
  description: z.string().describe('任务的一句话描述（显示给用户）'),
  prompt: z.string().describe('给子代理的完整任务指令。子代理看不到当前对话，指令必须自包含（含路径、要找什么、期望输出）'),
  subagent_type: z.string().optional().describe('专才子代理类型；省略=general-purpose'),
})

// 子代理并发上限 4（spec §4）。Agent 是只读工具会进 loop 的并发批（上限 5），用信号量再压一层。
const MAX_ACTIVE = 4
let active = 0
const waiters: Array<() => void> = []
async function acquire(): Promise<void> {
  if (active < MAX_ACTIVE) { active++; return }
  await new Promise<void>(r => waiters.push(r)) // 许可由 release 移交，不再自增
}
function release(): void {
  const next = waiters.shift()
  if (next) next() // 移交许可：active 不变
  else active--
}

export function makeAgentTool(deps: { client: OpenAI; onUsage: (u: Usage, model: string) => void; getModel: () => string }): Tool<typeof schema> {
  // 子代理工具池 = 主工具集 + WebFetch（resolveAgentTools 会按 deny/allow 裁剪）。
  const pool: Tool<any>[] = [...allTools, makeWebFetchTool({ client: deps.client, onUsage: deps.onUsage })]
  return {
    name: 'Agent',
    description: buildAgentDescription(),
    inputSchema: schema,
    isReadOnly: true,
    needsPermission: () => false,
    async call(input, ctx) {
      const type = input.subagent_type ?? 'general-purpose'
      const def = BUILTIN_AGENTS.find(a => a.agentType === type)
      if (!def) {
        const available = BUILTIN_AGENTS.map(a => a.agentType).join(', ')
        throw new Error(`Agent type '${type}' not found. Available: ${available}`)
      }
      const tools = resolveAgentTools(def, pool, GLOBAL_SUBAGENT_DENY)
      const subModel =
        !def.model || def.model === 'inherit' ? deps.getModel() : def.model === 'flash' ? SUB_MODEL : def.model

      await acquire()
      try {
        const messages: any[] = [
          { role: 'system', content: def.getSystemPrompt() },
          { role: 'user', content: input.prompt },
        ]
        const subCtx: ToolContext = {
          cwd: ctx.cwd,
          setCwd: () => { /* 子代理只读，不许漂移主 cwd */ },
          get signal() { return ctx.signal }, // 主 loop Esc 一并中断子代理
          fileState: new Map(), // 独立 fileState，不污染主会话 read-before-edit 状态
        }
        const gen = runLoop(messages, {
          client: deps.client,
          tools,
          model: subModel,
          thinking: false,
          // 子代理无审批 UI：安全命令自动放行、危险命令拒绝（yolo+钳制，见 subagentPermissionDecision）。
          permission: { mode: 'default', rules: [], saveRule: () => {}, ask: async (_n, desc) => subagentPermissionDecision(desc) },
          ctx: subCtx,
          maxTurns: 30,
        })
        let step
        while (!(step = await gen.next()).done) {
          if (step.value.type === 'turn_end') deps.onUsage(step.value.usage, subModel)
        }
        const final = [...messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content)
        return final?.content ?? '（子代理无输出）'
      } finally {
        release()
      }
    },
  }
}
