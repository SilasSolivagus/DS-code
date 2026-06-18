import React from 'react'
import { Box, Text } from 'ink'
import { T } from './theme.js'

/** CC 风格 ⏺ 项目符号：首行带 accent 圆点，续行回到 col 0 不缩进（对照 CC 真实样式：圆点悬出、正文整体左对齐）。 */
export function withBullet(content: string): React.ReactNode {
  const lines = content.split('\n')
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i}>
          {i === 0 ? <Text color={T.accent}>{'⏺ '}</Text> : ''}
          {line}
        </Text>
      ))}
    </Box>
  )
}
