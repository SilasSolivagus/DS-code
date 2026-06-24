// src/permissionsView.ts
// /permissions 命令的显示格式化 + 删除决策（纯函数，无 React，独立可测）。
import { type PermissionRuleSource, permissionSourceName } from './permissions.js'

/** 渲染合并 allow + deny 两段，每行带来源标签 + 操作提示。 */
export function formatPermissionRules(
  allow: string[], ruleSources: Record<string, PermissionRuleSource>,
  deny: string[], denySources: Record<string, PermissionRuleSource>,
): string {
  if (allow.length === 0 && deny.length === 0) return '没有已保存的权限规则'
  const lines: string[] = []
  if (allow.length) {
    lines.push('允许规则（Allow）：')
    allow.forEach((r, i) => lines.push(`  ${i + 1}. ${r} [${permissionSourceName(ruleSources[r] ?? 'user')}]`))
  }
  if (deny.length) {
    if (lines.length) lines.push('')
    lines.push('拒绝规则（Deny）：')
    deny.forEach((p, i) => lines.push(`  ${i + 1}. ${p} [${permissionSourceName(denySources[p] ?? 'builtin')}]`))
  }
  lines.push('')
  lines.push('（/permissions rm <编号> 删 Allow · /permissions deny-rm <编号> 删 Deny；仅能删用户层规则）')
  return lines.join('\n')
}

/** 把「显示编号 → 删除动作」的决策抽成纯函数：仅用户层可删，非用户层返回友好提示。 */
export function resolveRuleRemoval(
  list: string[], index1Based: number,
  sources: Record<string, PermissionRuleSource>, defaultSource: PermissionRuleSource,
): { ok: true; value: string } | { ok: false; reason: string } {
  const value = list[index1Based - 1]
  if (value === undefined) return { ok: false, reason: '编号无效' }
  const src = sources[value] ?? defaultSource
  if (src !== 'user') return { ok: false, reason: `该规则来自${permissionSourceName(src)}，请在对应配置文件修改` }
  return { ok: true, value }
}
