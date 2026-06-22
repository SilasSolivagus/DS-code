// src/permissions.ts
import { parse, type ParseEntry } from 'shell-quote'
import type { Tool } from './tools/types.js'
import type { HookOutcome } from './hooks.js'
import { isDeniedPath } from './deny.js'

const SEPARATORS = new Set(['&&', '||', ';', '|', '&'])
const REDIR = new Set(['>', '>>', '<', '>&', '<&'])

/**
 * 引号/转义感知扫描。对每个「裸」字符（不在引号内、自身未被反斜杠转义、
 * 且不是引号/转义控制符本身）调用 onBare(char, index)。
 * shell 语义：单引号内无转义；双引号内与无引号处反斜杠转义下一字符。
 */
function scanBareChars(s: string, onBare: (c: string, i: number) => void): void {
  let q: '' | '"' | "'" = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q === "'") { if (c === "'") q = ''; continue }   // 单引号内：仅 ' 结束，无转义
    if (q === '"') {                                       // 双引号内：\ 转义下一字符
      if (c === '\\') { i++; continue }
      if (c === '"') q = ''
      continue
    }
    if (c === '\\') { i++; continue }                     // 无引号：\ 转义下一字符
    if (c === '"' || c === "'") { q = c; continue }       // 进入引号
    onBare(c, i)
  }
}

/**
 * 引号感知地把未被引号包裹的 \n/\r 替换为 ';'，使 shell-quote 将其识别为命令分隔符。
 * 引号内的换行（如 echo "a\nb"）保留原样。
 */
function normalizeUnquotedNewlines(s: string): string {
  const chars = s.split('')
  scanBareChars(s, (c, i) => { if (c === '\n' || c === '\r') chars[i] = ';' })
  return chars.join('')
}

