// src/stats.ts
// 本会话统计：纯函数 sessionStats（零副作用，可单测）+ 展示拼装 formatStats。
import type { UsageRecord } from './session.js'

export interface SessionStats {
  userTurns: number
  assistantTurns: number
  requests: number
  totalToolCalls: number
  toolCounts: Array<{ name: string; n: number }>  // 按首次出现顺序
  inTokens: number
  hitTokens: number
  outTokens: number
}

/** 从 messages（含 system，跳过）+ usageLog 求会话统计。纯函数。 */
export function sessionStats(messages: any[], usageLog: UsageRecord[]): SessionStats {
  let userTurns = 0
  let assistantTurns = 0
  let totalToolCalls = 0
  const order: string[] = []
  const counts = new Map<string, number>()

  for (const m of messages) {
    if (!m || m.role === 'system') continue
    if (m.role === 'user') userTurns++
    else if (m.role === 'assistant') {
      assistantTurns++
      for (const tc of m.tool_calls ?? []) {
        const name = tc?.function?.name
        if (!name) continue
        totalToolCalls++
        if (!counts.has(name)) order.push(name)
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
    }
  }

  const inTokens = usageLog.reduce((s, u) => s + u.usage.prompt_tokens, 0)
  const hitTokens = usageLog.reduce((s, u) => s + u.usage.prompt_cache_hit_tokens, 0)
  const outTokens = usageLog.reduce((s, u) => s + u.usage.completion_tokens, 0)

  return {
    userTurns,
    assistantTurns,
    requests: usageLog.length,
    totalToolCalls,
    toolCounts: order.map(name => ({ name, n: counts.get(name)! })),
    inTokens,
    hitTokens,
    outTokens,
  }
}

/** 把统计 + 花费 + 命中率拼成多行展示字符串。 */
export function formatStats(stats: SessionStats, cost: number, hitRate: number): string {
  const tools = stats.toolCounts.length
    ? `${stats.totalToolCalls}（${stats.toolCounts.map(t => `${t.name}×${t.n}`).join(' ')}）`
    : '0'
  return [
    `本会话统计：`,
    `  轮数：用户 ${stats.userTurns} / 助手 ${stats.assistantTurns}`,
    `  请求：${stats.requests} 次`,
    `  工具调用：${tools}`,
    `  Token：输入 ${stats.inTokens}（缓存命中 ${stats.hitTokens}）出 ${stats.outTokens}`,
    `  缓存命中率：${(hitRate * 100).toFixed(1)}%`,
    `  估算花费：$${cost.toFixed(6)}`,
  ].join('\n')
}
