// src/hooks.ts
import { spawn as nodeSpawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import path from 'node:path'
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici'
import { matchRule } from './permissions.js'
import { ENV_FILE_EVENTS, ensureSessionEnvDir, hookEnvFileName, DEFAULT_SESSION_ENV_BASE } from './sessionEnv.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from './tools/structuredOutput.js'
import { ssrfGuardedLookup, shouldBypassProxy } from './ssrfGuard.js'

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
export interface HttpHook extends HookCommon { type: 'http'; url: string; headers?: Record<string, string>; allowedEnvVars?: string[] }
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
  /** http hook：默认 undici fetch。 */
  fetch?: typeof fetch
  /** http hook URL 白名单（SSRF 前置）：undefined=不限制；[]=全禁；非空=须匹配通配模式。 */
  allowedHttpHookUrls?: string[]
  /** http hook header env 插值的全局白名单；设了则与每个 hook 自身 allowedEnvVars 取交集。 */
  httpHookAllowedEnvVars?: string[]
  /** async/asyncRewake command hook：把已 spawn 的 child 交后台接管（挂 tasks.ts）。
   *  缺省 → async hook fail-safe 退化为同步阻塞执行（对齐 CC forceSyncExecution）。 */
  registerAsync?: (args: {
    child: import('node:child_process').ChildProcess
    hook: CommandHook
    payload: Record<string, unknown>
    label: string
    asyncTimeout?: number
    initialStdout?: string
    initialStderr?: string
  }) => void
  /** 慢阶段 hook 进度回调（喂 TUI Spinner）。label 非空=开始；undefined=结束清除。仅慢阶段事件触发。 */
  onProgress?: (label?: string) => void
}

interface ResolvedHookDeps {
  spawn: typeof nodeSpawn
  now: () => number
  sessionEnvBase: string
  fetch: typeof fetch
  allowedHttpHookUrls?: string[]
  httpHookAllowedEnvVars?: string[]
  llm?: HookEngineDeps['llm']
  runAgent?: HookEngineDeps['runAgent']
  registerAsync?: HookEngineDeps['registerAsync']
}

/** 单 command hook：spawn bash -c，payload JSON 写 stdin，超时 SIGKILL，close→parseHookStdout。
 *  async/asyncRewake：先 spawn 后判定（配置级 / stdout 首行 marker），命中 → registerAsync 接管返 backgrounded。 */
function execCommandHook(hook: CommandHook, payload: Record<string, unknown>, deps: ResolvedHookDeps, envFilePath?: string): Promise<HookResult> {
  return new Promise(resolve => {
    const timeoutMs = (hook.timeout ?? 60) * 1000
    const isAsyncConfig = !!(hook.async || hook.asyncRewake)
    const canAsync = !!deps.registerAsync
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
    try { child = deps.spawn('/bin/bash', ['-c', hook.command], opts) } catch { return resolve({ outcome: 'non_blocking_error', label: hook.command, durationMs: 0 }) }
    let stdout = '', stderr = '', done = false, handed = false, initialChecked = false
    const finish = (r: HookResult) => { if (done || handed) return; done = true; clearTimeout(timer); resolve(r) }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 尽力 */ }; finish({ outcome: 'cancelled', label: hook.command, durationMs: 0 }) }, timeoutMs)
    const handOff = (asyncTimeout?: number) => {
      if (done || handed) return
      handed = true
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onErr)
      child.off('close', onClose)
      child.off('error', onError)
      deps.registerAsync!({ child, hook, payload, label: hook.command, asyncTimeout, initialStdout: stdout, initialStderr: stderr })
      resolve({ outcome: 'backgrounded', label: hook.command, durationMs: 0 })
    }
    const onData = (d: Buffer) => {
      stdout += d.toString()
      // stdout 首行 async 检测（仅在可 async 且非配置级 async 时）
      if (!initialChecked && canAsync && !isAsyncConfig) {
        const firstLine = stdout.split('\n')[0]
        if (firstLine.includes('}')) {
          initialChecked = true
          const parsed = isAsyncFirstLine(firstLine.trim())
          if (parsed) handOff(parsed.asyncTimeout)
        }
      }
    }
    const onErr = (d: Buffer) => { stderr += d.toString() }
    const onClose = (code: number | null) => finish(parseHookStdout(stdout, code ?? 0, stderr))
    const onError = () => finish({ outcome: 'non_blocking_error', label: hook.command, durationMs: 0 })
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onErr)
    child.on('error', onError)
    child.on('close', onClose)
    try { child.stdin?.write(JSON.stringify(payload) + '\n'); child.stdin?.end() } catch { /* 尽力 */ }
    // 配置级 async/asyncRewake：写完 stdin 立即 handoff。无显式 timeout 时取 600s（对齐 CC 工具 hook 预算
    // TOOL_HOOK_EXECUTION_TIMEOUT_MS）——CC 的 15s 默认仅用于 stdout-marker 路径（见 onData 透传的 undefined）。
    // 同 tick 安全：Node 流 data/close/error 不会在本 tick 同步触发，故此刻 done 必为 false。
    if (isAsyncConfig && canAsync) handOff((hook.timeout ?? 600) * 1000)
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

