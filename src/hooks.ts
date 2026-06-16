// src/hooks.ts
import { spawn as nodeSpawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import path from 'node:path'
import { matchRule } from './permissions.js'
import { ENV_FILE_EVENTS, ensureSessionEnvDir, hookEnvFileName, DEFAULT_SESSION_ENV_BASE } from './sessionEnv.js'

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
  return applyHookJson(json, base)
}

/** 把 hook 输出的 JSON 对象映射到 HookResult 字段（command stdout / http 响应共用）。 */
export function applyHookJson(json: any, base: HookResult): HookResult {
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
  sessionEnvBase?: string
  /** prompt hook：单轮 LLM 判定。返回模型文本（引擎解析 {ok,reason}）。 */
  llm?: (prompt: string, model: string | undefined, signal: AbortSignal) => Promise<string>
  /** agent hook：多轮核查子代理。返回末条 assistant 文本（引擎解析 {ok,reason}）。 */
  runAgent?: (prompt: string, model: string | undefined, signal: AbortSignal) => Promise<string>
  /** http hook：默认全局 fetch。 */
  fetch?: typeof fetch
}

interface ResolvedHookDeps {
  spawn: typeof nodeSpawn
  now: () => number
  sessionEnvBase: string
  fetch: typeof fetch
  llm?: HookEngineDeps['llm']
  runAgent?: HookEngineDeps['runAgent']
}

