// src/configReport.ts
import type { LayeredResult } from './settingsLayers.js'

const SENSITIVE = new Set(['apiKey'])
function maskValue(key: string, v: unknown): string {
  if (SENSITIVE.has(key) && typeof v === 'string' && v) return v.slice(0, 4) + '…(已打码)'
  if (Array.isArray(v)) return `${v.length} 条`
  if (v && typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export function formatConfigReport(r: LayeredResult): string {
  const lines: string[] = ['配置（合并值 · 来源）：']
  for (const [k, v] of Object.entries(r.settings)) {
    if (v === undefined) continue
    const src = r.provenance[k] ?? 'default'
    lines.push(`  ${k}: ${maskValue(k, v)}  [${src}]`)
  }
  // 被剥离的 project / 降级 local 警告
  for (const s of r.scopes) {
    if (s.stripped.length) {
      const tag = s.demoted ? `${s.scope}(git-tracked 已降级)` : s.scope
      lines.push(`  ⚠ ${tag} 的 ${s.stripped.join('/')} 已忽略（不可信来源）`)
    }
  }
  lines.push('加载的文件：')
  for (const s of r.scopes) {
    lines.push(`  [${s.scope}] ${s.path} ${s.present ? (s.demoted ? '(已加载·降级)' : '(已加载)') : '(缺失)'}`)
  }
  return lines.join('\n')
}
