// src/tui/components/StatusLine.tsx
// 常驻底部状态行：模型·标志 │ 缓存命中 │ 花费 │ tok/s。缓存命中率是 DeepSeek 的招牌指标。
import React from 'react'
import { Box, Text } from 'ink'
import { T } from '../theme.js'

export function StatusLine(p: {
  model: string; thinking: boolean; permMode: string
  cacheHitRate: number; cost: number; tokPerSec: number | null
}) {
  const shortName = p.model.includes('pro') ? 'pro' : 'flash'
  const tags = [shortName]
  if (p.thinking) tags.push('think')
  if (p.permMode === 'acceptEdits') tags.push('accept')
  if (p.permMode === 'yolo') tags.push('yolo')
  return (
    <Box>
      <Text color={T.accent}>{tags.join('·')}</Text>
      <Text dimColor>{' │ 缓存命中 '}{Math.round(p.cacheHitRate * 100)}%</Text>
      <Text dimColor>{' │ $'}{p.cost.toFixed(4)}</Text>
      <Text dimColor>{' │ '}{p.tokPerSec === null ? '— tok/s' : `${Math.round(p.tokPerSec)} tok/s`}</Text>
    </Box>
  )
}
