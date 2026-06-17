// src/subagentRunner.ts —— Agent 工具与 forked skill 共用的子代理运行器 + 单例并发信号量。
// 铁律：信号量只此一份，外部都 import 这里（复制 = 4 并发上限静默翻倍）。
import type OpenAI from 'openai'
import type { z } from 'zod'
import type { Tool, ToolContext } from './tools/types.js'
import type { Usage } from './api.js'
import { runLoop } from './loop.js'
import { makeStructuredOutputTool, structuredOutputReminder, MAX_STRUCTURED_OUTPUT_RETRIES } from './tools/structuredOutput.js'
import { subagentPermissionDecision } from './tools/agent.js'

// 子代理并发上限 4（spec §4）。Agent 是只读工具会进 loop 的并发批（上限 5），用信号量再压一层。
const MAX_ACTIVE = 4
let active = 0
const waiters: Array<() => void> = []
export async function acquire(): Promise<void> {
  if (active < MAX_ACTIVE) { active++; return }
  await new Promise<void>(r => waiters.push(r)) // 许可由 release 移交，不再自增
}
export function release(): void {
  const next = waiters.shift()
  if (next) next() // 移交许可：active 不变
  else active--
}

export interface RunSubagentOpts {
  client: OpenAI
  onUsage: (u: Usage, model: string) => void
  systemPrompt: string
  userPrompt: string
  tools: Tool<any>[]
  model: string
  outputSchema?: z.ZodTypeAny
  ctx: ToolContext
  signal: AbortSignal
  agentId: string
  agentType: string
}

/** 跑子代理子循环，返回最后一条 assistant 文本或结构化 JSON。SubagentStart/Stop hook + L-044 结构化输出。
 *  acquire/release 由调用方在外层管（agent.ts 前后台、skill.ts forked），本函数不碰信号量。 */
export async function runSubagent(opts: RunSubagentOpts): Promise<string | undefined> {
  const { ctx, signal, agentId, agentType: type } = opts
  const messages: any[] = [
    { role: 'system', content: opts.systemPrompt },
    { role: 'user', content: opts.userPrompt },
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
  // L-044：声明 outputSchema → 注入 StructuredOutput 工具，强制子代理产出校验对象。
  let captured: unknown
  let structuredRetries = 0
  const subTools = opts.outputSchema
    ? [...opts.tools, makeStructuredOutputTool(opts.outputSchema, v => { captured = v })]
    : opts.tools
  while (true) {
    const gen = runLoop(messages, {
      client: opts.client,
      tools: subTools,
      model: opts.model,
      thinking: false,
      // 子代理无审批 UI：安全命令自动放行、危险命令拒绝（yolo+钳制，见 subagentPermissionDecision）。
      permission: { mode: 'default', rules: [], saveRule: () => {}, ask: async (_n, desc) => subagentPermissionDecision(desc) },
      ctx: subCtx,
      maxTurns: 30,
    })
    let step
    while (!(step = await gen.next()).done) {
      if (step.value.type === 'turn_end') opts.onUsage(step.value.usage, opts.model)
    }
    const final = [...messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content)
    // L-044 强约束：声明了 schema 但本轮还没拿到校验对象 → 注入提醒续跑（≤MAX 次；独立于 subStopFired 配额）。
    if (opts.outputSchema && captured === undefined) {
      if (structuredRetries < MAX_STRUCTURED_OUTPUT_RETRIES) {
        structuredRetries++
        messages.push({ role: 'user', content: structuredOutputReminder() })
        continue
      }
      // 超限：fail-safe 兜底返回末条文本（不死循环）。
    }
    // L-044：结构化对象优先于自由文本（声明 schema 且已捕获→返回校验 JSON，否则末条文本）。
    const result = captured !== undefined ? JSON.stringify(captured) : final?.content
    if (ctx.hookDispatch && !signal.aborted) {
      const stopOut = await ctx.hookDispatch('SubagentStop', {
        hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: type, cwd: ctx.cwd(),
        stop_hook_active: subStopFired,
        last_assistant_message: final?.content ?? '',
      })
      // continue:false（硬停）优先于 block 续跑：即便另一 hook 要续跑，continue:false 也压倒之。
      if (stopOut.stop) return result
      if (stopOut.preventContinuation && !subStopFired) {
        subStopFired = true
        messages.push({ role: 'user', content: stopOut.blockReason ?? '（SubagentStop 要求继续未尽事项）' })
        continue
      }
    }
    return result
  }
}
