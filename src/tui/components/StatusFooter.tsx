// src/tui/components/StatusFooter.tsx
// CC 风格状态页脚（输入框下方多行）：模型/模式/git、上下文条、记忆与工具计数、快捷键提示。
// 纯展示组件，所有数据由 App 传入。克制配色：仅模型名与上下文条填充用 accent，其余 dim。
// 已剔除 CC 的云端专属信息（5h 配额窗口、hooks、auto-mode 循环）——deepcode 是按 token 计费的 DeepSeek。
import React from 'react'
import { Box, Text } from 'ink'
import { T } from '../theme.js'

export function StatusFooter(props: {
  model: string
  mode: string
  cwdBase: string
  branch: string | null
  memoryCount: number
  contextPct: number
  cost: number
  toolCounts: Array<{ name: string; n: number }>
}) {
  // 上下文条：10 格，filled 用 ▓（accent），其余 ░（dim）
  const filled = Math.round(props.contextPct / 10)
  const bar = { fill: '▓'.repeat(filled), empty: '░'.repeat(10 - filled) }

  return (
    <Box flexDirection="column">
      {/* Row 1：模型 · 模式  目录 git:(分支) */}
      <Text>
        <Text color={T.accent}>{props.model}</Text>
        <Text dimColor>{` · ${props.mode}`}</Text>
        <Text dimColor>{`   ${props.cwdBase}`}</Text>
        {props.branch && <Text dimColor>{` git:(${props.branch})`}</Text>}
      </Text>

      {/* Row 2：上下文条 + 累计花费 */}
      <Text>
        <Text dimColor>Context </Text>
        <Text color={T.accent}>{bar.fill}</Text>
        <Text dimColor>{bar.empty}</Text>
        <Text dimColor>{` ${props.contextPct}% · $${props.cost.toFixed(4)}`}</Text>
      </Text>

      {/* Row 3：记忆文件数 + 工具调用计数 */}
      <Text>
        {props.memoryCount > 0 && <Text dimColor>{`${props.memoryCount} CLAUDE.md`}</Text>}
        {props.toolCounts.length === 0
          ? (props.memoryCount === 0 ? <Text dimColor>（暂无工具调用）</Text> : null)
          : props.toolCounts.map((t, i) => (
              <Text key={t.name}>
                <Text dimColor>{i === 0 && props.memoryCount === 0 ? '' : ' · '}</Text>
                <Text color={T.ok}>✓ </Text>
                <Text dimColor>{`${t.name}×${t.n}`}</Text>
              </Text>
            ))}
      </Text>

      {/* Row 4：快捷键提示 */}
      <Text dimColor>? 查看快捷键</Text>
    </Box>
  )
}
