// src/hookRuntime.ts —— 用 deepcode 运行时构造 hooks 的 llm/runAgent（http 用全局 fetch，不在此）
import type OpenAI from 'openai'
import { chatStream, type Usage } from './api.js'
import { runLoop } from './loop.js'
import { allTools } from './tools/index.js'
import { SUB_MODEL } from './tools/constants.js'
import { subagentPermissionDecision } from './tools/agent.js'
import type { HookEngineDeps } from './hooks.js'
import { registerAsync } from './hookTasks.js'
import type { ToolContext } from './tools/types.js'
import { z } from 'zod'
import { makeStructuredOutputTool, structuredOutputReminder, MAX_STRUCTURED_OUTPUT_RETRIES } from './tools/structuredOutput.js'

// hook 子代理只用只读工具（防写，且无需审批 UI）。
const HOOK_AGENT_TOOLS = allTools.filter(t => t.isReadOnly)

/** agent hook 的固定输出 schema（对齐 ①c {ok,reason} 契约）。 */
const HOOK_EVAL_SCHEMA = z.object({ ok: z.boolean(), reason: z.string().optional() })

/** 把 hook.model（'flash'/'inherit'/具体 id/undefined）解析成真实模型 id。 */
function resolveModel(model: string | undefined, getModel: () => string): string {
  if (!model || model === 'flash') return SUB_MODEL
  if (model === 'inherit') return getModel()
  return model
}

export function makeHookRuntime(opts: {
  client: OpenAI
  getModel: () => string
  onUsage?: (u: Usage, model: string) => void
  cwd: () => string
}): Pick<HookEngineDeps, 'llm' | 'runAgent' | 'registerAsync'> {
  const llm: HookEngineDeps['llm'] = async (prompt, model, signal) => {
    const gen = chatStream(opts.client, {
      model: resolveModel(model, opts.getModel),
      messages: [{ role: 'user', content: prompt }],
      tools: [], thinking: false, signal,
    })
    let step = await gen.next()
    while (!step.done) step = await gen.next()
    return step.value.content
  }

  const runAgent: HookEngineDeps['runAgent'] = async (prompt, model, signal) => {
    const subModel = resolveModel(model, opts.getModel)
    const subCtx: ToolContext = {
      cwd: opts.cwd,
      setCwd: () => { /* hook 子代理只读，不漂移 cwd */ },
      get signal() { return signal },
      fileState: new Map(),
      isSubagent: true, // 纯执行 + 不注入 hookDispatch → 子回路 hooks-free 防递归
    }
    const messages: any[] = [{ role: 'user', content: prompt }]
    // L-044：注入 StructuredOutput 工具，强制 hook 子代理产出 {ok,reason}（替代 ①c 的自由文本解析近似）。
    let captured: unknown
    const tools = [...HOOK_AGENT_TOOLS, makeStructuredOutputTool(HOOK_EVAL_SCHEMA, v => { captured = v })]
    let structuredRetries = 0
    while (true) {
      const gen = runLoop(messages, {
        client: opts.client,
        tools,
        model: subModel,
        thinking: false,
        permission: { mode: 'default', rules: [], saveRule: () => {}, ask: async (_n, desc) => subagentPermissionDecision(desc) },
        ctx: subCtx,
        maxTurns: 10,
      })
      let step
      while (!(step = await gen.next()).done) {
        if (step.value.type === 'turn_end' && opts.onUsage) opts.onUsage(step.value.usage, subModel)
      }
      if (captured !== undefined) return JSON.stringify(captured)
      if (structuredRetries < MAX_STRUCTURED_OUTPUT_RETRIES) {
        structuredRetries++
        messages.push({ role: 'user', content: structuredOutputReminder() })
        continue
      }
      // fail-safe：重试耗尽 → 回退末条文本（parseHookEvalResult 解析失败 → non_blocking_error 不 block）。
      const final = [...messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content)
      return final?.content ?? ''
    }
  }

  return { llm, runAgent, registerAsync }
}
