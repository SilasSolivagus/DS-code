// src/tui/components/InputBox.tsx
// CC 手感输入框：圆角蓝边框、placeholder、历史↑↓、行尾 \ 续行、Esc 双语义、busy 态提示。
// 不用 ink-text-input：自管 value/cursor，否则历史与续行语义插不进去。
// 偏差说明：计划原版在 Enter 时无条件调 onSubmit；此处加 busy guard——busy 时 Enter 不提交
// （value 仍然可以累积）。注意：guard 会吞掉 busy 期间的 Enter，上层收不到 onSubmit——
// 若要做 CC 式输入排队，需放开此 guard 或加 prop，不能只在上层实现。
// 实现细节：状态变更统一走 setVal helper（同步 ref+state+onChange），useInput handler
// 读 ref 而非闭包，避免连续按键（↑↑↓）时读到旧状态。
import React, { useState, useRef } from 'react'
import { Box, Text, useInput } from 'ink'
import { T } from '../theme.js'

export function InputBox(props: {
  onSubmit: (text: string) => void
  onInterrupt: () => void
  onChange?: (value: string) => void
  /** 补全菜单可见时，↑↓/Tab/Enter 由菜单接管（App 传入） */
  suggestionsActive?: boolean
  history: string[]
  busy: boolean
}) {
  const [value, setValue] = useState('')
  const [pending, setPending] = useState('')        // \ 续行累积
  const [histIdx, setHistIdx] = useState(-1)        // -1 = 不在历史

  // refs 存最新值，让 useInput handler 无论何时调用都读到当前状态
  const valueRef = useRef(value)
  const pendingRef = useRef(pending)
  const histIdxRef = useRef(histIdx)

  // 统一变更入口：value 的 ref/state/onChange 三处必须同步，漏一处就 desync
  const setVal = (v: string) => {
    valueRef.current = v
    setValue(v)
    props.onChange?.(v)
  }

  useInput((input, key) => {
    if (key.escape) {
      if (props.busy) props.onInterrupt()
      else {
        pendingRef.current = ''
        histIdxRef.current = -1
        setPending('')
        setHistIdx(-1)
        setVal('')
      }
      return
    }
    if (key.return) {
      if (props.suggestionsActive) return            // 菜单接管 Enter
      if (props.busy) return                         // busy guard：busy 时忽略提交
      if (valueRef.current.endsWith('\\')) {
        const next = pendingRef.current + valueRef.current.slice(0, -1) + '\n'
        pendingRef.current = next
        setPending(next)
        setVal('')
        return
      }
      const full = pendingRef.current + valueRef.current
      if (!full.trim()) return
      pendingRef.current = ''
      histIdxRef.current = -1
      setPending('')
      setHistIdx(-1)
      setVal('')
      props.onSubmit(full)
      return
    }
    if (key.upArrow || key.downArrow) {
      if (props.suggestionsActive) return            // 菜单接管 ↑↓
      const h = props.history
      if (!h.length) return
      const cur = histIdxRef.current
      const next = key.upArrow ? Math.min(cur + 1, h.length - 1) : Math.max(cur - 1, -1)
      histIdxRef.current = next
      setHistIdx(next)
      setVal(next === -1 ? '' : h[h.length - 1 - next])
      return
    }
    if (key.backspace || key.delete) {
      setVal(valueRef.current.slice(0, -1))
      return
    }
    if (key.ctrl || key.meta || key.tab) return      // tab 留给菜单
    if (input) setVal(valueRef.current + input)
  })

  return (
    <Box flexDirection="column">
      {pending !== '' && <Text dimColor>…续行中（{pending.split('\n').length} 行）</Text>}
      <Box borderStyle="round" borderColor={T.accent} paddingX={1}>
        <Text color={T.accent}>› </Text>
        {value === '' && pending === ''
          ? <Text dimColor>{props.busy ? '生成中… Esc 中断' : '随便问点什么，/ 看命令，@ 引用文件，! 直跑 shell'}</Text>
          : <Text>{value}<Text inverse> </Text></Text>}
      </Box>
    </Box>
  )
}
