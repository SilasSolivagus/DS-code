// src/tui/App.tsx
// 装配层：useChat + 全部组件 + 焦点路由。
// InputBox value 注入：通过 valueOverride={{ text, nonce }} prop 实现（最小改动，保持 InputBox 内部受控逻辑不变）。
// 补全菜单隐藏策略：onPick 后设置 justPickedValue，若 draft === justPickedValue 则不展示菜单；用户再输入时 draft 变化即恢复。
import React, { useMemo, useState, useRef, useEffect } from 'react'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { Box, Text, useApp, useInput } from 'ink'
import { createChatCore, useChat } from './useChat.js'
import { findMemoryFiles } from '../prompt.js'
import { computeSuggestions } from './suggest.js'
import { Banner } from './components/Banner.js'
import { Transcript } from './components/Transcript.js'
import { InputBox } from './components/InputBox.js'
import { Suggestions } from './components/Suggestions.js'
import { PermissionDialog } from './components/PermissionDialog.js'
import { SelectList } from './components/SelectList.js'
import { Spinner } from './components/Spinner.js'
import { StatusFooter } from './components/StatusFooter.js'

// 输入框插入点到输出底部的行数：输入框底边线(1) + 状态页脚(4) = 5。
// 布局若变（页脚行数变化等）需同步调整——IME 光标停泊依赖它。
const LINES_BELOW_CARET = 5

// CJK/全角字符按 2 列宽计（终端等宽规则）；用于算输入框插入点的列号。
function dispWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if ((c >= 0x1100 && c <= 0x115F) || (c >= 0x2E80 && c <= 0xA4CF) ||
        (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0xF900 && c <= 0xFAFF) ||
        (c >= 0xFE30 && c <= 0xFE4F) || (c >= 0xFF00 && c <= 0xFF60) ||
        (c >= 0xFFE0 && c <= 0xFFE6) || (c >= 0x20000 && c <= 0x3FFFD)) w += 2
    else w += 1
  }
  return w
}

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

  // —— 状态页脚数据 —— 启动时算一次的静态项（git 分支、记忆文件数、目录名）
  const cwdBase = useMemo(() => path.basename(props.cwd), [])  // eslint-disable-line react-hooks/exhaustive-deps
  const branch = useMemo(() => {
    try {
      return execSync('git branch --show-current', { cwd: props.cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null
    } catch { return null }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  const memoryCount = useMemo(() => findMemoryFiles(props.cwd).length, [])  // eslint-disable-line react-hooks/exhaustive-deps
  // 模式标签：权限模式 + thinking 后缀
  const modeLabel = (state.permMode === 'acceptEdits' ? 'accept' : state.permMode === 'yolo' ? 'yolo' : 'default')
    + (state.thinking ? '·think' : '')
  // 工具调用计数：按首次出现顺序分组（transcript 中 kind==='tool' 的条目）
  const toolCounts = useMemo(() => {
    const order: string[] = []
    const counts = new Map<string, number>()
    for (const it of state.transcript) {
      if (it.kind === 'tool') {
        if (!counts.has(it.name)) order.push(it.name)
        counts.set(it.name, (counts.get(it.name) ?? 0) + 1)
      }
    }
    return order.map(name => ({ name, n: counts.get(name)! }))
  }, [state.transcript])

  // IME 光标停泊（仅真 TTY）：原版 ink 全程藏光标、把它留在输出末尾，导致中文输入法的组字
  // 预编辑出现在最底部而非输入框内（字"跳"出框外）。这里每帧渲染后把硬件光标移回输入框插入点，
  // 让组字内联显示。setTimeout(0) 让写入落在 ink 的帧写入（微任务）之后，否则会被 ink 覆盖。
  // 仅在输入框激活（非权限弹窗/恢复/生成中）且为真 TTY 时停泊；非 TTY（测试/管道）跳过。
  const inputActive = !state.pendingAsk && !resumeMode && !state.busy
  useEffect(() => {
    if (!inputActive || !process.stdout.isTTY) return
    const col = 4 + dispWidth(draft)  // 列：1=左内边距, 2-3="❯ ", 4+=输入文本；插入点在文本之后
    const id = setTimeout(() => {
      try { process.stdout.write(`\x1b[?25h\x1b[${LINES_BELOW_CARET}A\x1b[${col}G`) } catch { /* 忽略写入失败 */ }
    }, 0)
    return () => clearTimeout(id)
  })

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
      <StatusFooter
        model={state.model}
        mode={modeLabel}
        cwdBase={cwdBase}
        branch={branch}
        memoryCount={memoryCount}
        contextPct={state.contextPct()}
        cost={state.sessionCost()}
        toolCounts={toolCounts}
      />
    </Box>
  )
}
