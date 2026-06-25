// src/subagentRunner.ts —— Agent 工具与 forked skill 共用的子代理运行器。
// 并发由 loop CONCURRENCY=5 只读批每级独立约束（镜像 CC 零上限并发，无共享阻塞池）。
import type OpenAI from 'openai'
import type { z } from 'zod'
import type { Tool, ToolContext } from './tools/types.js'
import type { Usage } from './api.js'
import { runLoop } from './loop.js'
import { makeStructuredOutputTool, structuredOutputReminder, MAX_STRUCTURED_OUTPUT_RETRIES } from './tools/structuredOutput.js'
import { subagentPermissionDecision } from './tools/agent.js'

// 记忆 fork 专用信号量（独立于用户 subagent 池，防三连点火打爆限流）。
// MAX_MEMORY_ACTIVE=2：extract+sessionMemory+dream 最多 2 个并发，不饿死用户主动起的 Task。
const MAX_MEMORY_ACTIVE = 2
let memActive = 0
const memWaiters: Array<() => void> = []
export async function acquireMemory(): Promise<void> {
  if (memActive < MAX_MEMORY_ACTIVE) { memActive++; return }
  await new Promise<void>(r => memWaiters.push(r)) // 许可由 releaseMemory 移交，不再自增
}
export function releaseMemory(): void {
  const next = memWaiters.shift()
  if (next) next() // 移交许可：memActive 不变
  else memActive--
}

/** 仅测试用：重置记忆信号量状态（memActive/memWaiters）。 */
export function __resetMemorySemaphoreForTest(): void {
  memActive = 0
  memWaiters.length = 0
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
  /** worktree 路径。设置后子代理 cwd 锚定此 worktree，系统提示追加隔离说明。 */
  worktreePath?: string
}

/** worktree 子代理隔离提示（追加在 agent 系统提示后）。对齐 CC H_4。 */
export function worktreeSubagentPrompt(parentCwd: string, worktreePath: string): string {
  return `\n\n你在一个隔离的 git worktree 里工作：${worktreePath}——同一仓库、同样的相对文件结构、独立工作副本。继承上下文里的路径指向父代理的工作目录（${parentCwd}），需翻译到你的 worktree 根。编辑前先重读文件（父代理可能已改动）。你的改动只留在此 worktree，不会影响父代理的文件。`
}

/** 跑子代理子循环，返回最后一条 assistant 文本或结构化 JSON。SubagentStart/Stop hook + L-044 结构化输出。 */
export async function runSubagent(opts: RunSubagentOpts): Promise<string | undefined> {
  const { ctx, signal, agentId, agentType: type } = opts
  const sysPrompt = opts.worktreePath
    ? opts.systemPrompt + worktreeSubagentPrompt(ctx.cwd(), opts.worktreePath)
    : opts.systemPrompt
  const messages: any[] = [
    { role: 'system', content: sysPrompt },
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
  let subCwd = opts.worktreePath ?? ctx.cwd()
  const subCtx: ToolContext = {
    cwd: () => subCwd,
    setCwd: d => { subCwd = d }, // 独立变量：子代理内 Bash cd 漂移自身 cwd，不污染主 cwd
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