/** 单 command hook：spawn bash -c，payload JSON 写 stdin，超时 SIGKILL，close→parseHookStdout。 */
function execCommandHook(hook: CommandHook, payload: Record<string, unknown>, spawn: typeof nodeSpawn, envFilePath?: string): Promise<HookResult> {
  return new Promise(resolve => {
    const timeoutMs = (hook.timeout ?? 60) * 1000
    const opts: SpawnOptions = {
      env: {
        ...process.env,
        DEEPCODE_PROJECT_DIR: process.cwd(),
        DEEPCODE_CWD: String(payload.cwd ?? ''),
        ...(envFilePath ? { DEEPCODE_ENV_FILE: envFilePath } : {}),
      },
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

/** $ARGUMENTS → payload JSON；无占位符则追加 ARGUMENTS 段（对齐 CC argumentSubstitution）。 */
export function substituteArguments(template: string, payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload)
  if (template.includes('$ARGUMENTS')) return template.split('$ARGUMENTS').join(json)
  return `${template}\n\nARGUMENTS: ${json}`
}

/** prompt/agent hook 的 {ok,reason} 结果解析。ok:true→success；ok:false→blocking(reason)；否则 non_blocking_error。 */
export function parseHookEvalResult(text: string, base: HookResult): HookResult {
  let json: any
  try { json = JSON.parse(text.trim()) } catch { return { ...base, outcome: 'non_blocking_error', blockingError: 'hook 输出无法解析为 JSON {ok,reason}' } }
  if (!json || typeof json.ok !== 'boolean') return { ...base, outcome: 'non_blocking_error', blockingError: 'hook 输出缺少 boolean ok 字段' }
  if (json.ok) return { ...base }
  return { ...base, outcome: 'blocking', blockingError: typeof json.reason === 'string' ? json.reason : 'hook 判定不通过', preventContinuation: true }
}

const HOOK_EVAL_SYSTEM = `你正在评估 deepcode 的一个 hook。\n你的回复必须是且仅是一个 JSON 对象，匹配下列之一：\n1. 条件满足：{"ok": true}\n2. 条件不满足：{"ok": false, "reason": "未满足的原因"}\n不要输出任何其他文字。`

const evalBase = (): HookResult => ({ outcome: 'success', label: '', durationMs: 0 })

/** 单轮 LLM 判定。无 llm → non_blocking_error。超时→cancelled。 */
async function execPromptHook(hook: PromptHook, payload: Record<string, unknown>, deps: ResolvedHookDeps): Promise<HookResult> {
  if (!deps.llm) return { ...evalBase(), outcome: 'non_blocking_error', blockingError: '未配置 llm（prompt hook 不可用）' }
  const prompt = `${HOOK_EVAL_SYSTEM}\n\n${substituteArguments(hook.prompt, payload)}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), (hook.timeout ?? 30) * 1000)
  try {
    const text = await deps.llm(prompt, hook.model, ac.signal)
    return parseHookEvalResult(text, evalBase())
  } catch (e) {
    if (ac.signal.aborted) return { ...evalBase(), outcome: 'cancelled' }
    return { ...evalBase(), outcome: 'non_blocking_error', blockingError: String((e as any)?.message ?? e) }
  } finally { clearTimeout(timer) }
}

const truncLabel = (s: string): string => (s.length > 60 ? s.slice(0, 60) + '…' : s)

const AGENT_HOOK_SYSTEM = `你正在作为 deepcode 的 agent hook 运行一个核查子代理。完成核查后，你的最后一条消息必须是且仅是一个 JSON 对象：\n- 通过：{"ok": true}\n- 不通过：{"ok": false, "reason": "原因"}\n不要输出任何其他文字。`

/** 多轮核查子代理（复用注入的 runAgent，返回末条文本）。无 runAgent → non_blocking_error。 */
async function execAgentHook(hook: AgentHook, payload: Record<string, unknown>, deps: ResolvedHookDeps): Promise<HookResult> {
  if (!deps.runAgent) return { ...evalBase(), outcome: 'non_blocking_error', blockingError: '未配置 runAgent（agent hook 不可用）' }
  const prompt = `${AGENT_HOOK_SYSTEM}\n\n${substituteArguments(hook.prompt, payload)}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), (hook.timeout ?? 60) * 1000)
  try {
    const text = await deps.runAgent(prompt, hook.model, ac.signal)
    return parseHookEvalResult(text ?? '', evalBase())
  } catch (e) {
    if (ac.signal.aborted) return { ...evalBase(), outcome: 'cancelled' }
    return { ...evalBase(), outcome: 'non_blocking_error', blockingError: String((e as any)?.message ?? e) }
  } finally { clearTimeout(timer) }
}

/** 单 hook 分派：①a 仅 command；其余类型占位（①c 接）。 */
async function execOneHook(hook: HookCommand, payload: Record<string, unknown>, deps: ResolvedHookDeps, envFilePath?: string): Promise<HookResult> {
  const start = deps.now()
  if (hook.type === 'command') {
    const r = await execCommandHook(hook, payload, deps.spawn, envFilePath)
    return { ...r, label: hook.command, durationMs: deps.now() - start }
  }
  if (hook.type === 'prompt') {
    const r = await execPromptHook(hook, payload, deps)
    return { ...r, label: truncLabel(hook.prompt), durationMs: deps.now() - start }
  }
  if (hook.type === 'agent') {
    const r = await execAgentHook(hook, payload, deps)
    return { ...r, label: truncLabel(hook.prompt), durationMs: deps.now() - start }
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

  const full: ResolvedHookDeps = {
    spawn: deps.spawn ?? nodeSpawn,
    now: deps.now ?? Date.now,
    sessionEnvBase: deps.sessionEnvBase ?? DEFAULT_SESSION_ENV_BASE,
    fetch: deps.fetch ?? (globalThis.fetch as typeof fetch),
    llm: deps.llm,
    runAgent: deps.runAgent,
  }

  // env-file 机制：Setup/SessionStart/CwdChanged/FileChanged 的 command hook 注入 DEEPCODE_ENV_FILE。
  const sid = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : undefined
  let envDir: string | undefined
  if (sid && ENV_FILE_EVENTS.has(event) && selected.some(h => h.type === 'command')) {
    envDir = ensureSessionEnvDir(sid, full.sessionEnvBase)
  }
  const results = await Promise.all(selected.map((h, i) =>
    execOneHook(h, payload, full, (envDir && h.type === 'command') ? path.join(envDir, hookEnvFileName(event, i)) : undefined),
  ))
  return mergeResults(results, event)
}
