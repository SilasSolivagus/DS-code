// src/tui/components/PermissionDialog.tsx
// 权限确认弹窗：accent 边框面板，diff 预览，高危警告，CC 式 ↑↓+Enter 方向键菜单（y/n/a 快捷键保留）。
import React, { useState, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import { T } from '../theme.js'
import { buildPreview } from '../diffPreview.js'
import type { PendingAsk } from '../useChat.js'
import type { Decision } from '../../permissions.js'

const OPTIONS: Array<{ label: string; decision: Decision }> = [
  { label: '允许', decision: 'yes' },
  { label: '总是允许', decision: 'always' },
  { label: '拒绝', decision: 'no' },
]

export function PermissionDialog(props: {
  ask: PendingAsk
  onDecide: (d: Decision) => void
}) {
  const { ask, onDecide } = props
  const preview = buildPreview(ask.toolName, ask.desc)
  const [idx, setIdx] = useState(0)

  // 连续两个弹窗间组件可能不卸载（resolve→下一个 ask 仅隔一个微任务），
  // 选中位置必须随 ask 重置，否则上一个弹窗选到"总是允许"后快速 Enter 会误授下一个工具。
  useEffect(() => { setIdx(0) }, [ask])

  useInput((input, key) => {
    if (key.upArrow) { setIdx(i => Math.max(0, i - 1)); return }
    if (key.downArrow) { setIdx(i => Math.min(OPTIONS.length - 1, i + 1)); return }
    if (key.return) { onDecide(OPTIONS[idx].decision); return }
    if (key.escape) { onDecide('no'); return }
    const k = input.toLowerCase()
    if (k === 'y') { onDecide('yes'); return }
    if (k === 'n') { onDecide('no'); return }
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
      {OPTIONS.map((opt, i) => (
        <Text key={opt.decision} color={i === idx ? T.accent : undefined} dimColor={i !== idx}>
          {i === idx ? '❯ ' : '  '}
          {opt.label}
        </Text>
      ))}
      <Text dimColor>↑↓ 选择 · Enter 确认 · y/n/a 快捷键 · Esc 拒绝</Text>
    </Box>
  )
}
