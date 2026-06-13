// src/headless.ts
import type OpenAI from 'openai'
import { runLoop } from './loop.js'
import { allTools } from './tools/index.js'
import { todoWriteTool } from './tools/todowrite.js'
import { makeAgentTool } from './tools/agent.js'
import { makeWebFetchTool } from './tools/webfetch.js'
import { buildSystemPrompt } from './prompt.js'
import { loadSettings } from './config.js'
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
  const settings = loadSettings()
  const model = 'deepseek-v4-flash'
  let cwd = process.cwd()
  const todos = new TodoStore()
  const ctx: ToolContext = {
    cwd: () => cwd,
    setCwd: d => { cwd = d },
    signal: new AbortController().signal,
    fileState: new Map(),
    todos,
  }
  const total: Usage = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 }
  let turns = 0
  // makeAgentTool 的 onUsage 回调签名为 (u: Usage, model: string)
  const addUsage = (u: Usage) => {
    total.prompt_tokens += u.prompt_tokens
    total.completion_tokens += u.completion_tokens
    total.prompt_cache_hit_tokens += u.prompt_cache_hit_tokens
  }
  const messages: any[] = [
    { role: 'system', content: buildSystemPrompt(cwd) },
    { role: 'user', content: opts.prompt },
  ]
  const gen = runLoop(messages, {
    client: opts.client,
    tools: [...allTools, todoWriteTool, makeAgentTool({ client: opts.client, onUsage: (u, _model) => addUsage(u) }), makeWebFetchTool({ client: opts.client, onUsage: (u, _model) => addUsage(u) })],
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
