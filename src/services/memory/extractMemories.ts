import type OpenAI from 'openai'
import type { ToolContext } from '../../tools/types.js'
import type { MemoryConfig } from '../../memdir/memoryConfig.js'
import { runSubagent as realRunSubagent, acquireMemory, releaseMemory } from '../../subagentRunner.js'
import { scanMemoryFiles, formatMemoryManifest } from '../../memdir/memoryScan.js'
import { makeMemdirTools } from './memdirTools.js'
import { buildExtractPrompt } from './extractPrompt.js'
import { messagesSince, shouldExtractByThrottle, hasMemoryWritesSince } from './extractCursor.js'

export interface TurnSnapshot { messages: any[]; turnIds: (number | undefined)[]; maxTurnId: number }

export interface ExtractorDeps {
  client: OpenAI
  model: string
  memdir: string
  config: MemoryConfig
  ctx: ToolContext
  runSubagent?: typeof realRunSubagent
  scan?: typeof scanMemoryFiles
  onUsage?: (u: { prompt_tokens: number; completion_tokens: number; prompt_cache_hit_tokens: number }, model: string) => void
}

export function createMemoryExtractor(deps: ExtractorDeps) {
  const runSub = deps.runSubagent ?? realRunSubagent
  const scan = deps.scan ?? scanMemoryFiles
  let cursor = 0
  let turnsSinceLast = 0
  let inProgress = false
  let pending: TurnSnapshot | null = null
  let lastSnap: TurnSnapshot | null = null
  // 失败后记录已尝试的最高 maxTurnId，避免对同一范围无限重试
  // 仅当新消息（snap.maxTurnId > failedAt）时才重试
  let failedAt = 0
  let hasNewSnap = false // true when onTurnEnd called since last trigger fired
  const inFlight = new Set<Promise<void>>()
  let counter = 0

  async function run(snap: TurnSnapshot, isTrailing: boolean): Promise<void> {
    const recent = messagesSince(snap.messages, snap.turnIds, cursor)
    if (!recent.length) return
    // 主 agent 已自写记忆 → 跳过 fork、推进游标
    if (hasMemoryWritesSince(recent, deps.memdir)) {
      cursor = snap.maxTurnId
      if (failedAt > 0 && cursor >= failedAt) failedAt = 0
      turnsSinceLast = 0
      return
    }
    const manifest = formatMemoryManifest(await scan(deps.memdir))
    await acquireMemory()
    try {
      await runSub({
        client: deps.client, model: deps.model,
        onUsage: deps.onUsage ?? (() => {}),
        systemPrompt: '你是 deepcode 的记忆提取助手。只用提供的工具，简洁高效。',
        userPrompt: buildExtractPrompt(recent, manifest),
        tools: makeMemdirTools(deps.memdir),
        ctx: deps.ctx, signal: deps.ctx.signal,
        agentId: `extract-${++counter}`, agentType: 'extract_memories',
      })
    } finally { releaseMemory() }
    cursor = snap.maxTurnId // 仅成功后推进
    if (failedAt > 0 && cursor >= failedAt) failedAt = 0
    turnsSinceLast = 0
  }

  function trigger(snap: TurnSnapshot, isTrailing: boolean) {
    if (!deps.config.enabled) return
    if (inProgress) { pending = snap; return }
    // 失败后同一范围不重试：需要新消息（maxTurnId > failedAt）才恢复
    if (snap.maxTurnId <= failedAt) { hasNewSnap = false; return }
    if (!shouldExtractByThrottle(turnsSinceLast, deps.config.extractEveryTurns, isTrailing)) return
    hasNewSnap = false // 消费掉本次 snap
    inProgress = true
    const p = (async () => {
      try { await run(snap, isTrailing) }
      catch (e: any) {
        failedAt = snap.maxTurnId // 记录失败位置，避免无限重试同一范围
        console.error('[memory] 提取失败：' + (e?.message ?? e))
      } // fail-safe，游标不动
      finally {
        inProgress = false
        if (pending) { const next = pending; pending = null; trigger(next, true) } // trailing 跳节流
      }
    })()
    inFlight.add(p); p.finally(() => inFlight.delete(p))
  }

  return {
    onTurnEnd(snap: TurnSnapshot) {
      if (!deps.config.enabled) return
      lastSnap = snap
      hasNewSnap = true
      turnsSinceLast++
      trigger(snap, false)
    },
    async drain(): Promise<void> {
      // 退出/清空：若有未触发的新 snap 则跳节流触发，再等所有在飞
      if (deps.config.enabled && !inProgress && lastSnap && hasNewSnap) trigger(lastSnap, true)
      await Promise.allSettled([...inFlight])
    },
  }
}
