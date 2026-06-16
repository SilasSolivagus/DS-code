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

interface HookCommon {
  timeout?: number
  if?: string
  /** 一次性 hook：CC 仅对 skill/plugin frontmatter hooks 实现（onHookSuccess→removeSessionHook）。
   *  deepcode 尚无 skill hooks 系统，故当前**保留字段不消费**，待 L-022 skill 系统落地按 CC 实现。 */
  once?: boolean
  statusMessage?: string
}
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
  // matcher 来自本地受信 settings.json（启动快照）；长度护栏防御性兜底超长病态正则（ReDoS）
  if (matcher.length > 200) return false
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
  if (json === null || Array.isArray(json) || typeof json !== 'object') return { ...base, additionalContext: trimmed }
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

/** 并行结果按配置序合并：block=任一 blocking/deny；权限 deny>ask>allow；input/output 末个非空；context/sys 累加。 */
export function mergeResults(results: HookResult[], _event: HookEvent): HookOutcome {
  const out: HookOutcome = { block: false, preventContinuation: false, stop: false, results }
  const ctx: string[] = []
  const sys: string[] = []
  const perms: Array<'allow' | 'deny' | 'ask'> = []
  for (const r of results) {
    if (r.outcome === 'blocking' || r.permissionDecision === 'deny') {
      out.block = true
      if (out.blockReason === undefined) out.blockReason = r.blockingError ?? r.permissionReason
    }
    if (r.preventContinuation) out.preventContinuation = true
    if (r.stop) out.stop = true
    if (r.permissionDecision) perms.push(r.permissionDecision)
    if (r.permissionReason && out.permissionReason === undefined) out.permissionReason = r.permissionReason
    if (r.updatedInput !== undefined) out.updatedInput = r.updatedInput
    if (r.updatedOutput !== undefined) out.updatedOutput = r.updatedOutput
    if (r.additionalContext) ctx.push(r.additionalContext)
    if (r.systemMessage) sys.push(r.systemMessage)
  }
  if (perms.includes('deny')) out.permission = 'deny'
  else if (perms.includes('ask')) out.permission = 'ask'
  else if (perms.includes('allow')) out.permission = 'allow'
  if (ctx.length) out.additionalContext = ctx.join('\n\n')
  if (sys.length) out.systemMessage = sys.join('\n\n')
  return out
}

export interface HookEngineDeps {
  spawn?: typeof nodeSpawn
  now?: () => number
}

/** 单 command hook：spawn bash -c，payload JSON 写 stdin，超时 SIGKILL，close→parseHookStdout。 */
function execCommandHook(hook: CommandHook, payload: Record<string, unknown>, spawn: typeof nodeSpawn): Promise<HookResult> {
  return new Promise(resolve => {
    const timeoutMs = (hook.timeout ?? 60) * 1000
    const opts: SpawnOptions = {
      env: { ...process.env, DEEPCODE_PROJECT_DIR: process.cwd(), DEEPCODE_CWD: String(payload.cwd ?? '') },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
    let child: any
    try { child = spawn('/bin/bash', ['-c', hook.command], opts) } catch { return resolve({ outcome: 'non_blocking_error', label: hook.command, durationMs: 0 }) }
    let stdout = '', stderr = '', done = false
    const finish = (r: HookResult) => { if (done) return; done = true; clearTimeout(timer); resolve(r) }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 尽力 */ }; finish({ outcome: 'cancelled', label: hook.command, durationMs: 0 }) }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', () => finish({ outcome: 'non_blocking_error', label: hook.command, durationMs: 0 }))
    child.on('close', (code: number | null) => finish(parseHookStdout(stdout, code ?? 0, stderr)))
    try { child.stdin?.write(JSON.stringify(payload) + '\n'); child.stdin?.end() } catch { /* 尽力 */ }
  })
}

/** 单 hook 分派：①a 仅 command；其余类型占位（①c 接）。 */
async function execOneHook(hook: HookCommand, payload: Record<string, unknown>, deps: Required<HookEngineDeps>): Promise<HookResult> {
  const start = deps.now()
  if (hook.type === 'command') {
    const r = await execCommandHook(hook, payload, deps.spawn)
    return { ...r, label: hook.command, durationMs: deps.now() - start }
  }
  return { outcome: 'non_blocking_error', label: `(${hook.type} 未支持)`, durationMs: deps.now() - start }
}

/** 引擎入口：选 matcher → 过 if → 并行执行 → 合并。未配置该事件→零开销空结果。 */
export async function runHooks(
  event: HookEvent,
  payload: Record<string, unknown>,
  config: HooksConfig | undefined,
  deps: HookEngineDeps = {},
): Promise<HookOutcome> {
  const empty: HookOutcome = { block: false, preventContinuation: false, stop: false, results: [] }
  const matchers = config?.[event]
  if (!matchers || matchers.length === 0) return empty

  const query = matchQueryFor(event, payload)
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : ''
  const desc = typeof payload.tool_desc === 'string' ? payload.tool_desc : ''
  const selected: HookCommand[] = []
  for (const m of matchers) {
    if (query !== undefined && !matchesMatcher(m.matcher, query)) continue
    for (const h of m.hooks) {
      if (h.if && !evalIfCondition(h.if, toolName, desc)) continue
      selected.push(h)
    }
  }
  if (selected.length === 0) return empty

  const full: Required<HookEngineDeps> = { spawn: deps.spawn ?? nodeSpawn, now: deps.now ?? Date.now }
  const results = await Promise.all(selected.map(h => execOneHook(h, payload, full)))
  return mergeResults(results, event)
}
