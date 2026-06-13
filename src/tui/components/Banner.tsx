// src/tui/components/Banner.tsx
// 启动欢迎框（对照 CC 双列欢迎页）：圆角 accent 框，左列（标题/欢迎/鲸鱼/账号/cwd）+ │ + 右列（上手/小贴士）。
// 防弹布局：不用 flex 行（ink/yoga 在 row 方向会阶梯错乱），改为每行手工拼等宽字符串——
// 左段按可见宽补齐到 LEFT_W，再接 │ 与右段，整框是一列等宽 <Text> 行，边框必齐。
import React from 'react'
import os from 'node:os'
import { Box, Text } from 'ink'
import { T } from '../theme.js'

// 鲸鱼吉祥物：头顶喷水 + 圆身 + 尾鳍 + 眼睛
const WHALE = [
  '     \\ : /',
  "      '·'",
  '  .-~~~~-.',
  ' __/      \\',
  '<  (    o  )',
  ' --\\      /',
  "    '-.__.-'",
]

// 可见宽度：CJK/全角/emoji 计 2 列，其余 1 列
function dispWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if ((c >= 0x1100 && c <= 0x115F) || (c >= 0x2E80 && c <= 0xA4CF) ||
        (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0xF900 && c <= 0xFAFF) ||
        (c >= 0xFE30 && c <= 0xFF60) || (c >= 0xFFE0 && c <= 0xFFE6) ||
        (c >= 0x1F000 && c <= 0x1FAFF) || (c >= 0x20000 && c <= 0x3FFFD)) w += 2
    else w += 1
  }
  return w
}
const padTo = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - dispWidth(s)))

type Seg = { text: string; color?: string; dim?: boolean; bold?: boolean }

export function Banner(p: { cwd: string; model: string }) {
  let user = ''
  try { user = os.userInfo().username } catch { /* 兜底空 */ }

  const left: Seg[] = [
    { text: '🐳 deepcode', color: T.accent, bold: true },
    { text: user ? `欢迎回来，${user}！` : '欢迎使用 deepcode！', bold: true },
    { text: '' },
    ...WHALE.map(l => ({ text: l, color: T.accent })),
    { text: '' },
    { text: `${p.model} · DeepSeek`, dim: true },
    { text: p.cwd, dim: true },
  ]
  const right: Seg[] = [
    { text: '上手', color: T.accent, bold: true },
    { text: '输入 /help 看全部命令' },
    { text: '/init 生成 CLAUDE.md' },
    { text: '' },
    { text: '小贴士', color: T.accent, bold: true },
    { text: '@ 引用文件 · ! 直跑 shell', dim: true },
    { text: '/model 切模型 · /think 开思考', dim: true },
  ]

  const LEFT_W = Math.max(...left.map(s => dispWidth(s.text)))
  const rows = Math.max(left.length, right.length)
  const blank: Seg = { text: '' }

  return (
    <Box borderStyle="round" borderColor={T.accent} paddingX={1} flexDirection="column">
      {Array.from({ length: rows }, (_, i) => {
        const l = left[i] ?? blank
        const r = right[i] ?? blank
        return (
          <Text key={i}>
            <Text color={l.color} dimColor={l.dim} bold={l.bold}>{padTo(l.text, LEFT_W)}</Text>
            <Text dimColor>{'   │   '}</Text>
            <Text color={r.color} dimColor={r.dim} bold={r.bold}>{r.text}</Text>
          </Text>
        )
      })}
    </Box>
  )
}
