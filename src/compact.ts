// src/compact.ts
import type OpenAI from 'openai'
import { chatStream, type Usage } from './api.js'

const SUMMARY_PROMPT = `请把以上对话压缩成一份结构化总结，供后续对话作为唯一上下文使用。必须包含：
1. 任务背景：用户最初与最新的目标
2. 已做决策：定下的方案、被否决的方向及原因
3. 改过的文件：每个文件改了什么（带完整路径）
4. 未完成事项：进行到一半的工作、已知问题
5. 下一步：接下来该做什么
只输出总结本身，不要寒暄。`

export interface CompactResult { summary: string; usage: Usage; truncated: boolean }

/** 用 flash 总结 messages（剔除 system）。调用方负责用 rebuildMessages 重建。 */
export async function summarize(client: OpenAI, messages: any[], signal: AbortSignal): Promise<CompactResult> {
  const convo = messages.filter(m => m.role !== 'system')
  const gen = chatStream(client, {
    model: 'deepseek-v4-flash',
    messages: [...convo, { role: 'user', content: SUMMARY_PROMPT }],
    tools: [],
    thinking: false,
    signal,
  })
  let step
  while (!(step = await gen.next()).done) { /* 丢弃流式增量，只要最终结果 */ }
  return { summary: step.value.content, usage: step.value.usage, truncated: step.value.finishReason === 'length' }
}

/** 重建消息数组：[system, 总结(user), ...最近 keep 条]。返回新数组，不改原数组。
 *  切口不落在 tool 消息上：向前扩到发起该批 tool_calls 的 assistant，保证 API 序列合法。 */
export function rebuildMessages(messages: any[], summary: string, keep = 8): any[] {
  const sysLen = messages[0]?.role === 'system' ? 1 : 0
  let start = Math.max(messages.length - keep, sysLen)
  while (start > sysLen && messages[start]?.role === 'tool') start--
  const tail = messages.slice(start)
  const head = sysLen ? [messages[0]] : []
  return [...head, { role: 'user', content: `<对话历史总结>\n${summary}\n</对话历史总结>` }, ...tail]
}

/** 自动 compact 决策：超阈且未达连续失败上限才触发（熔断防无限重试烧钱）。 */
export function shouldAutoCompact(promptTokens: number, threshold: number, failures: number, maxFailures: number): boolean {
  return promptTokens > threshold && failures < maxFailures
}
