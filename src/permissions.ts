// src/permissions.ts
import { parse, type ParseEntry } from 'shell-quote'
import type { Tool } from './tools/types.js'
import type { HookOutcome } from './hooks.js'

const SEPARATORS = new Set(['&&', '||', ';', '|', '&'])
const REDIR = new Set(['>', '>>', '<', '>&', '<&'])

/** 用 shell-quote 把命令按控制操作符拆成子命令；含动态构造/分组或解析失败 → tooComplex（不得自动放行）。 */
export function splitBashCommand(command: string): { tooComplex: boolean; commands: string[] } {
  // 动态构造无法静态证明安全：命令替换 $()/反引号、进程替换 <()/>()
  if (/\$\(|`|<\(|>\(/.test(command)) return { tooComplex: true, commands: [] }
  let entries: ParseEntry[]
  try {
    entries = parse(command, {}) // 不提供 env：$VAR 不展开，只取操作符结构
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

export interface PermissionContext {
  mode: PermissionMode
  rules: string[]
  saveRule: (rule: string) => void
  ask: (toolName: string, desc: string) => Promise<Decision>
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

/** 规则形如 Bash(npm test:*)（前缀）或 Bash(ls)（精确） */
export function matchRule(rule: string, toolName: string, desc: string): boolean {
  const m = rule.match(/^(\w+)\((.+)\)$/)
  if (!m) return false
  const [, name, pat] = m
  if (name !== toolName) return false
  const normDesc = desc.replace(/\n/g, ' ') // 规则存储侧同样做了 \n→空格 归一化
  if (pat.endsWith(':*')) {
    const prefix = pat.slice(0, -2)
    return normDesc === prefix || normDesc.startsWith(prefix + ' ')
  }
  return normDesc === pat
}

export async function checkPermission(
  tool: Tool<any>,
  input: unknown,
  pc: PermissionContext,
  hooks?: PermissionHooks,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (tool.isReadOnly) return { ok: true }
  const desc = tool.needsPermission(input)
  if (desc === false) return { ok: true }
  if (pc.mode === 'yolo') return { ok: true }
  if (pc.mode === 'acceptEdits' && (tool.name === 'Edit' || tool.name === 'Write')) return { ok: true }
  if (pc.rules.some(r => matchRule(r, tool.name, desc))) return { ok: true }
  // PermissionRequest hook：交互 ask 前。allow→跳弹窗放行；deny/block→拒绝。
  if (hooks?.onRequest) {
    const out = await hooks.onRequest(tool.name, desc)
    if (out.permission === 'allow') return { ok: true }
    // 权限门控事件：exit-2/decision:block 即「拒绝本操作」，故 block 在此是必要 deny 信号
    // （与 Stop 类 I-1 不同——那里 block 语义重载须读 preventContinuation；门控同 PreToolUse 用 block）。
    if (out.permission === 'deny' || out.block) {
      const reason = out.permissionReason ?? out.blockReason ?? '权限被 hook 拒绝'
      await hooks.onDenied?.(tool.name, desc, reason)
      return { ok: false, reason }
    }
    // 既非 allow 也非 deny/block（含 hook 出错/超时返回空 outcome）→ fall through 到 pc.ask（fail-safe 问用户）。
  }
  const decision = await pc.ask(tool.name, desc)
  if (decision === 'always') {
    // Bash 取第一行的前两个词做前缀规则（如 "npm test:*"）；其他工具按完整描述精确匹配
    const firstLine = desc.split('\n')[0]
    const pat = tool.name === 'Bash'
      ? isDangerous(desc)
        ? desc.replace(/\n/g, ' ') // 高危：完整命令精确放行（含归一化的多行）
        : firstLine.split(' ').slice(0, 2).join(' ') + ':*'
      : desc.replace(/\n/g, ' ')
    pc.saveRule(`${tool.name}(${pat})`)
    return { ok: true }
  }
  if (decision === 'yes') return { ok: true }
  await hooks?.onDenied?.(tool.name, desc, '用户拒绝了此操作')
  return { ok: false, reason: '用户拒绝了此操作' }
}
