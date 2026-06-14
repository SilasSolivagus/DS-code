// src/tui/ScrollView.tsx
// 裁剪滚动视口：外层固定高度 + overflowY:'hidden' 真裁剪（ink render-node-to-output.js:60）；
// 内层 flexShrink=0 渲染全部 item（复用 renderItem），marginTop=-offset 实现向上滚。
// 每帧后用 measureElement 量外层高(viewportH)与内层高(totalH)上报父，父据此算 maxScroll/auto-follow。
import React, { useRef, useLayoutEffect } from 'react'
import { Box, measureElement, type DOMElement } from 'ink'
import { renderItem } from './renderItem.js'
import type { TranscriptItem } from './useChat.js'

export function ScrollView(props: {
  items: TranscriptItem[]
  scrollOffset: number
  onMeasure: (viewportH: number, totalH: number) => void
  banner?: React.ReactNode
}) {
  const outerRef = useRef<DOMElement | null>(null)
  const innerRef = useRef<DOMElement | null>(null)

  useLayoutEffect(() => {
    try {
      const vh = outerRef.current ? measureElement(outerRef.current).height : 0
      const th = innerRef.current ? measureElement(innerRef.current).height : 0
      props.onMeasure(vh, th)
    } catch {
      props.onMeasure(0, 0)
    }
  })

  return (
    <Box ref={outerRef} flexGrow={1} flexShrink={1} minHeight={0} overflowY="hidden" flexDirection="column">
      <Box ref={innerRef} flexDirection="column" flexShrink={0} marginTop={-props.scrollOffset}>
        {props.banner}
        {props.items.map((it, i) => renderItem(it, i))}
      </Box>
    </Box>
  )
}
