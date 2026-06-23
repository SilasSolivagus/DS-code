// src/tui/components/InputBox.tsx
// CC 手感输入框：圆角蓝边框、placeholder、历史↑↓、行尾 \ 续行、Esc 双语义、busy 态提示。
// 不用 ink-text-input：自管 value/cursor，否则历史与续行语义插不进去。
// busy 态：Enter 调 onSteer(text) 排队转向（toolInFlight 时 useChat 内部自动附带软中断）；
// ESC 在队列非空时 onSteerPop 拉回、队列空时 onInterrupt 硬中断。
// 实现细节：状态变更统一走 setVal helper（同步 ref+state+onChange），useInput handler
// 读 ref 而非闭包，避免连续按键（↑↑↓）时读到旧状态。
import React, { useState, useRef, useEffect } from 'react'
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
  /** App 层注入值（补全 pick 后替换整个 draft）。nonce 变化时才实际替换，防止 re-render 重置 */
  valueOverride?: { text: string; nonce: number }
  /** busy 态 steering：统一入口（Enter 时调用；toolInFlight 由 useChat 内部决定是否软中断） */
  onSteer?: (text: string) => void
  /** busy 态 steering：弹出最后一条队列项并回填输入框 */
  onSteerPop?: () => void
  /** 当前 steer 队列长度（决定 ESC busy 语义） */
  steerQueueSize?: number
  /** 当前 steer 队列项（展示排队预览） */
  steerQueueItems?: readonly { value: string; priority?: string }[]
}) {
  const [value, setValue] = useState('')
  const [pending, setPending] = useState('')        // \ 续行累积
  const [histIdx, setHistIdx] = useState(-1)        // -1 = 不在历史

  // refs 存最新值，让 useInput handler 无论何时调用都读到当前状态
  const valueRef = useRef(value)
  const pendingRef = useRef(pending)
  const histIdxRef = useRef(histIdx)
  // 记录上次处理过的 nonce，只在 nonce 变化时注入；挂载时以当前 nonce 初始化（视为已消费，防止 remount 后老值复活）
  const lastNonceRef = useRef<number | undefined>(props.valueOverride?.nonce)

  // 统一变更入口：value 的 ref/state/onChange 三处必须同步，漏一处就 desync
  const setVal = (v: string) => {
    valueRef.current = v
    setValue(v)
    props.onChange?.(v)
  }

  // valueOverride 注入：nonce 变化时替换内部 value（补全 pick 触发）
  useEffect(() => {
    if (props.valueOverride && props.valueOverride.nonce !== lastNonceRef.current) {
      lastNonceRef.current = props.valueOverride.nonce
      setVal(props.valueOverride.text)
    }
  }, [props.valueOverride?.nonce])  // eslint-disable-line react-hooks/exhaustive-deps

  useInput((input, key) => {
    if (key.escape) {
      if (props.busy) {
        if ((props.steerQueueSize ?? 0) > 0) props.onSteerPop?.()
        else props.onInterrupt()
      } else {
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
      // 续行优先（与非 busy 同逻辑）
      if (valueRef.current.endsWith('\\')) {
        const next = pendingRef.current + valueRef.current.slice(0, -1) + '\n'
        pendingRef.current = next
        setPending(next)
        setVal('')
        return
      }
      const full = pendingRef.current + valueRef.current
      if (!full.trim()) return
      if (props.busy) {
        // busy 态：Enter 统一调 onSteer（toolInFlight 时 useChat 内部附带软中断）
        props.onSteer?.(full)
      } else {
        props.onSubmit(full)
      }
      pendingRef.current = ''
      histIdxRef.current = -1
      setPending('')
      setHistIdx(-1)
      setVal('')
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
    if (input) {
      // 粘贴可能夹带控制字符（尤其 \r）：会覆写/串行致光标与文本错位。剥 C0/C1 控制符，保留 \n。
      const clean = input.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '')
      if (clean) setVal(valueRef.current + clean)
    }
  })

  return (
    <Box flexDirection="column">
      {(props.steerQueueItems?.length ?? 0) > 0 && (
        <Box flexDirection="column">
          {props.steerQueueItems!.map((it, i) => (
            <Text key={i} dimColor>
              {'⏵ 排队 '}
              {it.value.length > 60 ? it.value.slice(0, 60) + '…' : it.value}
            </Text>
          ))}
        </Box>
      )}
      {pending !== '' && <Text dimColor>…续行中（{pending.split('\n').length} 行）</Text>}
      <Box borderStyle="round" borderColor={T.accent} borderLeft={false} borderRight={false} paddingX={1}>
        <Text color={T.accent}>{'❯ '}</Text>
        {value === '' && pending === ''
          ? <Text dimColor>{props.busy ? '生成中… esc 中断' : '随便问点什么…'}</Text>
          : <Text>{value}<Text inverse> </Text></Text>}
      </Box>
    </Box>
  )
}
