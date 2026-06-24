// src/tui/components/Suggestions.tsx
// 斜杠命令 + @文件 浮动补全菜单：↑↓ 移动，Tab/Enter 确认补全。
import React, { useState, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import { useTheme } from '../theme.js'
import type { Suggestion } from '../suggest.js'

export function Suggestions(props: {
  items: Suggestion[]
  onPick: (value: string) => void
}) {
  const T = useTheme()
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
      if (items[idx]) onPick(items[idx].value) // items 收缩瞬间按键的越界保护
      return
    }
  })

  if (!items.length) return null

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={T.accent}>
      {items.map((item, i) => (
        // 选中项：accent 背景高亮（对齐 CC）；命令描述/提示统一 dim。
        <Box key={item.value}>
          <Text backgroundColor={i === idx ? T.accent : undefined}>
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
