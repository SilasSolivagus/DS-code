// src/tui/components/StatusFooter.tsx
// CC 风格状态页脚（输入框下方多行）：模型/模式/git、上下文条、记忆与工具计数、快捷键提示。
// 纯展示组件，所有数据由 App 传入。克制配色：仅模型名与上下文条填充用 accent，其余 dim。
// 已剔除 CC 的云端专属信息（5h 配额窗口、hooks、auto-mode 循环）——deepcode 是按 token 计费的 DeepSeek。
import React from 'react'
import { Box, Text } from 'ink'
import { T } from '../theme.js'

export function contextBarColor(pct: number): string {
  if (pct >= 95) return T.err
  if (pct >= 80) return T.warn
  return T.accent
}

function fmtK(n: number): string {
  return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

export function StatusFooter(props: {
  model: string
  mode: string
  cwdBase: string
  branch: string | null
  memoryCount: number
  contextUsed: number
  contextWindow: number
  cost: number
  hitRate: number
  cacheSavings: number
  thinking: boolean
  effortLevel: 'low' | 'medium' | 'high'
  toolCounts: Array<{ name: string; n: number }>
}) {
  const usedPct = props.contextWindow > 0 ? (props.contextUsed / props.contextWindow) * 100 : 0

  // 对照 CC 真实样式（图6）：`[模型 | 模式] | cwd git:(分支)` / `Context used/window · $花费`
  // / `N DEEPCODE.md`（独立行，仅有时显示）/ `✓ Bash ×8 | ✓ Read ×4`（独立行，| 分隔、× 前留空）/ `/ 看命令…`。
  // 注意：记忆行/工具行按需出现 → 行数可变，App 的 IME 光标偏移须同步动态计算（footerExtraRows）。
  return (
    <Box flexDirection="column">
      {/* Row 1：[模型 | 模式] | cwd git:(分支) */}
      <Text>
        <Text dimColor>[</Text>
        <Text color={T.accent}>{props.model}</Text>
        <Text dimColor>{` | ${props.mode}`}</Text>
        {props.thinking && <Text dimColor>{` | think:${props.effortLevel}`}</Text>}
        <Text dimColor>{`]`}</Text>
        <Text dimColor>{` | ${props.cwdBase}`}</Text>
        {props.branch && <Text dimColor>{` git:(${props.branch})`}</Text>}
      </Text>

      {/* Row 2：上下文绝对值 used/window + 缓存命中（仅有命中时）+ 累计花费 */}
      <Text>
        <Text dimColor>Context </Text>
        <Text color={contextBarColor(usedPct)}>{fmtK(props.contextUsed)} / {fmtK(props.contextWindow)}</Text>
        {props.hitRate > 0 && (
          <Text dimColor>{` · cache ${Math.round(props.hitRate * 100)}% (−¥${props.cacheSavings.toFixed(4)})`}</Text>
        )}
        <Text dimColor>{` · ¥${props.cost.toFixed(4)}`}</Text>
      </Text>

      {/* Row 3（仅 memoryCount>0）：记忆文件数 */}
      {props.memoryCount > 0 && <Text dimColor>{`${props.memoryCount} DEEPCODE.md`}</Text>}

      {/* Row 4（仅有工具调用）：工具计数，| 分隔、✓ 绿、× 前留空 */}
      {props.toolCounts.length > 0 && (
        <Text>
          {props.toolCounts.map((t, i) => (
            <Text key={t.name}>
              {i > 0 && <Text dimColor> | </Text>}
              <Text color={T.ok}>✓ </Text>
              <Text dimColor>{`${t.name} ×${t.n}`}</Text>
            </Text>
          ))}
        </Text>
      )}

      {/* Row 5：命令提示。CC 原文是 `? for shortcuts`（按 ? 弹快捷键面板），但 deepcode 的 ? 面板未做、
          而 / 命令菜单现成可用，故提示实际可用的 / 入口（避免广告不存在的功能）。 */}
      <Text dimColor>/ 看命令 · @ 引用文件 · ! 跑 shell</Text>
    </Box>
  )
}
