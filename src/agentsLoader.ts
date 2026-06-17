// src/agentsLoader.ts —— L-040 B 用户自定义子代理加载（CC 生态兼容）。
// 解析 CC frontmatter（yaml）→ AgentDefinition，扫 .claude/agents + .deepcode/agents 合并。
import { parse as parseYaml } from 'yaml'

/** 切 frontmatter（`---\n…\n---`）+ body。无 frontmatter 或坏 YAML → data 空、body 原文（容错对齐 CC）。 */
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { data: {}, body: raw }
  let data: Record<string, unknown> = {}
  try {
    const parsed = parseYaml(m[1])
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>
  } catch { /* 坏 YAML → 空（容错） */ }
  return { data, body: raw.slice(m[0].length) }
}

/** tools/disallowedTools 解析（对齐 CC）：逗号串/YAML 数组；`*`→undefined(全部)；省略→undefined；空→[]。 */
export function parseToolList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  let arr: string[]
  if (typeof value === 'string') arr = value.split(',').map(s => s.trim()).filter(Boolean)
  else if (Array.isArray(value)) arr = value.filter((x): x is string => typeof x === 'string').flatMap(s => s.split(',')).map(s => s.trim()).filter(Boolean)
  else return undefined
  if (arr.includes('*')) return undefined
  return arr
}

/** CC Anthropic 模型档 → deepcode 词汇（inherit/flash/字面）。加载时归一，agent.ts model 解析零改。 */
export function resolveAgentModelAlias(model: unknown): string | undefined {
  if (typeof model !== 'string' || !model.trim()) return undefined
  const t = model.trim()
  const lower = t.toLowerCase()
  if (lower === 'inherit') return 'inherit'
  if (lower === 'haiku') return 'flash'                                    // 弱档 → deepcode cheap 档
  if (lower === 'sonnet' || lower === 'opus') return 'inherit'             // 强档 deepcode 无对应 → 落父模型
  if (lower.startsWith('claude-') || lower.startsWith('claude ')) return 'inherit' // 未知 Anthropic id → 兜底父模型
  return t                                                                 // flash / deepseek-… / 其它 deepcode 原生透传
}