/** 用 shell-quote 把命令按控制操作符拆成子命令；含动态构造/分组或解析失败 → tooComplex（不得自动放行）。 */
export function splitBashCommand(command: string): { tooComplex: boolean; commands: string[] } {
  // 动态构造无法静态证明安全：命令替换 $()/反引号、进程替换 <()/>()
  if (/\$\(|`|<\(|>\(/.test(command)) return { tooComplex: true, commands: [] }
  // 引号感知地把未引号换行归一成 ';'，防止换行绕过前缀匹配
  const normalized = normalizeUnquotedNewlines(command)
  let entries: ParseEntry[]
  try {
    entries = parse(normalized, (v: string) => '$' + v) // 保留 $VAR 字面量；传 {} 对象时 $VAR 被展开为空串（丢失参数 token）
  } catch {
    return { tooComplex: true, commands: [] }
  }
  const commands: string[] = []
  let cur: string[] = []
  const flush = () => { if (cur.length) commands.push(cur.join(' ')); cur = [] }
  let skipTarget = false
  for (const e of entries) {
    if (skipTarget) { skipTarget = false; continue } // 跳过重定向目标
    if (typeof e === 'string') { cur.push(e); continue }
    const op = (e as { op: string }).op
    if (op === 'glob') { cur.push((e as { pattern: string }).pattern); continue }
    if (SEPARATORS.has(op)) { flush(); continue }
    if (REDIR.has(op)) { skipTarget = true; continue }
    return { tooComplex: true, commands: [] } // 未知 op（如 '('/')' 子shell分组）→ 保守拒绝
  }
  flush()
  return { tooComplex: false, commands }
}

export type PermissionMode = 'default' | 'acceptEdits' | 'yolo'
export type Decision = 'yes' | 'no' | 'always'

export type PermissionRuleSource = 'builtin' | 'user' | 'project' | 'local' | 'flag'

export interface PermissionRule {
  source: PermissionRuleSource
  behavior: 'allow' | 'deny'
  value: string
}

export type PermissionDecisionReason =
  | { type: 'rule'; rule: PermissionRule }
  | { type: 'hook'; hookName: string; reason?: string }
  | { type: 'other'; reason: string }

const SOURCE_NAMES: Record<PermissionRuleSource, string> = {
  builtin: '内置规则',
  user: '用户设置',
  project: '共享项目设置',
  local: '项目本地设置',
  flag: '命令行参数',
}

/** 来源层级 → 中文显示名。 */
export function permissionSourceName(s: PermissionRuleSource): string {
  return SOURCE_NAMES[s] ?? String(s)
}

export interface PermissionContext {
  mode: PermissionMode
  rules: string[]
  saveRule: (rule: string) => void
  ask: (toolName: string, desc: string, reason?: PermissionDecisionReason) => Promise<Decision>
  deny?: string[]
  cwd?: string
  ruleSources?: Record<string, PermissionRuleSource>
  denySources?: Record<string, PermissionRuleSource>
}

export interface PermissionHooks {
  /** 交互 ask 前：hook 可返回 permission==='allow'（跳弹窗放行）或 'deny'/block（拒绝）。 */
  onRequest?: (toolName: string, desc: string) => Promise<HookOutcome>
  /** 判定拒绝后：记录/通知。 */
  onDenied?: (toolName: string, desc: string, reason: string) => Promise<void>
}

const DANGEROUS_PATTERNS = [
  /\brm\s+(-\w+\s+)*-\w*r\w*f/i, // rm -rf 及参数变体
  /\brm\s+(-\w+\s+)*-\w*f\w*r/i, // rm -fr
  /\bsudo\b/,
  /--force(?!-)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bdrop\s+(table|database)\b/i,
  /\bmkfs\b/,
  /\bdd\s+if=/,
]

/** 高危命令：权限弹窗加警告，always 不做前缀放宽只存精确规则 */
export function isDangerous(desc: string): boolean {
  return DANGEROUS_PATTERNS.some(re => re.test(desc))
}

/** 检测未被引号包裹的 shell 控制操作符。 */
export function hasUnquotedOperator(s: string): boolean {
  let found = false
  scanBareChars(s, c => { if (c === ';' || c === '&' || c === '|') found = true })
  return found
}

/** 规则形如 Bash(npm test:*)（前缀）或 Bash(ls)（精确） */
export function matchRule(rule: string, toolName: string, desc: string): boolean {
  const m = rule.match(/^(\w+)\((.+)\)$/)
  if (!m) return false
  const [, name, pat] = m
  if (name !== toolName) return false
  const normDesc = desc.replace(/\n/g, ' ') // 规则存储侧同样做了 \n→空格 归一化
  if (pat.endsWith(':*')) {
    // backstop：Bash 复合命令绝不走前缀匹配（对齐 CC bashPermissions.ts:884）
    if (toolName === 'Bash' && hasUnquotedOperator(normDesc)) return false
    const prefix = pat.slice(0, -2)
    return normDesc === prefix || normDesc.startsWith(prefix + ' ')
  }
  return normDesc === pat
}

/** 仅用精确规则（非前缀）匹配，供复合命令全量检查使用，防止前缀规则跨段匹配。 */
function matchExactRule(rule: string, toolName: string, desc: string): boolean {
  const m = rule.match(/^(\w+)\((.+)\)$/)
  if (!m) return false
  const [, name, pat] = m
  if (name !== toolName) return false
  if (pat.endsWith(':*')) return false // 复合命令全量检查不走前缀规则
  return desc.replace(/\n/g, ' ') === pat
}

/** 返回第一条命中规则字符串，无则 null。 */
export function findMatchingRule(rules: string[], toolName: string, desc: string): string | null {
  for (const r of rules) if (matchRule(r, toolName, desc)) return r
  return null
}

/** Bash 命中规则查找：too-complex→null；单命令→现匹配；复合→精确全量规则 OR 每段覆盖（返回首段命中规则作代表）。 */
export function findBashMatchingRule(command: string, rules: string[]): string | null {
  const { tooComplex, commands } = splitBashCommand(command)
  if (tooComplex) return null
  if (commands.length <= 1) {
    const d = commands[0] ?? command
    return findMatchingRule(rules, 'Bash', d)
  }
  for (const r of rules) if (matchExactRule(r, 'Bash', command)) return r
  if (commands.every(s => rules.some(r => matchRule(r, 'Bash', s)))) {
    return findMatchingRule(rules, 'Bash', commands[0])
  }
  return null
}

/** Bash 命令是否被规则集允许（委托 findBashMatchingRule，保持原行为）。 */
export function bashCommandAllowed(command: string, rules: string[]): boolean {
  return findBashMatchingRule(command, rules) !== null
}

export async function checkPermission(
  tool: Tool<any>,
  input: unknown,
  pc: PermissionContext,
  hooks?: PermissionHooks,
): Promise<
  | { ok: true; decisionReason?: PermissionDecisionReason }
  | { ok: false; reason: string; decisionReason?: PermissionDecisionReason }
> {
  // deny 最高优先级：早于 isReadOnly/yolo/acceptEdits/rules
  let forceAsk = false
  let denyHit: string | null = null
  if (pc.deny?.length && tool.deniablePaths) {
    for (const p of tool.deniablePaths(input as any, pc.cwd ?? process.cwd())) {
      const hit = isDeniedPath(p, pc.deny)
      if (!hit) continue
      denyHit = hit
      if (tool.name === 'Bash') { forceAsk = true; break } // Bash：降级 ask 防误操作
      const src = pc.denySources?.[hit] ?? 'builtin'
      const reason = `路径被 deny 规则拒绝（${hit}，来自 ${permissionSourceName(src)}）`
      await hooks?.onDenied?.(tool.name, tool.needsPermission(input) || tool.name, reason)
      return { ok: false, reason, decisionReason: { type: 'rule', rule: { source: src, behavior: 'deny', value: hit } } }
    }
  }
  if (tool.isReadOnly && !forceAsk) return { ok: true }
  const desc = tool.needsPermission(input)
  if (desc === false && !forceAsk) return { ok: true }
  if (desc === false) return { ok: true } // forceAsk 仅对 Bash（desc 恒为 string）
  if (pc.mode === 'yolo' && !forceAsk) return { ok: true }
  if (pc.mode === 'acceptEdits' && !forceAsk && (tool.name === 'Edit' || tool.name === 'Write')) return { ok: true }
  const matched = tool.name === 'Bash'
    ? findBashMatchingRule(desc, pc.rules)
    : findMatchingRule(pc.rules, tool.name, desc)
  if (matched && !forceAsk) {
    const src = pc.ruleSources?.[matched] ?? 'user'
    return { ok: true, decisionReason: { type: 'rule', rule: { source: src, behavior: 'allow', value: matched } } }
  }
  // PermissionRequest hook：交互 ask 前。allow→放行；deny/block→拒绝。
  if (hooks?.onRequest) {
    const out = await hooks.onRequest(tool.name, desc)
    if (out.permission === 'allow') return { ok: true }
    if (out.permission === 'deny' || out.block) {
      const reason = out.permissionReason ?? out.blockReason ?? '权限被 hook 拒绝'
      await hooks.onDenied?.(tool.name, desc, reason)
      return { ok: false, reason, decisionReason: { type: 'hook', hookName: 'PermissionRequest', reason } }
    }
    // fall through 到 pc.ask（fail-safe 问用户）。
  }
  const askReason: PermissionDecisionReason | undefined = denyHit
    ? { type: 'rule', rule: { source: pc.denySources?.[denyHit] ?? 'builtin', behavior: 'deny', value: denyHit } }
    : undefined
  const decision = await pc.ask(tool.name, desc, askReason)
  if (decision === 'always') {
    const firstLine = desc.split('\n')[0]
    const compound = tool.name === 'Bash' && splitBashCommand(desc).commands.length > 1
    const pat = tool.name === 'Bash'
      ? (isDangerous(desc) || compound)
        ? desc.replace(/\n/g, ' ')
        : firstLine.split(' ').slice(0, 2).join(' ') + ':*'
      : desc.replace(/\n/g, ' ')
    pc.saveRule(`${tool.name}(${pat})`)
    return { ok: true }
  }
  if (decision === 'yes') return { ok: true }
  await hooks?.onDenied?.(tool.name, desc, '用户拒绝了此操作')
  return { ok: false, reason: '用户拒绝了此操作', decisionReason: { type: 'other', reason: '用户拒绝了此操作' } }
}
