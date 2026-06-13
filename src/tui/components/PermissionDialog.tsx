// src/tui/components/PermissionDialog.tsx
// 权限确认弹窗：accent 边框面板，diff 预览，高危警告，y/n/a/Enter/Esc 按键处理。
import React from 'react'
import { Box, Text, useInput } from 'ink'
import { T } from '../theme.js'
import { buildPreview } from '../diffPreview.js'
import type { PendingAsk } from '../useChat.js'
import type { Decision } from '../../permissions.js'

export function PermissionDialog(props: {
  ask: PendingAsk
  onDecide: (d: Decision) => void
}) {
  const { ask, onDecide } = props
  const preview = buildPreview(ask.toolName, ask.desc)

  useInput((input, key) => {
    const k = input.toLowerCase()
    if (k === 'y' || key.return) { onDecide('yes'); return }
    if (k === 'n' || key.escape) { onDecide('no'); return }
    if (k === 'a') { onDecide('always'); return }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={T.accent} paddingX={1}>
      <Text bold color={T.accent}>允许 {preview.title} ？</Text>
      {ask.dangerous && (
        <Text color={T.err}>⚠ 高危操作；always 也只精确放行这一条</Text>
      )}
      {preview.lines.map((line, i) => (
        <Text key={i} color={line.sign === '+' ? T.ok : line.sign === '-' ? T.err : T.dim}>
          {line.sign === '+' ? '+ ' : line.sign === '-' ? '- ' : '  '}
          {line.text}
        </Text>
      ))}
      {preview.truncated && (
        <Text dimColor>… (仅显示前 40 行)</Text>
      )}
      <Text dimColor>[y]是  [n]否  [a]总是允许  （Enter=y，Esc=n）</Text>
    </Box>
  )
}
