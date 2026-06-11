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

/** 规则形如 Bash(npm test:*)（前缀）或 Bash(ls)（精确） */
export function matchRule(rule: string, toolName: string, desc: string): boolean {
  const m = rule.match(/^(\w+)\((.+)\)$/)
  if (!m) return false
  const [, name, pat] = m
  if (name !== toolName) return false
  if (pat.endsWith(':*')) {
    const prefix = pat.slice(0, -2)
    return desc === prefix || desc.startsWith(prefix + ' ')
  }
  return desc === pat
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
      ? firstLine.split(' ').slice(0, 2).join(' ') + ':*'
      : desc.replace(/\n/g, ' ')
    pc.saveRule(`${tool.name}(${pat})`)
    return { ok: true }
  }
  return decision === 'yes' ? { ok: true } : { ok: false, reason: '用户拒绝了此操作' }
}
