// src/tui/components/ToolLine.tsx
// 工具行（CC 1:1）：⏺ Name(主参数)，accent 色；完成后追加 ⎿ 预览（dim，错误时红）。
// 运行中只显示 ⏺ 行；整体"工作中"由底部 Spinner 指示，本行不做 per-tool 计时/spinner。
import React from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../theme.js'
import { formatToolArg } from '../toolArg.js'

interface ToolLineProps {
  name: string
  desc: string
  running: boolean
  ok?: boolean
  preview?: string
  previewExtra?: number   // 预览之外的剩余行数（CC 的「… +N 行」）
  ms?: number   // 保留以兼容 Transcript 透传，当前不渲染
}

export function ToolLine({ name, desc, running, ok, preview, previewExtra }: ToolLineProps) {
  const T = useTheme()
  // 多行预览（对照 CC）：首行 `  ⎿  内容`，续行缩进 5 列对齐内容；错误用红，否则 dim。
  const lines = (preview ?? '').split('\n')
  const isErr = ok === false
  return (
    <Box flexDirection="column">
      <Text color={T.accent}>⏺ {name}({formatToolArg(name, desc)})</Text>
      {!running && lines.map((l, i) => (
        <Text key={i} color={isErr ? T.err : undefined} dimColor={!isErr}>
          {i === 0 ? '  ⎿  ' : '     '}{l}
        </Text>
      ))}
      {!running && (previewExtra ?? 0) > 0 && (
        <Text dimColor>{'     '}… +{previewExtra} 行</Text>
      )}
    </Box>
  )
}
