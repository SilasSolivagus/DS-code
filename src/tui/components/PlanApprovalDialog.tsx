// src/tui/components/PlanApprovalDialog.tsx
// ExitPlanMode 计划审批弹窗：展示模型写好的计划，用户批准/拒绝。
// 复用 PermissionDialog 的 UI 风格（accent 边框，数字键+方向键+Enter）。
// 注：此组件独立新建而非复用 PermissionDialog，原因：计划审批是纯 boolean 批准/拒绝语义，
// 而 PermissionDialog 的决策类型为 yes/always/no 三态 Decision，语义不兼容；
// 强行复用需要额外转接层，反而增加耦合和理解成本。
import React, { useState, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import { useTheme } from '../theme.js'
import type { PendingPlanApproval } from '../useChat.js'

const OPTIONS: Array<{ label: string; approved: boolean }> = [
  { label: '批准（退出 plan 模式，开始执行）', approved: true },
  { label: '拒绝（留在 plan 模式，请模型修改计划）', approved: false },
]

const PLAN_PREVIEW_LINES = 30

export function PlanApprovalDialog(props: {
  pending: PendingPlanApproval
  onDecide: (approved: boolean) => void
}) {
  const T = useTheme()
  const { pending, onDecide } = props
  const [idx, setIdx] = useState(0)

  // 连续两个弹窗间重置选中位置
  useEffect(() => { setIdx(0) }, [pending])

  useInput((input, key) => {
    if (key.upArrow) { setIdx(i => Math.max(0, i - 1)); return }
    if (key.downArrow) { setIdx(i => Math.min(OPTIONS.length - 1, i + 1)); return }
    if (key.return) { onDecide(OPTIONS[idx].approved); return }
    if (key.escape) { onDecide(false); return }
    const k = input.toLowerCase()
    if (k === 'y' || k === '1') { onDecide(true); return }
    if (k === 'n' || k === '2') { onDecide(false); return }
  })

  // 计划预览：前 PLAN_PREVIEW_LINES 行
  const planLines = pending.plan.split('\n')
  const truncated = planLines.length > PLAN_PREVIEW_LINES
  const previewLines = planLines.slice(0, PLAN_PREVIEW_LINES)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={T.accent} paddingX={1}>
      <Text bold color={T.accent}>ExitPlanMode — 计划请求批准</Text>
      <Text dimColor>模型已完成探索，提交以下实施计划：</Text>
      {previewLines.map((line, i) => (
        <Text key={i} dimColor={line.startsWith('#')} bold={line.startsWith('#')}>
          {line}
        </Text>
      ))}
      {truncated && (
        <Text dimColor>… （计划共 {planLines.length} 行，仅显示前 {PLAN_PREVIEW_LINES} 行）</Text>
      )}
      {(pending.allowedPrompts ?? []).length > 0 && (
        <Text dimColor>附带放行 Bash 操作：{pending.allowedPrompts!.map(p => p.prompt).join('、')}</Text>
      )}
      <Text>批准此计划并退出 plan 模式吗？</Text>
      {OPTIONS.map((opt, i) => (
        <Text key={String(opt.approved)} color={i === idx ? T.accent : undefined} dimColor={i !== idx}>
          {i === idx ? '❯ ' : '  '}
          {i + 1}. {opt.label}
        </Text>
      ))}
      <Text dimColor>↑↓/数字 选择 · Enter 确认 · Esc 拒绝</Text>
    </Box>
  )
}
