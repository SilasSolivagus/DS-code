// src/tools/agent.ts
import { z } from 'zod'
import type OpenAI from 'openai'
import type { Tool, ToolContext } from './types.js'
import type { Usage } from '../api.js'
import { runLoop } from '../loop.js'
import { readTool } from './read.js'
import { globTool } from './glob.js'
import { grepTool } from './grep.js'

const schema = z.object({
  description: z.string().describe('任务的一句话描述（显示给用户）'),
  prompt: z.string().describe('给子代理的完整任务指令。子代理看不到当前对话，指令必须自包含（含路径、要找什么、期望输出）'),
})

const SUB_MODEL = 'deepseek-v4-flash'

const SUB_SYSTEM = `你是一个只读探查子代理，在终端代码库中工作。可用工具：Read/Glob/Grep。
你的最终回复会作为工具结果原文返回给主代理：只输出调查结论与证据（带文件路径与行号），不要寒暄、不要提问。
查不到就明确说查不到，不要编造。`

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

export function makeAgentTool(deps: { client: OpenAI; onUsage: (u: Usage, model: string) => void }): Tool<typeof schema> {
  return {
    name: 'Agent',
    description:
      '派出一个只读探查子代理（Read/Glob/Grep），适合开放式搜索与多处并行调查（多个独立调查就并行发起多个 Agent 调用）。子代理看不到当前对话，prompt 必须自包含。返回子代理的最终调查结论。不要用它做修改类工作。',
    inputSchema: schema,
    isReadOnly: true,
    needsPermission: () => false,
    async call(input, ctx) {
      await acquire()
      try {
        const messages: any[] = [
          { role: 'system', content: SUB_SYSTEM },
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
          tools: [readTool, globTool, grepTool],
          model: SUB_MODEL,
          thinking: false,
          permission: { mode: 'default', rules: [], saveRule: () => {}, ask: async () => 'no' },
          ctx: subCtx,
          maxTurns: 30,
        })
        let step
        while (!(step = await gen.next()).done) {
          if (step.value.type === 'turn_end') deps.onUsage(step.value.usage, SUB_MODEL)
        }
        const final = [...messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content)
        return final?.content ?? '（子代理无输出）'
      } finally {
        release()
      }
    },
  }
}
