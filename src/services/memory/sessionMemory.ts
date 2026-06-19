import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type OpenAI from 'openai'
import type { MemoryConfig } from '../../memdir/memoryConfig.js'
import type { Tool, ToolContext } from '../../tools/types.js'
import { runSubagent as realRunSubagent, acquireMemory, releaseMemory } from '../../subagentRunner.js'

export const SESSION_MEMORY_TEMPLATE = `# Session Title

# Current State

# Task specification

# Files and Functions

# Errors & Corrections

# Learnings

# Worklog
`

export interface SessionMemoryState {
  promptTokens: number
  tokensAtLastUpdate: number
  initialized: boolean
  toolCallsSinceUpdate: number
  lastTurnHadToolCalls: boolean
}

export function shouldUpdateSessionMemory(s: SessionMemoryState, cfg: MemoryConfig['sessionMemory']): boolean {
  const tokenGate = !s.initialized
    ? s.promptTokens >= cfg.minInitTokens
    : s.promptTokens - s.tokensAtLastUpdate >= cfg.minUpdateTokens
  if (!tokenGate) return false
  return s.toolCallsSinceUpdate >= cfg.toolCallsBetween || !s.lastTurnHadToolCalls
}

export function setupSessionMemoryFile(absPath: string): string {
  try { return fs.readFileSync(absPath, 'utf8') }
  catch {
    fs.mkdirSync(path.dirname(absPath), { recursive: true })
    fs.writeFileSync(absPath, SESSION_MEMORY_TEMPLATE)
    return SESSION_MEMORY_TEMPLATE
  }
}

const editSchema = z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string() })

export function makeSessionFileTool(absPath: string): Tool<typeof editSchema> {
  const root = path.resolve(absPath)
  return {
    name: 'Edit', description: '编辑会话记忆文件（仅限该文件）。', inputSchema: editSchema,
    isReadOnly: false, needsPermission: () => false,
    async call(input) {
      if (path.resolve(input.file_path) !== root) return '拒绝：只能编辑当前会话的 summary.md。'
      let cur: string; try { cur = fs.readFileSync(root, 'utf8') } catch { return '错误：文件不存在。' }
      if (!input.old_string) return '错误：old_string 不能为空。'
      const occurrences = cur.split(input.old_string).length - 1
      if (occurrences === 0) return '错误：old_string 未匹配。'
      if (occurrences > 1) return `错误：old_string 匹配到 ${occurrences} 处，请提供更多上下文使其唯一。`
      fs.writeFileSync(root, cur.replace(input.old_string, input.new_string))
      return '已更新会话记忆。'
    },
  }
}

export interface SessionMemoryUpdateDeps {
  client: OpenAI; model: string; absPath: string; ctx: ToolContext
  runSubagent?: typeof realRunSubagent
  onUsage?: (u: { prompt_tokens: number; completion_tokens: number; prompt_cache_hit_tokens: number }, model: string) => void
}

export async function runSessionMemoryUpdate(deps: SessionMemoryUpdateDeps): Promise<void> {
  try {
    const cur = setupSessionMemoryFile(deps.absPath)
    const runSub = deps.runSubagent ?? realRunSubagent
    await acquireMemory()
    try {
      await runSub({
        client: deps.client, model: deps.model, onUsage: deps.onUsage ?? (() => {}),
        systemPrompt: '你维护一份会话进度笔记。只用 Edit 工具更新给定文件，保持各节简洁。',
        userPrompt: `更新这份会话记忆，把最新进展/错误/学习并入对应章节（结构保持）。当前内容：\n\n${cur}\n\n文件路径：${deps.absPath}`,
        tools: [makeSessionFileTool(deps.absPath)],
        ctx: deps.ctx, signal: deps.ctx.signal,
        agentId: 'session-memory', agentType: 'session_memory',
      })
    } finally { releaseMemory() }
  } catch (e: any) { console.error('[memory] SessionMemory 更新失败：' + (e?.message ?? e)) }
}
