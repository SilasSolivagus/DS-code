// src/pricing.ts
import { activeModelMeta } from './providers.js'

/** 计算一次调用的人民币成本。未知模型走 active provider 的 defaultMeta（不再恒 0）。 */
export function costCNY(model: string, promptTokens: number, cacheHit: number, output: number): number {
  const p = activeModelMeta(model)
  const miss = Math.max(0, promptTokens - cacheHit)
  return (cacheHit * p.hit + miss * p.miss + output * p.out) / 1_000_000
}

/** 缓存命中省下的人民币金额 = hitTokens × (miss − hit) / 1e6。 */
export function cacheSavingsCNY(model: string, hitTokens: number): number {
  const p = activeModelMeta(model)
  return (hitTokens * (p.miss - p.hit)) / 1_000_000
}
