// src/pricing.ts
// 每百万 token 单价（USD），2026-06-11 核实自 https://api-docs.deepseek.com/quick_start/pricing
const PRICES: Record<string, { hit: number; miss: number; out: number }> = {
  'deepseek-v4-flash': { hit: 0.0028, miss: 0.14, out: 0.28 },
  'deepseek-v4-pro': { hit: 0.003625, miss: 0.435, out: 0.87 },
}

/**
 * 计算一次调用的美元成本。
 * promptTokens 是总输入；cacheHit 是其中命中前缀缓存的部分；其余按未命中计价。
 */
export function costUSD(model: string, promptTokens: number, cacheHit: number, output: number): number {
  const p = PRICES[model] ?? PRICES['deepseek-v4-flash']
  const miss = Math.max(0, promptTokens - cacheHit)
  return (cacheHit * p.hit + miss * p.miss + output * p.out) / 1_000_000
}
