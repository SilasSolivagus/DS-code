// src/tui/ScrollView.tsx
// 裁剪滚动视口：外层固定高度 height（由父算 = min(内容高, 可用高)）+ overflowY:'hidden' 真裁剪
// （ink render-node-to-output.js:60）；内层 flexShrink=0 渲染全部 item（复用 renderItem），
// marginTop=-offset 实现向上滚。每帧后用 measureElement 量内层高(totalH)上报父，父据此算 height/maxScroll/auto-follow。
import React, { useRef, useLayoutEffect } from 'react'
import { Box, measureElement, type DOMElement } from 'ink'
import { renderItem } from './renderItem.js'
import { useTheme, BLOCK_GAP } from './theme.js'
import type { TranscriptItem } from './useChat.js'

export function ScrollView(props: {
  items: TranscriptItem[]
  scrollOffset: number
  height: number
  onMeasureTotal: (totalH: number) => void
  banner?: React.ReactNode
}) {
  const theme = useTheme()
  const innerRef = useRef<DOMElement | null>(null)

  useLayoutEffect(() => {
    try {
      props.onMeasureTotal(innerRef.current ? measureElement(innerRef.current).height : 0)
    } catch {
      props.onMeasureTotal(0)
    }
  })

  return (
    <Box height={props.height} overflowY="hidden" flexDirection="column" flexShrink={0}>
      <Box ref={innerRef} flexDirection="column" flexShrink={0} marginTop={-props.scrollOffset}>
        {props.banner}
        {props.items.map((it, i) => (
          <Box key={i} marginTop={i > 0 || props.banner ? BLOCK_GAP : 0}>{renderItem(it, i, theme)}</Box>
        ))}
      </Box>
    </Box>
  )
}
