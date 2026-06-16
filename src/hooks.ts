// src/hooks.ts
import { spawn as nodeSpawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import { matchRule } from './permissions.js'

export const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'SessionStart', 'SessionEnd', 'Setup', 'UserPromptSubmit',
  'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact',
  'PermissionRequest', 'PermissionDenied',
  'TaskCreated', 'TaskCompleted',
  'Notification', 'ConfigChange', 'CwdChanged', 'InstructionsLoaded',
  // 缺依赖、本件不 dispatch、随子系统点亮
  'WorktreeCreate', 'WorktreeRemove', 'Elicitation', 'ElicitationResult',
  'TeammateIdle', 'FileChanged',
] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

interface HookCommon { timeout?: number; if?: string; once?: boolean; statusMessage?: string }
export interface CommandHook extends HookCommon { type: 'command'; command: string; async?: boolean; asyncRewake?: boolean }
export interface PromptHook extends HookCommon { type: 'prompt'; prompt: string; model?: string }
export interface AgentHook extends HookCommon { type: 'agent'; prompt: string; model?: string }
export interface HttpHook extends HookCommon { type: 'http'; url: string; headers?: Record<string, string> }
export type HookCommand = CommandHook | PromptHook | AgentHook | HttpHook
export interface HookMatcher { matcher?: string; hooks: HookCommand[] }
export type HooksConfig = Partial<Record<HookEvent, HookMatcher[]>>

export interface HookResult {
  outcome: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled' | 'backgrounded'
  permissionDecision?: 'allow' | 'deny' | 'ask'
  permissionReason?: string
  updatedInput?: unknown
  updatedOutput?: string
  additionalContext?: string
  systemMessage?: string
  stop?: boolean
  preventContinuation?: boolean
  blockingError?: string
  label: string
  durationMs: number
}

export interface HookOutcome {
  block: boolean
  blockReason?: string
  permission?: 'allow' | 'deny' | 'ask'
  permissionReason?: string
  updatedInput?: unknown
  updatedOutput?: string
  additionalContext?: string
  systemMessage?: string
  preventContinuation: boolean
  stop: boolean
  results: HookResult[]
}

/** matcher 匹配：undefined/''/'*' 恒真；纯标识符精确；含 | 管道精确或；否则当正则（构造失败→false）。 */
export function matchesMatcher(matcher: string | undefined, query: string): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true
  if (matcher.includes('|')) return matcher.split('|').map(s => s.trim()).includes(query)
  if (/^[A-Za-z0-9_]+$/.test(matcher)) return matcher === query
  try { return new RegExp(matcher).test(query) } catch { return false }
}

/** 各事件 matcher 匹配的 payload 字段；返回 undefined = 该事件忽略 matcher（恒匹配）。 */
export function matchQueryFor(event: HookEvent, payload: Record<string, unknown>): string | undefined {
  const s = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string) : undefined)
  switch (event) {
    case 'PreToolUse': case 'PostToolUse': case 'PostToolUseFailure':
    case 'PermissionRequest': case 'PermissionDenied':
      return s('tool_name')
    case 'SessionStart': case 'ConfigChange': return s('source')
    case 'Setup': case 'PreCompact': case 'PostCompact': return s('trigger')
    case 'Notification': return s('notification_type')
    case 'SessionEnd': return s('reason')
    case 'SubagentStart': case 'SubagentStop': return s('agent_type')
    case 'InstructionsLoaded': return s('load_reason')
    case 'FileChanged': return s('file_basename')
    default: return undefined
  }
}

/** if 条件求值（仅工具类事件有意义）：裸 'Tool' 仅比工具名；'Tool(pat)' 复用 permissions.matchRule。 */
export function evalIfCondition(ifExpr: string | undefined, toolName: string, desc: string): boolean {
  if (!ifExpr) return true
  if (/^[A-Za-z0-9_]+$/.test(ifExpr)) return ifExpr === toolName
  return matchRule(ifExpr, toolName, desc)
}

/** 单 hook 的 stdout/exit 解析成 HookResult（label/durationMs 由调用方补）。 */
export function parseHookStdout(stdout: string, exitCode: number, stderr: string): HookResult {
  const base: HookResult = { outcome: 'success', label: '', durationMs: 0 }
  if (exitCode === 2) {
    return { ...base, outcome: 'blocking', blockingError: (stderr || stdout || '').trim(), preventContinuation: true }
  }
  if (exitCode !== 0) {
    return { ...base, outcome: 'non_blocking_error', blockingError: (stderr || stdout || '').trim() || undefined }
  }
  const trimmed = stdout.trim()
  if (!trimmed) return base
  let json: any
  try { json = JSON.parse(trimmed) } catch { return { ...base, additionalContext: trimmed } }
  if (json === null || typeof json !== 'object') return { ...base, additionalContext: trimmed }
  const r: HookResult = { ...base }
  if (json.continue === false) r.stop = true
  if (json.decision === 'block') { r.outcome = 'blocking'; r.blockingError = typeof json.reason === 'string' ? json.reason : undefined; r.preventContinuation = true }
  if (json.decision === 'approve') r.permissionDecision = 'allow'
  if (typeof json.systemMessage === 'string') r.systemMessage = json.systemMessage
  const hso = json.hookSpecificOutput
  if (hso && typeof hso === 'object') {
    if (hso.permissionDecision === 'allow' || hso.permissionDecision === 'deny' || hso.permissionDecision === 'ask') r.permissionDecision = hso.permissionDecision
    const pr = hso.permissionReason ?? hso.permissionDecisionReason
    if (typeof pr === 'string') r.permissionReason = pr
    if ('updatedInput' in hso) r.updatedInput = hso.updatedInput
    if (typeof hso.updatedOutput === 'string') r.updatedOutput = hso.updatedOutput
    if (typeof hso.additionalContext === 'string') r.additionalContext = hso.additionalContext
  }
  return r
}
