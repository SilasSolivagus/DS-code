import fs from 'node:fs'
import path from 'node:path'
import type { MemoryConfig } from '../../memdir/memoryConfig.js'

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