/** 检测 command hook stdout 首行是否为 async marker `{"async":true,asyncTimeout?}`。
 *  对齐 CC firstLineOf + includes('}') 判完整；非 async/不完整/非 JSON → null。 */
export function isAsyncFirstLine(line: string): { async: true; asyncTimeout?: number } | null {
  if (!line.includes('}')) return null // 行尚不完整（对齐 CC：等更多数据）
  let json: any
  try { json = JSON.parse(line.trim()) } catch { return null }
  if (!json || typeof json !== 'object' || json.async !== true) return null
  const r: { async: true; asyncTimeout?: number } = { async: true }
  if (typeof json.asyncTimeout === 'number') r.asyncTimeout = json.asyncTimeout
  return r
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

const AGENT_HOOK_SYSTEM = `你正在作为 deepcode 的 agent hook 运行一个核查子代理。完成核查后，你必须调用 ${STRUCTURED_OUTPUT_TOOL_NAME} 工具返回结论：\n- 通过：{"ok": true}\n- 不通过：{"ok": false, "reason": "原因"}\n不要把结论写成普通文本，必须经该工具返回。`

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

/** header 值 env 插值（仅白名单内变量），随后消毒去 \r\n\x00（防 CRLF 注入）。对齐 CC。 */
export function interpolateEnvVars(value: string, allowed: Set<string>): string {
  const replaced = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced, plain) => {
    const name = braced ?? plain
    return allowed.has(name) ? (process.env[name] ?? '') : ''
  })
  // eslint-disable-next-line no-control-regex
  return replaced.replace(/[\r\n\x00]/g, '')
}

