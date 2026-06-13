// src/tui/components/ToolLine.tsx
// 工具行：运行中显示 spinner（80ms 轮换），完成后显示 ⎿ 预览 + 耗时。
import React, { useState, useEffect } from 'react'
import { Text } from 'ink'
import { T, SPINNER_FRAMES } from '../theme.js'

interface ToolLineProps {
  name: string
  desc: string
  running: boolean
  ok?: boolean
  preview?: string
  ms?: number
}

export function ToolLine({ name, desc, running, ok, preview, ms }: ToolLineProps) {
  const [frameIdx, setFrameIdx] = useState(0)

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => {
      setFrameIdx(i => (i + 1) % SPINNER_FRAMES.length)
    }, 80)
    return () => clearInterval(id)
  }, [running])

  if (running) {
    const frame = SPINNER_FRAMES[frameIdx]
    return (
      <Text color={T.accent}>{frame} {name}({desc.slice(0, 80)})</Text>
    )
  }

  return (
    <Text color={ok ? T.ok : T.err}>{'  ⎿ '}{preview}（{((ms ?? 0) / 1000).toFixed(1)}s）</Text>
  )
}
