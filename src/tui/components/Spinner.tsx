// src/tui/components/Spinner.tsx
// CC 风格工作 spinner：忙碌时显示一行 `✻ 琢磨中… (8m 21s · ↓ 1.2k tokens · esc 中断)`。
// 对照 CC 真实样式（图6）：耗时超 60s 显示 `Nm Ms`；token 用 ↓（输出/收到，CC 同款）。
// 符号每 120ms 轮换；动名词每次挂载固定；耗时由 turnStartAt 计算，每秒重渲染一次。
import React, { useState, useEffect } from 'react'
import { Text, Box } from 'ink'
import { useTheme, SPINNER_SYMBOLS, THINKING_VERBS } from '../theme.js'

/** ≥1000 显示 1 位小数 + k（1234→1.2k），否则整数 */
export function fmtTokens(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
}

/** 耗时格式：≥60s 显示 `Nm Ms`（CC 同款），否则 `Ns` */
export function fmtElapsed(s: number): string {
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

interface SpinnerProps {
  turnStartAt: number | null
  turnOutTokens: number
  hookLabel?: string | null
  tip?: string | null
}

export function Spinner({ turnStartAt, turnOutTokens, hookLabel, tip }: SpinnerProps) {
  const T = useTheme()
  const [symIdx, setSymIdx] = useState(0)
  const [, setTick] = useState(0) // 每秒重渲染以刷新耗时
  const [verb] = useState(() => THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)])

  useEffect(() => {
    const sym = setInterval(() => setSymIdx(i => (i + 1) % SPINNER_SYMBOLS.length), 120)
    const sec = setInterval(() => setTick(t => t + 1), 1000)
    return () => { clearInterval(sym); clearInterval(sec) }
  }, [])

  const symbol = SPINNER_SYMBOLS[symIdx]
  const elapsed = turnStartAt ? Math.floor((Date.now() - turnStartAt) / 1000) : 0

  if (hookLabel) {
    return <Text color={T.accent}>{symbol} {hookLabel}</Text>
  }
  return (
    <Box flexDirection="column">
      <Text color={T.accent}>
        {symbol} {verb}… ({fmtElapsed(elapsed)} · ↓ {fmtTokens(turnOutTokens)} tokens · esc 中断)
      </Text>
      {tip ? <Text color={T.dim}>💡 {tip}</Text> : null}
    </Box>
  )
}
