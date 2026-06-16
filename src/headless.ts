// src/headless.ts
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type OpenAI from 'openai'
import { runLoop } from './loop.js'
import { allTools } from './tools/index.js'
import { todoWriteTool } from './tools/todowrite.js'
import { makeAgentTool } from './tools/agent.js'
import { makeWebFetchTool } from './tools/webfetch.js'
import { taskListTool, taskOutputTool, taskStopTool } from './tools/taskTools.js'
import { installTaskCleanup } from './tasks.js'
import { buildSystemPrompt, findMemoryFiles } from './prompt.js'
import { loadSettings } from './config.js'
import { runHooks } from './hooks.js'
import { makeHookRuntime } from './hookRuntime.js'
import { TodoStore } from './todo.js'
import { costUSD } from './pricing.js'
import type { ToolContext } from './tools/types.js'
import type { Usage } from './api.js'

export interface HeadlessResult {
  text: string
  status: 'done' | 'aborted' | 'max_turns'
  turns: number
  usage: Usage
  costUSD: number
}

/** 单 prompt 跑完整个 loop。工具事件打到 stderr（stdout 留给最终结果，方便脚本消费）。 */
export async function runHeadless(opts: { client: OpenAI; prompt: string; yolo: boolean }): Promise<HeadlessResult> {
  installTaskCleanup() // 退出时 kill 仍 running 的后台任务
  const settings = loadSettings()
  const model = 'deepseek-v4-flash'
  let cwd = process.cwd()
  const todos = new TodoStore()
  const sessionId = 'headless-' + crypto.randomBytes(4).toString('hex')
  const ctx: ToolContext = {
    cwd: () => cwd,
    setCwd: d => { cwd = d },
    signal: new AbortController().signal,
    fileState: new Map(),
    todos,
    hookDispatch: (event, payload) => runHooks(event, payload, settings.hooks), // overwritten below after hookDeps is built
    sessionId: () => sessionId,
  }
  const total: Usage = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 }
  let turns = 0
  // makeAgentTool 的 onUsage 回调签名为 (u: Usage, model: string)
  const addUsage = (u: Usage) => {
    total.prompt_tokens += u.prompt_tokens
    total.completion_tokens += u.completion_tokens
    total.prompt_cache_hit_tokens += u.prompt_cache_hit_tokens
  }
  const hookDeps = makeHookRuntime({ client: opts.client, getModel: () => model, onUsage: (u, _m) => addUsage(u), cwd: () => cwd })
  ctx.hookDispatch = (event, payload) => runHooks(event, payload, settings.hooks, hookDeps)
  // SessionStart：会话开始（headless 恒 startup）。await 注入 additionalContext 到初始上下文。
  const initMsgs: any[] = [{ role: 'system', content: buildSystemPrompt(cwd) }]
  if (settings.hooks) {
    const ss = await runHooks('SessionStart', {
      hook_event_name: 'SessionStart', cwd, session_id: ctx.sessionId?.(), source: 'startup',
    }, settings.hooks, hookDeps)
    if (ss.additionalContext) initMsgs.push({ role: 'user', content: `<hook-context>\n${ss.additionalContext}\n</hook-context>` })
    if (ss.systemMessage) process.stderr.write(ss.systemMessage + '\n')
    // InstructionsLoaded：记忆文件加载记录（DEEPCODE.md/CLAUDE.md/全局）。fire-and-forget。
    const home = os.homedir()
    const globalMem = path.join(home, '.deepcode', 'DEEPCODE.md')
    for (const f of findMemoryFiles(cwd)) {
      void runHooks('InstructionsLoaded', {
        hook_event_name: 'InstructionsLoaded', cwd, session_id: ctx.sessionId?.(),
        file_path: f, memory_type: f === globalMem ? 'user' : 'project', load_reason: 'startup',
      }, settings.hooks!, hookDeps).catch(() => {})
    }
  }
  let promptText = opts.prompt
  if (settings.hooks) {
    const ups = await runHooks('UserPromptSubmit', {
      hook_event_name: 'UserPromptSubmit', cwd, prompt: opts.prompt,
    }, settings.hooks, hookDeps)
    if (ups.block || ups.preventContinuation) {
      return { text: `输入被 hook 拦截：${ups.blockReason ?? ''}`, status: 'aborted', turns: 0, usage: total, costUSD: 0 }
    }
    if (ups.additionalContext) promptText = `${opts.prompt}\n\n<hook-context>\n${ups.additionalContext}\n</hook-context>`
  }
  const messages: any[] = [...initMsgs, { role: 'user', content: promptText }]
  const gen = runLoop(messages, {
    client: opts.client,
    tools: [...allTools, todoWriteTool, makeAgentTool({ client: opts.client, onUsage: (u, _model) => addUsage(u), getModel: () => model }), makeWebFetchTool({ client: opts.client, onUsage: (u, _model) => addUsage(u) }), taskListTool, taskOutputTool, taskStopTool],
    model,
    thinking: false,
    ctx,
    permission: {
      mode: opts.yolo ? 'yolo' : 'default',
      rules: settings.permissions.allow,
      saveRule: () => { /* headless 不持久化规则 */ },
      ask: async () => 'no', // 无人值守：默认拒绝，拒绝理由按正常机制喂回模型
    },
    reminders: () => {
      todos.tick()
      const note = todos.staleReminder()
      return note ? [note] : []
    },
    injectTaskNotifications: true, // 运行中完成的后台任务在终止点注入续跑（单发模式无空闲订阅）
    hooks: settings.hooks,
    hookDeps,
  })
  let step
  while (!(step = await gen.next()).done) {
    const ev = step.value
    if (ev.type === 'tool_start') process.stderr.write(`⏺ ${ev.name}(${ev.desc.slice(0, 100)})\n`)
    if (ev.type === 'turn_end') { turns++; addUsage(ev.usage) }
  }
  const final = [...messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content)
  return {
    text: final?.content ?? '',
    status: step.value,
    turns,
    usage: total,
    costUSD: costUSD(model, total.prompt_tokens, total.prompt_cache_hit_tokens, total.completion_tokens),
  }
}
