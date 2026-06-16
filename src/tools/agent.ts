// src/tools/agent.ts
import fs from 'node:fs'
import path from 'node:path'
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
import { generateTaskId, registerTask, updateTask, getTask, enqueueNotification } from '../tasks.js'
import { taskOutputPath } from '../config.js'

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

      // 跑子代理子循环，返回最后一条 assistant 文本（前后台共用）。
      // SubagentStart：开头注入 additionalContext；SubagentStop：结束后 preventContinuation→续跑一轮（守卫限一次）。
      const runSub = async (signal: AbortSignal, agentId: string): Promise<string | undefined> => {
        const messages: any[] = [
          { role: 'system', content: def.getSystemPrompt() },
          { role: 'user', content: input.prompt },
        ]
        if (ctx.hookDispatch) {
          const startOut = await ctx.hookDispatch('SubagentStart', {
            hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: type, cwd: ctx.cwd(),
          })
          if (startOut.additionalContext) {
            messages.push({ role: 'user', content: `<hook-context>\n${startOut.additionalContext}\n</hook-context>` })
          }
        }
        const subCtx: ToolContext = {
          cwd: ctx.cwd,
          setCwd: () => { /* 子代理只读，不许漂移主 cwd */ },
          get signal() { return signal }, // 前台=主 loop signal；后台=任务 AbortController（供 TaskStop）
          fileState: new Map(), // 独立 fileState，不污染主会话 read-before-edit 状态
          isSubagent: true, // 子代理纯执行：禁止起后台任务（防污染主会话通知队列）
        }
        let subStopFired = false
        while (true) {
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
          if (ctx.hookDispatch && !signal.aborted) {
            const stopOut = await ctx.hookDispatch('SubagentStop', {
              hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: type, cwd: ctx.cwd(),
              stop_hook_active: subStopFired,
              last_assistant_message: final?.content ?? '',
            })
            // continue:false（硬停）优先于 block 续跑：即便另一 hook 要续跑，continue:false 也压倒之。
            if (stopOut.stop) return final?.content
            if (stopOut.preventContinuation && !subStopFired) {
              subStopFired = true
              messages.push({ role: 'user', content: stopOut.blockReason ?? '（SubagentStop 要求继续未尽事项）' })
              continue
            }
          }
          return final?.content
        }
      }

      // 后台路径：脱钩跑、立即返句柄；信号量在脱钩 async 的 finally 释放（不能在 call 返回前 release）。
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
        void (async () => {
          await acquire() // 在脱钩 async 内等许可：句柄立即返回、不阻塞主 loop 只读批
          try {
            const final = await runSub(ac.signal, id)
            // runLoop 在 abort 时是 return 'aborted'（不抛错），runSub 仍正常返回——
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
            release()
          }
        })()
        return `后台子代理已启动 id=${id}（类型 ${type}）。完成时会通知你。`
      }

      // 前台路径（默认）：维持现有 acquire/try-finally-release。
      await acquire()
      try {
        // 前台无 task 注册：生成一个 a-前缀 id 纯作 SubagentStart/Stop hook 的 agent_id 标签（不入 TaskRegistry）。
        const final = await runSub(ctx.signal, generateTaskId('local_agent'))
        return final ?? '（子代理无输出）'
      } finally {
        release()
      }
    },
  }
}
