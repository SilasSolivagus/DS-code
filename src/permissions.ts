// src/permissions.ts
import type { Tool } from './tools/types.js'

export type PermissionMode = 'default' | 'acceptEdits' | 'yolo'
export type Decision = 'yes' | 'no' | 'always'

export interface PermissionContext {
  mode: PermissionMode
  rules: string[]
  saveRule: (rule: string) => void
  ask: (toolName: string, desc: string) => Promise<Decision>
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
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (tool.isReadOnly) return { ok: true }
  const desc = tool.needsPermission(input)
  if (desc === false) return { ok: true }
  if (pc.mode === 'yolo') return { ok: true }
  if (pc.mode === 'acceptEdits' && (tool.name === 'Edit' || tool.name === 'Write')) return { ok: true }
  if (pc.rules.some(r => matchRule(r, tool.name, desc))) return { ok: true }
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
  return decision === 'yes' ? { ok: true } : { ok: false, reason: '用户拒绝了此操作' }
}
