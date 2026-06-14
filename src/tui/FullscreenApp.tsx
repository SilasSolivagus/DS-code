// src/tui/FullscreenApp.tsx
// 全屏可滚变体（M8 P1）：alt-screen 全屏 + 键盘滚动（PageUp/PageDown/Ctrl+G）+ auto-follow。
// 复用 App 的全部接线，仅把转录渲染换成 ScrollView，并加滚动状态 + alt-screen 生命周期 +
// 绝对定位 IME 光标停泊。useChat 会话核心零改动。内联模式仍走 App。
import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { createChatCore, useChat } from './useChat.js'
import { findMemoryFiles } from '../prompt.js'
import { computeSuggestions } from './suggest.js'
import { parkCol } from './caret.js'
import { Banner } from './components/Banner.js'
import { ScrollView } from './ScrollView.js'
import { InputBox } from './components/InputBox.js'
import { Suggestions } from './components/Suggestions.js'
import { PermissionDialog } from './components/PermissionDialog.js'
import { QuestionDialog } from './components/QuestionDialog.js'
import { SelectList } from './components/SelectList.js'
import { Spinner } from './components/Spinner.js'
import { StatusFooter } from './components/StatusFooter.js'
import { enterAltScreen, installCleanup } from './altscreen.js'
import { page, applyFollow, nextStuck, scrollInfo } from './scroll.js'

const CURSOR_PARK_OFF = process.env.DEEPCODE_NO_CURSOR_PARK === '1'

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

