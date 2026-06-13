// src/tui/components/Banner.tsx
// 启动欢迎框：CC 风格圆角框，🐳 deepcode（accent 粗体）+ 一句简介 + cwd/model。
// 不读 package.json；cwd/model 由 App 层作为 prop 传入。
import React from 'react'
import { Box, Text } from 'ink'
import { T } from '../theme.js'

export function Banner(p: { cwd: string; model: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={T.accent} paddingX={1}>
      <Text color={T.accent} bold>🐳 deepcode</Text>
      <Text> </Text>
      <Text dimColor>  DeepSeek 终端编码助手 · 输入 /help 看帮助</Text>
      <Text> </Text>
      <Text dimColor>  cwd: {p.cwd}</Text>
      <Text dimColor>  模型: {p.model}</Text>
    </Box>
  )
}