/** URL 通配匹配（* → 任意字符），其余正则元字符转义。对齐 CC urlMatchesPattern。 */
export function urlMatchesPattern(url: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`).test(url)
}

/** 选 dispatcher：代理激活→ProxyAgent（跳 IP 守卫，代理做 DNS）；否则 Agent({connect:{lookup}})。 */
function selectHttpDispatcher(url: string): Agent | ProxyAgent {
  const proxy = process.env.https_proxy ?? process.env.HTTPS_PROXY ?? process.env.http_proxy ?? process.env.HTTP_PROXY
  if (proxy && !shouldBypassProxy(url)) return new ProxyAgent(proxy)
  return new Agent({ connect: { lookup: ssrfGuardedLookup as any } })
}

/** webhook：POST payload JSON，响应体按 hook JSON 解析；非 2xx→blocking。 */
async function execHttpHook(hook: HttpHook, payload: Record<string, unknown>, deps: ResolvedHookDeps): Promise<HookResult> {
  const base: HookResult = { outcome: 'success', label: '', durationMs: 0 }
  // 1. URL 白名单（I/O 前）
  const allow = deps.allowedHttpHookUrls
  if (allow !== undefined && !allow.some(p => urlMatchesPattern(hook.url, p))) {
    return { ...base, outcome: 'blocking', preventContinuation: true, blockingError: `HTTP hook blocked: ${hook.url} 不匹配 allowedHttpHookUrls` }
  }
  // 2. env 插值白名单：hook 自身 ∩ policy（若设）
  const hookVars = hook.allowedEnvVars ?? []
  const effectiveVars = deps.httpHookAllowedEnvVars !== undefined
    ? hookVars.filter(v => deps.httpHookAllowedEnvVars!.includes(v))
    : hookVars
  const allowed = new Set(effectiveVars)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  for (const [k, v] of Object.entries(hook.headers ?? {})) headers[k] = interpolateEnvVars(v, allowed)
  // 3. dispatcher 两路 + redirect:error
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), (hook.timeout ?? 30) * 1000)
  try {
    const res = await deps.fetch(hook.url, {
      method: 'POST', headers, body: JSON.stringify(payload), signal: ac.signal,
      redirect: 'error',
      dispatcher: selectHttpDispatcher(hook.url),
    } as any)
    const bodyText = (await res.text()).trim()
    let json: any
    if (bodyText) { try { json = JSON.parse(bodyText) } catch { /* 非 JSON 体 */ } }
    let r = (json && typeof json === 'object' && !Array.isArray(json)) ? applyHookJson(json, base) : { ...base }
    if (res.status < 200 || res.status >= 300) {
      r = { ...r, outcome: 'blocking', preventContinuation: true, blockingError: r.blockingError ?? `HTTP ${res.status}` }
    }
    return r
  } catch (e) {
    if (ac.signal.aborted) return { ...base, outcome: 'cancelled' }
    return { ...base, outcome: 'non_blocking_error', blockingError: String((e as any)?.message ?? e) }
  } finally { clearTimeout(timer) }
}

/** 单 hook 分派：command/prompt/agent/http 四类型；未知 type → non_blocking_error 兜底。 */
async function execOneHook(hook: HookCommand, payload: Record<string, unknown>, deps: ResolvedHookDeps, envFilePath?: string): Promise<HookResult> {
  const start = deps.now()
  if (hook.type === 'command') {
    const r = await execCommandHook(hook, payload, deps, envFilePath)
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
  if (hook.type === 'http') {
    const r = await execHttpHook(hook, payload, deps)
    return { ...r, label: hook.url, durationMs: deps.now() - start }
  }
  return { outcome: 'non_blocking_error', label: `(${(hook as any).type} 未支持)`, durationMs: deps.now() - start }
}

/** 值得在 TUI 显示进度的慢阶段事件（热事件 PreToolUse/PostToolUse 等不显，防刷屏）。 */
const SLOW_PROGRESS_EVENTS = new Set<HookEvent>(['PreCompact', 'PostCompact', 'SessionStart', 'Stop', 'SubagentStop'])

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

  const showProgress = SLOW_PROGRESS_EVENTS.has(event) && !!deps.onProgress
  if (showProgress) deps.onProgress!(`正在运行 ${event} 钩子…`)
  try {
    const full: ResolvedHookDeps = {
      spawn: deps.spawn ?? nodeSpawn,
      now: deps.now ?? Date.now,
      sessionEnvBase: deps.sessionEnvBase ?? DEFAULT_SESSION_ENV_BASE,
      fetch: deps.fetch ?? (undiciFetch as unknown as typeof fetch),
      allowedHttpHookUrls: deps.allowedHttpHookUrls,
      httpHookAllowedEnvVars: deps.httpHookAllowedEnvVars,
      llm: deps.llm,
      runAgent: deps.runAgent,
      registerAsync: deps.registerAsync,
    }
    const sid = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : undefined
    let envDir: string | undefined
    if (sid && ENV_FILE_EVENTS.has(event) && selected.some(h => h.type === 'command')) {
      envDir = ensureSessionEnvDir(sid, full.sessionEnvBase)
    }
    const results = await Promise.all(selected.map((h, i) =>
      execOneHook(h, payload, full, (envDir && h.type === 'command') ? path.join(envDir, hookEnvFileName(event, i)) : undefined),
    ))
    return mergeResults(results, event)
  } finally {
    if (showProgress) deps.onProgress!()
  }
}