export function FullscreenApp(props: {
  client: any
  yolo: boolean
  cwd: string
  continueSession?: boolean
  sessionDir?: string
}) {
  const { exit } = useApp()
  const { stdout } = useStdout()
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
  const justPickedRef = useRef<string | null>(null)
  const [valueOverride, setValueOverride] = useState<{ text: string; nonce: number } | undefined>(undefined)

  // —— 滚动状态 ——
  const [scrollOffset, setScrollOffset] = useState(0)
  const scrollRef = useRef(0)
  const stuckRef = useRef(true)
  const [, setTick] = useState(0)
  const viewportRef = useRef(10)
  const totalRef = useRef(0)
  const [info, setInfo] = useState(() => scrollInfo(0, 10, 0))
  const setOffset = (n: number) => { scrollRef.current = n; setScrollOffset(n) }
  const recomputeInfo = () => setInfo(scrollInfo(scrollRef.current, viewportRef.current, totalRef.current))

  const onMeasure = useCallback((vh: number, th: number) => {
    let changed = false
    if (vh !== viewportRef.current) { viewportRef.current = vh; changed = true }
    if (th !== totalRef.current) { totalRef.current = th; changed = true }
    if (changed) {
      const ms = Math.max(0, totalRef.current - viewportRef.current)
      const next = applyFollow(scrollRef.current, ms, stuckRef.current)
      if (next !== scrollRef.current) setOffset(next)
      recomputeInfo()
    }
  }, [])

  useEffect(() => {
    if (state.pendingAsk || state.pendingQuestion || resumeMode) {
      setDraft(''); setValueOverride(undefined); justPickedRef.current = null
    }
  }, [!!state.pendingAsk, !!state.pendingQuestion, resumeMode])  // eslint-disable-line react-hooks/exhaustive-deps

  useInput((input, key) => {
    const ms = Math.max(0, totalRef.current - viewportRef.current)
    if (key.pageUp) { stuckRef.current = false; setOffset(page(scrollRef.current, 'up', viewportRef.current, ms)); recomputeInfo(); setTick(x => x + 1); return }
    if (key.pageDown) { const n = page(scrollRef.current, 'down', viewportRef.current, ms); stuckRef.current = nextStuck(n, ms); setOffset(n); recomputeInfo(); setTick(x => x + 1); return }
    if (key.ctrl && input === 'g') { stuckRef.current = true; setOffset(ms); recomputeInfo(); setTick(x => x + 1); return }
    if (key.ctrl && input === 'c') {
      const now = Date.now()
      if (now - lastSigint < 2000) exit()
      else setLastSigint(now)
    }
  })

  useEffect(() => {
    if (!stdout?.isTTY) return
    const leave = enterAltScreen(s => { stdout.write(s) })
    const dispose = installCleanup(leave)
    return () => { dispose(); leave() }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const handleDraftChange = (v: string) => {
    setDraft(v)
    if (justPickedRef.current !== null && v !== justPickedRef.current) justPickedRef.current = null
  }

  const suggestions = useMemo(() => {
    if (justPickedRef.current !== null && draft === justPickedRef.current) return []
    return computeSuggestions(draft, { cwd: props.cwd, customCommands: core.customCommands })
  }, [draft])  // eslint-disable-line react-hooks/exhaustive-deps

  const handlePick = (v: string) => {
    let newDraft: string
    if (v.startsWith('@')) newDraft = draft.replace(/@[\w./-]*$/, v)
    else newDraft = v
    justPickedRef.current = newDraft
    setDraft(newDraft)
    setValueOverride(prev => ({ text: newDraft, nonce: (prev?.nonce ?? 0) + 1 }))
  }

  const submit = (text: string) => {
    if (text === '/exit') { exit(); return }
    if (text === '/resume') { setResumeMode(true); return }
    setDraft(''); setValueOverride(undefined); justPickedRef.current = null
    void core.send(text)
  }

  const historyItems = state.transcript
    .filter(i => i.kind === 'user')
    .map(i => (i as { kind: 'user'; text: string }).text)

  const suggestionsActive = suggestions.length > 0

  const cwdBase = useMemo(() => path.basename(props.cwd), [])  // eslint-disable-line react-hooks/exhaustive-deps
  const branch = useMemo(() => {
    try {
      return execSync('git branch --show-current', { cwd: props.cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null
    } catch { return null }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  const memoryCount = useMemo(() => findMemoryFiles(props.cwd).length, [])  // eslint-disable-line react-hooks/exhaustive-deps
  const modeLabel = (state.permMode === 'acceptEdits' ? 'accept' : state.permMode === 'yolo' ? 'yolo' : 'default')
    + (state.thinking ? '·think' : '')
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

  const inputActive = !state.pendingAsk && !state.pendingQuestion && !resumeMode && !state.busy
  const parkRef = useRef<{ active: boolean }>({ active: false })

  useEffect(() => {
    if (!stdout?.isTTY || CURSOR_PARK_OFF) return
    const out = stdout as NodeJS.WriteStream & { __origWrite?: typeof stdout.write }
    const orig = out.write.bind(out)
    out.__origWrite = orig
    out.write = ((chunk: any, ...rest: any[]) => {
      if (parkRef.current.active) {
        parkRef.current.active = false
        const rows = stdout.rows ?? 24
        orig(`\x1b[${rows};1H`)
      }
      return (orig as any)(chunk, ...rest)
    }) as typeof out.write
    return () => { out.write = orig; delete out.__origWrite }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const linesBelowCaret = 4 + (memoryCount > 0 ? 1 : 0) + (toolCounts.length > 0 ? 1 : 0)
  useEffect(() => {
    if (!inputActive || !stdout?.isTTY || CURSOR_PARK_OFF) return
    const out = stdout as NodeJS.WriteStream & { __origWrite?: typeof stdout.write }
    const orig = out.__origWrite ?? out.write.bind(out)
    const rows = stdout.rows ?? 24
    const caretRow = Math.max(1, rows - linesBelowCaret)
    const col = parkCol(draft, stdout.columns ?? 80, dispWidth)
    const id = setTimeout(() => {
      try {
        ;(orig as any)(`\x1b[?25h\x1b[${caretRow};${col}H`)
        parkRef.current.active = true
      } catch { /* 忽略写入失败 */ }
    }, 0)
    return () => clearTimeout(id)
  })

  const rows = stdout?.rows ?? 24

  return (
    <Box flexDirection="column" height={rows}>
      <ScrollView
        items={state.transcript}
        scrollOffset={scrollOffset}
        onMeasure={onMeasure}
        banner={<Banner cwd={props.cwd} model={state.model} />}
      />
      <Text dimColor>
        {(info.moreAbove || info.moreBelow)
          ? `${info.moreAbove ? '▲ 上有更多' : '▲ 已到顶'} · ${info.moreBelow ? '▼ 下有更多' : '▼ 已到底'} · 行 ${info.top}–${info.bottom}/${info.total}${stuckRef.current ? ' · 跟随' : ''}`
          : ' '}
      </Text>
      {state.pendingQuestion
        ? <QuestionDialog questions={state.pendingQuestion.questions} onDone={a => core.resolveQuestion(a)} />
        : state.pendingAsk
        ? <PermissionDialog ask={state.pendingAsk} onDecide={d => core.resolveAsk(d)} />
        : resumeMode
          ? <SelectList
              items={core.resumeList().map(s => s.preview)}
              onPick={i => { core.resume(core.resumeList()[i].file); setResumeMode(false) }}
              onCancel={() => setResumeMode(false)}
            />
          : <>
              {state.busy && <Spinner turnStartAt={state.turnStartAt} turnOutTokens={state.turnOutTokens} />}
              {suggestionsActive && <Suggestions items={suggestions} onPick={handlePick} />}
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
