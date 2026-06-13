// src/tui/App.tsx
// 装配层：useChat + 全部组件 + 焦点路由。
// InputBox value 注入：通过 valueOverride={{ text, nonce }} prop 实现（最小改动，保持 InputBox 内部受控逻辑不变）。
// 补全菜单隐藏策略：onPick 后设置 justPickedValue，若 draft === justPickedValue 则不展示菜单；用户再输入时 draft 变化即恢复。
import React, { useMemo, useState, useRef, useEffect } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { createChatCore, useChat } from './useChat.js'
import { computeSuggestions } from './suggest.js'
import { Banner } from './components/Banner.js'
import { Transcript } from './components/Transcript.js'
import { InputBox } from './components/InputBox.js'
import { Suggestions } from './components/Suggestions.js'
import { PermissionDialog } from './components/PermissionDialog.js'
import { SelectList } from './components/SelectList.js'
import { Spinner } from './components/Spinner.js'

export function App(props: {
  client: any
  yolo: boolean
  cwd: string
  continueSession?: boolean
  sessionDir?: string  // 测试注入：隔离 session 落盘目录
}) {
  const { exit } = useApp()
  const core = useMemo(() => createChatCore({
    client: props.client,
    yolo: props.yolo,
    cwd: props.cwd,
    continueSession: props.continueSession,
    sessionDir: props.sessionDir,
    onState: () => {},
  }), [])  // eslint-disable-line react-hooks/exhaustive-deps
  const state = useChat(core)
  const [draft, setDraft] = useState('')
  const [resumeMode, setResumeMode] = useState(false)
  const [lastSigint, setLastSigint] = useState(0)
  // 补全菜单隐藏：onPick 后记录刚选中的值，若 draft 恰好等于该值则不显示菜单
  const justPickedRef = useRef<string | null>(null)
  // InputBox value 注入：通过 nonce 强制 InputBox 接受新值
  const [valueOverride, setValueOverride] = useState<{ text: string; nonce: number } | undefined>(undefined)

  // pendingAsk / resumeMode 激活时清除 draft 和 valueOverride，防止 InputBox 卸载后 remount 时老值复活
  useEffect(() => {
    if (state.pendingAsk || resumeMode) {
      setDraft('')
      setValueOverride(undefined)
      justPickedRef.current = null
    }
  }, [!!state.pendingAsk, resumeMode])  // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl+C 两次退出（App 层统一管理，exitOnCtrlC: false 时才需要）
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      const now = Date.now()
      if (now - lastSigint < 2000) exit()
      else setLastSigint(now)
    }
  })

  const handleDraftChange = (v: string) => {
    setDraft(v)
    // 用户有输入时清除 justPicked 记录（draft 已偏离 pick 结果）
    if (justPickedRef.current !== null && v !== justPickedRef.current) {
      justPickedRef.current = null
    }
  }

  const suggestions = useMemo(
    () => {
      // 刚刚 pick 后不显示菜单（防止选 /model 后立刻再弹出）
      if (justPickedRef.current !== null && draft === justPickedRef.current) return []
      return computeSuggestions(draft, { cwd: props.cwd, customCommands: core.customCommands })
    },
    [draft],  // eslint-disable-line react-hooks/exhaustive-deps
  )

  const handlePick = (v: string) => {
    let newDraft: string
    if (v.startsWith('@')) {
      // @补全：替换末尾的 @fragment
      newDraft = draft.replace(/@[\w./-]*$/, v)
    } else {
      // 斜杠补全：整行替换
      newDraft = v
    }
    justPickedRef.current = newDraft
    setDraft(newDraft)
    // 注入 InputBox 新值
    setValueOverride(prev => ({ text: newDraft, nonce: (prev?.nonce ?? 0) + 1 }))
  }

  const submit = (text: string) => {
    if (text === '/exit') { exit(); return }
    if (text === '/resume') { setResumeMode(true); return }
    setDraft('')
    setValueOverride(undefined)
    justPickedRef.current = null
    void core.send(text)
  }

  const historyItems = state.transcript
    .filter(i => i.kind === 'user')
    .map(i => (i as { kind: 'user'; text: string }).text)

  const suggestionsActive = suggestions.length > 0

  return (
    <Box flexDirection="column">
      <Banner cwd={props.cwd} model={state.model} />
      <Transcript items={state.transcript} />
      {state.pendingAsk
        ? <PermissionDialog ask={state.pendingAsk} onDecide={d => core.resolveAsk(d)} />
        : resumeMode
          ? <SelectList
              items={core.resumeList().map(s => s.preview)}
              onPick={i => { core.resume(core.resumeList()[i].file); setResumeMode(false) }}
              onCancel={() => setResumeMode(false)}
            />
          : <>
              {state.busy && <Spinner turnStartAt={state.turnStartAt} turnOutTokens={state.turnOutTokens} />}
              {suggestionsActive && (
                <Suggestions items={suggestions} onPick={handlePick} />
              )}
              <InputBox
                onSubmit={submit}
                onInterrupt={() => core.interrupt()}
                onChange={handleDraftChange}
                suggestionsActive={suggestionsActive}
                history={historyItems}
                busy={state.busy}
                valueOverride={valueOverride}
              />
            </>
      }
    </Box>
  )
}
