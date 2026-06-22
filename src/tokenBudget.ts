// src/tokenBudget.ts
// 2.1 Token Budget 自动续跑（对齐 CC utils/tokenBudget.ts + query/tokenBudget.ts）。
// 用户在输入里写 +500k / use 2M tokens 设输出 token 目标；本轮 agentic 循环未达目标×90%
// 且仍有进展就自动续跑。纯函数，无依赖。

// 强制 k/m/b 后缀，避免 +5 等自然语言误匹配（开头锚定/结尾锚定/verbose 任意位置）。
const SHORTHAND_START_RE = /^\s*\+(\d+(?:\.\d+)?)\s*(k|m|b)\b/i
const SHORTHAND_END_RE = /\s\+(\d+(?:\.\d+)?)\s*(k|m|b)\s*[.!?]?\s*$/i
const VERBOSE_RE = /\b(?:use|spend)\s+(\d+(?:\.\d+)?)\s*(k|m|b)\s*tokens?\b/i

const MULTIPLIERS: Record<string, number> = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }

function budgetOf(value: string, suffix: string): number {
  return parseFloat(value) * MULTIPLIERS[suffix.toLowerCase()]!
}

/** 解析输入里的 token 预算指令。无匹配→null（sticky 下=沿用上次）；+0k→0（清除）。 */
export function parseTokenBudget(text: string): number | null {
  const m = text.match(SHORTHAND_START_RE) ?? text.match(SHORTHAND_END_RE) ?? text.match(VERBOSE_RE)
  return m ? budgetOf(m[1]!, m[2]!) : null
}

const COMPLETION_THRESHOLD = 0.9
const DIMINISHING_THRESHOLD = 500

/** 是否为达预算而续跑。对齐 CC：未达 90% 才续；续跑≥3 且最近两次输出增量都<500（收益递减）则熔断停。 */
export function shouldContinueForBudget(state: {
  budget: number | null
  outputSoFar: number
  continuations: number
  lastDeltas: number[]
}): boolean {
  const { budget, outputSoFar, continuations, lastDeltas } = state
  if (!budget || budget <= 0) return false
  if (outputSoFar >= budget * COMPLETION_THRESHOLD) return false
  // 收益递减熔断（sticky 刚需：防设了 +500k 后回「hi」也狂烧）
  if (continuations >= 3) {
    const last2 = lastDeltas.slice(-2)
    if (last2.length === 2 && last2.every(d => d < DIMINISHING_THRESHOLD)) return false
  }
  return true
}
