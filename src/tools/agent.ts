// src/tools/agent.ts
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type OpenAI from 'openai'
import type { Tool } from './types.js'
import type { Usage } from '../api.js'
import { allTools } from './index.js'
import { makeWebFetchTool } from './webfetch.js'
import { resolveSubModel } from '../providers.js'
import { isDangerous, type Decision } from '../permissions.js'
import { BUILTIN_AGENTS, GLOBAL_SUBAGENT_DENY, resolveAgentTools, buildAgentDescription, type AgentDefinition } from './agentTypes.js'
import { generateTaskId, registerTask, updateTask, getTask, enqueueNotification } from '../tasks.js'
import { taskOutputPath } from '../config.js'
import { runSubagent } from '../subagentRunner.js'

/** 子代理无审批 UI：安全命令自动放行、危险命令拒绝（yolo + isDangerous 钳制）。desc = 工具 needsPermission 文本（Bash 即命令原文）。 */
export function subagentPermissionDecision(desc: string): Decision {
  return isDangerous(desc) ? 'no' : 'yes'
}

const schema = z.object({
  description: z.string().describe('任务的一句话描述（显示给用户）'),
  prompt: z.string().describe('给子代理的完整任务指令。子代理看不到当前对话，指令必须自包含（含路径、要找什么、期望输出）'),
  subagent_type: z.string().optional().describe('专才子代理类型；省略=general-purpose'),
  run_in_background: z.boolean().optional().describe('设为 true 在后台运行子代理；完成时通知你'),
})


export function makeAgentTool(deps: { client: OpenAI; onUsage: (u: Usage, model: string) => void; getModel: () => string; agents?: AgentDefinition[] }): Tool<typeof schema> {
  // WebFetch 只建一次（别每次 call 重建）。
  const webFetch = makeWebFetchTool({ client: deps.client, onUsage: deps.onUsage })
  const agents = deps.agents ?? BUILTIN_AGENTS
  const tool: Tool<typeof schema> = {
    name: 'Agent',
    description: buildAgentDescription(agents),
    inputSchema: schema,
    isReadOnly: true,
    needsPermission: () => false,
    async call(input, ctx) {
      // 子代理工具池 = 主工具集 + WebFetch + Agent 自身（照搬 CC：子代理可递归派子代理）。
      // 自引用闭包：call 运行时 tool 已赋值。Explore/Plan 靠 disallowedTools 含 'Agent' 仍不递归。
      const pool: Tool<any>[] = [...allTools, webFetch, tool]
      const type = input.subagent_type ?? 'general-purpose'
      const def = agents.find(a => a.agentType === type)
      if (!def) {
        const available = agents.map(a => a.agentType).join(', ')
        throw new Error(`Agent type '${type}' not found. Available: ${available}`)
      }
      const tools = resolveAgentTools(def, pool, GLOBAL_SUBAGENT_DENY)
      const subModel =
        resolveSubModel(def.model, deps.getModel())

      // 后台路径：脱钩跑、立即返句柄。
      if (input.run_in_background === true) {
        const id = generateTaskId('local_agent')
        const ac = new AbortController()
        const outputFile = taskOutputPath(id)
        fs.mkdirSync(path.dirname(outputFile), { recursive: true })
        registerTask({
          id, type: 'local_agent', status: 'running',
          description: input.description, prompt: input.prompt,
          abortController: ac, outputFile, outputOffset: 0, notified: false,
          startTime: Date.now(),
        })
        ctx.hookDispatch?.('TaskCreated', { hook_event_name: 'TaskCreated', task_kind: 'background', task_id: id, task_description: input.description }).catch(() => {})
        void (async () => {
          try {
            const final = await runSubagent({
              client: deps.client, onUsage: deps.onUsage,
              systemPrompt: def.getSystemPrompt(), userPrompt: input.prompt,
              tools, model: subModel, outputSchema: def.outputSchema,
              ctx, signal: ac.signal, agentId: id, agentType: type,
            })
            // runLoop 在 abort 时是 return 'aborted'（不抛错），runSubagent 仍正常返回——
            // 必须显式查 ac.signal.aborted，否则被 TaskStop 中断的子代理会被误标 completed。
            if (ac.signal.aborted) {
              updateTask(id, { status: 'killed', endTime: Date.now() })
            } else {
              fs.writeFileSync(outputFile, final ?? '')
              updateTask(id, { status: 'completed', endTime: Date.now(), result: final ?? '（无输出）' })
            }
          } catch {
            updateTask(id, { status: ac.signal.aborted ? 'killed' : 'failed', endTime: Date.now() })
          } finally {
            enqueueNotification(getTask(id)!)
            ctx.hookDispatch?.('TaskCompleted', { hook_event_name: 'TaskCompleted', task_kind: 'background', task_id: id, status: getTask(id)!.status }).catch(() => {})
          }
        })()
        return `后台子代理已启动 id=${id}（类型 ${type}）。完成时会通知你。`
      }

      // 前台路径（默认）：删信号量后直接跑（并发由 loop CONCURRENCY 只读批约束）。
      const final = await runSubagent({
        client: deps.client, onUsage: deps.onUsage,
        systemPrompt: def.getSystemPrompt(), userPrompt: input.prompt,
        tools, model: subModel, outputSchema: def.outputSchema,
        ctx, signal: ctx.signal, agentId: generateTaskId('local_agent'), agentType: type,
      })
      return final ?? '（子代理无输出）'
    },
  }
  return tool
}
