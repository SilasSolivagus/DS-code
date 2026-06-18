// 流式 markdown 增量渲染：把文本切成「已稳定前缀」（除最后一个块外的所有块）+「不稳定末尾」（正在增长的块）。
import { marked } from 'marked'
import React, { useRef, useMemo } from 'react'
import { renderMarkdown } from './markdown.js'
import { withBullet } from './withBullet.js'

/** 用 marked 词法切分：除最后一个 token 外的都算已稳定（其 raw 累加为边界）。异常/单块 → 全 unstable。 */
export function splitStablePrefix(text: string): { stable: string; unstable: string } {
  let tokens
  try { tokens = marked.lexer(text) } catch { return { stable: '', unstable: text } }
  if (tokens.length <= 1) return { stable: '', unstable: text }
  let advance = 0
  for (let i = 0; i < tokens.length - 1; i++) advance += (tokens[i].raw ?? '').length
  return { stable: text.slice(0, advance), unstable: text.slice(advance) }
}

/** 流式 markdown 增量渲染：稳定前缀缓存不重解析、不稳定末尾每次重算，带 ⏺ 项目符号。 */
export function StreamingMarkdown({ text }: { text: string }): React.ReactNode {
  const boundaryRef = useRef(0)
  const { stable } = splitStablePrefix(text)
  // 边界单调前进：取已算 stable 与历史最大值的较大者，防 lexer 抖动回退
  if (stable.length > boundaryRef.current) boundaryRef.current = stable.length
  const stablePrefix = text.slice(0, boundaryRef.current)
  const unstableSuffix = text.slice(boundaryRef.current)
  const stableAnsi = useMemo(() => renderMarkdown(stablePrefix), [stablePrefix])
  const unstableAnsi = unstableSuffix ? renderMarkdown(unstableSuffix) : ''
  const joined = stableAnsi && unstableAnsi ? `${stableAnsi}\n\n${unstableAnsi}` : stableAnsi + unstableAnsi
  return withBullet(joined)
}
