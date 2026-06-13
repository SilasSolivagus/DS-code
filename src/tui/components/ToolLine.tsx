// src/tui/components/ToolLine.tsx
// 工具行（CC 1:1）：⏺ Name(主参数)，accent 色；完成后追加 ⎿ 预览（dim，错误时红）。
// 运行中只显示 ⏺ 行；整体"工作中"由底部 Spinner 指示，本行不做 per-tool 计时/spinner。
import React from 'react'
import { Box, Text } from 'ink'
import { T } from '../theme.js'
import { formatToolArg } from '../toolArg.js'

interface ToolLineProps {
  name: string
  desc: string
  running: boolean
  ok?: boolean
  preview?: string
  ms?: number   // 保留以兼容 Transcript 透传，当前不渲染
}

export function ToolLine({ name, desc, running, ok, preview }: ToolLineProps) {
  return (
    <Box flexDirection="column">
      <Text color={T.accent}>⏺ {name}({formatToolArg(name, desc)})</Text>
      {!running && (
        ok === false
          ? <Text color={T.err}>{'  ⎿  '}{preview}</Text>
          : <Text dimColor>{'  ⎿  '}{preview}</Text>
      )}
    </Box>
  )
}
