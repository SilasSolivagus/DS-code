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

/** CJK 感知 token 估算：CJK ×0.6/字、其余 ×0.3/字。空/undefined → 0，绝不抛。
 *  基于 DeepSeek 官方比例（中文 0.6、英文 0.3 token/字符）。over-estimate 偏安全。 */
export function estimateTextTokens(s: string | null | undefined): number {
  if (!s) return 0
  let weighted = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    weighted += isCJK(cp) ? 0.6 : 0.3
  }
  return Math.ceil(weighted)
}
