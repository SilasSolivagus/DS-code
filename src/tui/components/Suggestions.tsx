// src/tui/components/Suggestions.tsx
// 斜杠命令 + @文件 浮动补全菜单：↑↓ 移动，Tab/Enter 确认补全。
import React, { useState, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import { T } from '../theme.js'
import type { Suggestion } from '../suggest.js'

export function Suggestions(props: {
  items: Suggestion[]
  onPick: (value: string) => void
}) {
  const { items, onPick } = props
  const [idx, setIdx] = useState(0)

  // 当 items 引用变化时重置选中索引，防止越界
  useEffect(() => {
    setIdx(0)
  }, [items])

  useInput((input, key) => {
    if (!items.length) return
    if (key.downArrow) {
      setIdx(i => Math.min(i + 1, items.length - 1))
      return
    }
    if (key.upArrow) {
      setIdx(i => Math.max(i - 1, 0))
      return
    }
    if (key.tab || key.return) {
      onPick(items[idx].value)
      return
    }
  })

  if (!items.length) return null

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={T.accent}>
      {items.map((item, i) => (
        <Box key={item.value}>
          <Text
            backgroundColor={i === idx ? T.accent : undefined}
            inverse={i === idx}
          >
            {item.value}
          </Text>
          {item.hint !== '' && (
            <Text dimColor>{'  '}{item.hint}</Text>
          )}
        </Box>
      ))}
    </Box>
  )
}
