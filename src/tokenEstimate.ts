/** 判断 code point 是否属 CJK 表意区段（中日韩统一表意 + 扩展 + 兼容 + 假名/谚文常用） */
function isCJK(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||   // CJK 统一表意
    (cp >= 0x3400 && cp <= 0x4dbf) ||   // 扩展 A
    (cp >= 0x20000 && cp <= 0x2ebef) || // 扩展 B-F
    (cp >= 0xf900 && cp <= 0xfaff) ||   // 兼容表意
    (cp >= 0x3040 && cp <= 0x30ff) ||   // 平假名/片假名
    (cp >= 0xac00 && cp <= 0xd7af)      // 谚文音节
  )
}

/** 计算原始加权值（不 ceil）：CJK ×0.6/字、其余 ×0.3/字。空/undefined → 0，绝不抛。
 *  基于 DeepSeek 官方比例（中文 0.6、英文 0.3 token/字符）。 */
function rawWeight(s: string | null | undefined): number {
  if (!s) return 0
  let w = 0
  for (const ch of s) { const cp = ch.codePointAt(0)!; w += isCJK(cp) ? 0.6 : 0.3 }
  return w
}

/** CJK 感知 token 估算：CJK ×0.6/字、其余 ×0.3/字。空/undefined → 0，绝不抛。
 *  基于 DeepSeek 官方比例（中文 0.6、英文 0.3 token/字符）。over-estimate 偏安全。 */
export function estimateTextTokens(s: string | null | undefined): number {
  return Math.ceil(rawWeight(s))
}

/** 按 deepcode 扁平 OpenAI 消息结构逐条累加 token 估算。
 *  content 永远是 string|null；assistant.tool_calls[].function 的 name+arguments 计入。
 *  无 Anthropic block 数组、无图像分支（V4 纯文本）。整体一次 ceil 避免逐条 ceil 累积偏高。 */
export function estimateMessagesTokens(messages: any[]): number {
  let weighted = 0
  for (const m of messages ?? []) {
    weighted += rawWeight(typeof m?.content === 'string' ? m.content : '')
    if (Array.isArray(m?.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = tc?.function ?? {}
        weighted += rawWeight((fn.name ?? '') + (fn.arguments ?? ''))
      }
    }
  }
  return Math.ceil(weighted)
}

import { activeModelMeta } from './providers.js'

export const CONTEXT_WINDOW_DEFAULT = 200_000
const OUTPUT_RESERVE = 16_000
const AUTOCOMPACT_BUFFER = 13_000

/** 模型感知 context window：env 覆盖 → active provider meta（含 defaultMeta 兜底）。 */
export function resolveContextWindow(model: string): number {
  const env = process.env.DEEPCODE_MAX_CONTEXT_TOKENS
  if (env) { const n = parseInt(env, 10); if (Number.isFinite(n) && n > 0) return n }
  return activeModelMeta(model).contextWindow
}

/** compact 触发派生阈值 = window − 输出预留 − autocompact buffer。 */
export function computeCompactThreshold(model: string): number {
  return resolveContextWindow(model) - OUTPUT_RESERVE - AUTOCOMPACT_BUFFER
}

/** 生效阈值：compactTokens 未设走派生；设了取 min（更紧省钱上限）。 */
export function effectiveThreshold(model: string, compactTokens?: number): number {
  const derived = computeCompactThreshold(model)
  return compactTokens != null ? Math.min(derived, compactTokens) : derived
}
