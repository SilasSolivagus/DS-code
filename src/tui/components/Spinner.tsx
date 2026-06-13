// src/tui/components/Spinner.tsx
// CC 风格工作 spinner：忙碌时显示一行 `✻ 琢磨中… (12s · ↑ 1.2k tokens · esc 中断)`。
// 符号每 120ms 轮换；动名词每次挂载固定；耗时由 turnStartAt 计算，每秒重渲染一次。
import React, { useState, useEffect } from 'react'
import { Text } from 'ink'
import { T, SPINNER_SYMBOLS, THINKING_VERBS } from '../theme.js'

/** ≥1000 显示 1 位小数 + k（1234→1.2k），否则整数 */
export function fmtTokens(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
}

interface SpinnerProps {
  turnStartAt: number | null
  turnOutTokens: number
}

export function Spinner({ turnStartAt, turnOutTokens }: SpinnerProps) {
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

  return (
    <Text color={T.accent}>
      {symbol} {verb}… ({elapsed}s · ↑ {fmtTokens(turnOutTokens)} tokens · esc 中断)
    </Text>
  )
}
