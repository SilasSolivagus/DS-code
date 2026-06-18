// 流式 markdown 增量渲染：把文本切成「已稳定前缀」（除最后一个块外的所有块）+「不稳定末尾」（正在增长的块）。
import { marked } from 'marked'

/** 用 marked 词法切分：除最后一个 token 外的都算已稳定（其 raw 累加为边界）。异常/单块 → 全 unstable。 */
export function splitStablePrefix(text: string): { stable: string; unstable: string } {
  let tokens
  try { tokens = marked.lexer(text) } catch { return { stable: '', unstable: text } }
  if (tokens.length <= 1) return { stable: '', unstable: text }
  let advance = 0
  for (let i = 0; i < tokens.length - 1; i++) advance += (tokens[i].raw ?? '').length
  return { stable: text.slice(0, advance), unstable: text.slice(advance) }
}
