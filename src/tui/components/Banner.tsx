// src/tui/components/Banner.tsx
// 启动横幅：🐳 deepcode v{version}（accent 粗体）+ 第二行 dim 提示行。
// version 由 App 层读取后作为 prop 传入，组件本身不读 package.json。
import React from 'react'
import { Box, Text } from 'ink'
import { T } from '../theme.js'

export function Banner(p: { model: string; yolo: boolean; version: string }) {
  const hint = `${p.model}${p.yolo ? '（yolo）' : ''} · / 命令 · @ 文件 · ! shell · Esc 中断 · Ctrl+C×2 退出`
  return (
    <Box flexDirection="column">
      <Text color={T.accent} bold>{'🐳 deepcode v'}{p.version}</Text>
      <Text dimColor>{hint}</Text>
    </Box>
  )
}
