// src/tui/components/SelectList.tsx
// 通用 ↑↓ Enter Esc 列表选择器（/resume 用）。选中行 accent 反色，其余 dim。
import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { useTheme } from '../theme.js'

export function SelectList(p: {
  items: string[]
  onPick: (index: number) => void
  onCancel: () => void
}) {
  const T = useTheme()
  const [idx, setIdx] = useState(0)

  useInput((_input, key) => {
    if (key.upArrow) {
      setIdx(i => Math.max(0, i - 1))
      return
    }
    if (key.downArrow) {
      setIdx(i => Math.min(p.items.length - 1, i + 1))
      return
    }
    if (key.return) {
      p.onPick(idx)
      return
    }
    if (key.escape) {
      p.onCancel()
      return
    }
  })

  return (
    <Box flexDirection="column">
      {p.items.map((item, i) => (
        <Text key={i} color={i === idx ? T.accent : undefined} inverse={i === idx} dimColor={i !== idx}>
          {item}
        </Text>
      ))}
    </Box>
  )
}
