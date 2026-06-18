import type OpenAI from 'openai'
import type { ToolContext } from '../../tools/types.js'
import type { MemoryConfig } from '../../memdir/memoryConfig.js'
import { runSubagent as realRunSubagent } from '../../subagentRunner.js'
import { makeMemdirTools } from './memdirTools.js'
import { checkDreamGates } from './dreamGate.js'
import { tryAcquireConsolidationLock, rollbackConsolidationLock } from './consolidationLock.js'
import fs from 'node:fs'
import path from 'node:path'

export function buildConsolidationPrompt(sessionCount: number): string {
  return `执行一次记忆整理（dream）。自上次整理以来约 ${sessionCount} 个会话有更新。

阶段：
1) Orient：用 Read 看 MEMORY.md，skim 现有 topic 文件。
2) Gather：找出值得合并的新信号（以现有记忆为主）。
3) Consolidate：把相关信号并入对应文件，相对日期转绝对，删除过时内容（用 MemEdit/MemWrite）。
4) Prune：更新 MEMORY.md 索引，保持简洁（≤200 行、≤25KB）。

只用提供的工具（仅能写 memory 目录）。完成后回一句简短总结。`
}

export interface AutoDreamDeps {
  client: OpenAI; model: string
  memdir: string; sessionsDir: string; currentSessionFile: string
  projectKey: string
  cfg: MemoryConfig['dream']; ctx: ToolContext
  now: number; lastScanAt: number; sessionCount?: number
  runSubagent?: typeof realRunSubagent
  gate?: typeof checkDreamGates
  /** 成功取锁后（dream 工作开始前）调用 */
  onStart?: () => void
  /** runSubagent 成功（changed=true）或失败（changed=false）后调用 */
  onDone?: (changed: boolean) => void
}

export async function runAutoDream(deps: AutoDreamDeps): Promise<void> {
  try {
    const gate = (deps.gate ?? checkDreamGates)({
      memdir: deps.memdir, sessionsDir: deps.sessionsDir, currentSessionFile: deps.currentSessionFile,
      projectKey: deps.projectKey,
      cfg: deps.cfg, now: deps.now, lastScanAt: deps.lastScanAt,
    })
    if (!gate.pass) return
    const prior = tryAcquireConsolidationLock(deps.memdir, deps.now)
    // null = 锁被占（其他存活进程）或写锁失败，均跳过本次 dream
    if (prior === null) return
    deps.onStart?.()
    try {
      const runSub = deps.runSubagent ?? realRunSubagent
      await runSub({
        client: deps.client, model: deps.model, onUsage: () => {},
        systemPrompt: '你是 deepcode 的记忆整理助手。只用提供的工具，谨慎合并、勿丢信息。',
        userPrompt: buildConsolidationPrompt(deps.sessionCount ?? 0),
        tools: makeMemdirTools(deps.memdir),
        ctx: deps.ctx, signal: deps.ctx.signal,
        agentId: 'auto-dream', agentType: 'auto_dream',
      })
      // 成功：刷新锁 mtime（= lastConsolidatedAt）
      try { fs.utimesSync(path.join(deps.memdir, '.consolidate-lock'), new Date(deps.now), new Date(deps.now)) } catch {}
      deps.onDone?.(true)
    } catch (e: any) {
      console.error('[memory] autoDream 失败：' + (e?.message ?? e))
      rollbackConsolidationLock(deps.memdir, prior)
      deps.onDone?.(false)
    }
  } catch (e: any) { console.error('[memory] autoDream 异常：' + (e?.message ?? e)) }
}
