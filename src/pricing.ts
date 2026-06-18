// src/pricing.ts
// 每百万 token 单价（CNY，人民币），核实自 https://api-docs.deepseek.com/zh-cn/quick_start/pricing
const PRICES: Record<string, { hit: number; miss: number; out: number }> = {
  'deepseek-v4-flash': { hit: 0.02, miss: 1, out: 2 },
  'deepseek-v4-pro': { hit: 0.025, miss: 3, out: 6 },
}

/**
 * 计算一次调用的人民币成本。
 * promptTokens 是总输入；cacheHit 是其中命中前缀缓存的部分；其余按未命中计价。
 * 未知模型返回 0。
 */
export function costCNY(model: string, promptTokens: number, cacheHit: number, output: number): number {
  const p = PRICES[model]
  if (!p) return 0
  const miss = Math.max(0, promptTokens - cacheHit)
  return (cacheHit * p.hit + miss * p.miss + output * p.out) / 1_000_000
}

/**
 * 缓存命中省下的人民币金额：命中的 hitTokens 若按未命中价计本要多花的钱。
 * = hitTokens × (miss − hit) / 1e6。未知模型返回 0。
 */
export function cacheSavingsCNY(model: string, hitTokens: number): number {
  const p = PRICES[model]
  if (!p) return 0
  return (hitTokens * (p.miss - p.hit)) / 1_000_000
}
