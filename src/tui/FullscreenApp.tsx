// src/tui/FullscreenApp.tsx
// 全屏可滚变体（M8 P1）：alt-screen 全屏 + 键盘滚动（PageUp/PageDown/Ctrl+G）+ auto-follow。
// 复用 App 的全部接线，仅把转录渲染换成 ScrollView，并加滚动状态 + alt-screen 生命周期 +
// 绝对定位 IME 光标停泊。useChat 会话核心零改动。内联模式仍走 App。
import React, { useMemo, useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { Box, Text, measureElement, useApp, useInput, useStdout, type DOMElement } from 'ink'
import { createChatCore, useChat } from './useChat.js'
import { findMemoryFiles } from '../prompt.js'
import { computeSuggestions } from './suggest.js'
import { parkCol, parkRowOffset } from './caret.js'
import { Banner } from './components/Banner.js'
import { ScrollView } from './ScrollView.js'
import { InputBox } from './components/InputBox.js'
import { Suggestions } from './components/Suggestions.js'
import { PermissionDialog } from './components/PermissionDialog.js'
import { PlanApprovalDialog } from './components/PlanApprovalDialog.js'
import { QuestionDialog } from './components/QuestionDialog.js'
import { SelectList } from './components/SelectList.js'
import { Spinner } from './components/Spinner.js'
import { StatusFooter } from './components/StatusFooter.js'
import { clamp, page, applyFollow, nextStuck, scrollInfo } from './scroll.js'
import { onWheel } from './wheel.js'
import { useThemeControl, themeNames, BLOCK_GAP, GUTTER } from './theme.js'
import { loadRawUserSettings, saveRawUserSettings } from '../config.js'

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
  flagSettingsPath?: string
}) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const core = useMemo(() => createChatCore({
    client: props.client,
    yolo: props.yolo,
    cwd: props.cwd,
    continueSession: props.continueSession,
    sessionDir: props.sessionDir,
    flagSettingsPath: props.flagSettingsPath,
    onState: () => {},
  }), [])  // eslint-disable-line react-hooks/exhaustive-deps
  const state = useChat(core)
  const [draft, setDraft] = useState('')
  const [resumeMode, setResumeMode] = useState(false)
  const [modelPickerMode, setModelPickerMode] = useState(false)
  const [outputStyleMode, setOutputStyleMode] = useState(false)
  const [themeMode, setThemeMode] = useState(false)
  const { themeName, setThemeName } = useThemeControl()
  const [lastSigint, setLastSigint] = useState(0)
  const justPickedRef = useRef<string | null>(null)
  const [valueOverride, setValueOverride] = useState<{ text: string; nonce: number } | undefined>(undefined)

  // —— 滚动状态 ——
  // ScrollView 高 = min(内容高 totalH, 可用高 availableH=rows-bottomH)：内容矮则输入框紧跟其下，
  // 内容超屏才钉满可用高并裁剪滚动。viewportRef=availableH（翻页/跟随用），frameHRef=实际渲染总高（un-park 用）。
  const [scrollOffset, setScrollOffset] = useState(0)
  const scrollRef = useRef(0)
  const stuckRef = useRef(true)
  const [, setTick] = useState(0)
  const viewportRef = useRef(10)
  const totalRef = useRef(0)
  const [totalH, setTotalH] = useState(0)
  const [bottomH, setBottomH] = useState(8)
  const bottomRef = useRef<DOMElement | null>(null)
  const frameHRef = useRef(24)
  const [info, setInfo] = useState(() => scrollInfo(0, 10, 0))
  const setOffset = (n: number) => { scrollRef.current = n; setScrollOffset(n) }

  // ScrollView 量内层内容高 → 上报（父据此算 height/maxScroll）
  const onMeasureTotal = useCallback((th: number) => {
    if (th !== totalRef.current) { totalRef.current = th; setTotalH(th) }
  }, [])

  useEffect(() => {
    if (state.pendingAsk || state.pendingQuestion || state.pendingPlanApproval || resumeMode || modelPickerMode || outputStyleMode || themeMode) {
      setDraft(''); setValueOverride(undefined); justPickedRef.current = null
    }
  }, [!!state.pendingAsk, !!state.pendingQuestion, !!state.pendingPlanApproval, resumeMode, modelPickerMode, outputStyleMode, themeMode])  // eslint-disable-line react-hooks/exhaustive-deps

  useInput((input, key) => {
    const ms = Math.max(0, totalRef.current - viewportRef.current)
    // 改 offset/stuck 后靠 setTick 触发重渲，info/跟随由下方 reconcile effect 统一重算
    if (key.pageUp) { stuckRef.current = false; setOffset(page(scrollRef.current, 'up', viewportRef.current, ms)); setTick(x => x + 1); return }
    if (key.pageDown) { const n = page(scrollRef.current, 'down', viewportRef.current, ms); stuckRef.current = nextStuck(n, ms); setOffset(n); setTick(x => x + 1); return }
    if (key.ctrl && input === 'g') { stuckRef.current = true; setOffset(ms); setTick(x => x + 1); return }
    if (key.ctrl && input === 'c') {
      const now = Date.now()
      if (now - lastSigint < 2000) exit()
      else setLastSigint(now)
    }
    // Shift+Tab 循环权限模式（default→acceptEdits→plan→default）。
    if (key.shift && key.tab && !state.busy && !state.pendingAsk && !state.pendingPlanApproval && !state.pendingQuestion && !resumeMode && !modelPickerMode && !outputStyleMode && !themeMode) {
      void core.send('/cycle-mode')
    }
  })

  // 鼠标/触控板滚轮（P2）：上滚 = stuck=false + 上移；下滚 = 下移 + 到底重新跟随。每 notch 3 行。
  useEffect(() => onWheel(dir => {
    const ms = Math.max(0, totalRef.current - viewportRef.current)
    if (dir === 'up') { stuckRef.current = false; setOffset(clamp(scrollRef.current - 3, ms)) }
    else { const n = clamp(scrollRef.current + 3, ms); stuckRef.current = nextStuck(n, ms); setOffset(n) }
    setTick(x => x + 1)
  }), [])  // eslint-disable-line react-hooks/exhaustive-deps

  // alt-screen 生命周期由 startTui 在 render() 之前同步进入/退出——必须在 ink 首帧之前，
  // 否则 ink 先画到主屏、effect 再切 alt-screen 清屏归位，会与 ink log-update 的"光标在上帧底部"
  // 假设冲突导致整屏错位（banner 被顶出视口）。这里不再于 effect 内进 alt-screen。

  const handleDraftChange = (v: string) => {
    setDraft(v)
    if (justPickedRef.current !== null && v !== justPickedRef.current) justPickedRef.current = null
  }

  const suggestions = useMemo(() => {
    if (justPickedRef.current !== null && draft === justPickedRef.current) return []
    return computeSuggestions(draft, { cwd: props.cwd, customCommands: core.customCommands, skills: core.skills })
  }, [draft])  // eslint-disable-line react-hooks/exhaustive-deps

  const handlePick = (v: string) => {
    let newDraft: string
    if (v.startsWith('@')) newDraft = draft.replace(/@[\w./-]*$/, v)
    else newDraft = v
    justPickedRef.current = newDraft
    setDraft(newDraft)
    setValueOverride(prev => ({ text: newDraft, nonce: (prev?.nonce ?? 0) + 1 }))
  }

  const submit = (text: string, attachments?: import('./pasteFold.js').Attachment[]) => {
    if (text === '/exit') { exit(); return }
    if (text === '/resume') { setResumeMode(true); return }
    if (text === '/model') { setModelPickerMode(true); return }
    if (text === '/output-style') { setOutputStyleMode(true); return }
    if (text === '/theme') { setThemeMode(true); return }
    setDraft(''); setValueOverride(undefined); justPickedRef.current = null
    void core.send(text, attachments as import('./pasteFold.js').TextEntry[] | undefined)
  }

  const historyItems = state.transcript
    .filter(i => i.kind === 'user')
    .map(i => (i as { kind: 'user'; text: string }).text)

  const suggestionsActive = suggestions.length > 0

  const liveCwd = core.getCwd()
  const cwdBase = path.basename(liveCwd)
  const branch = useMemo(() => {
    try {
      return execSync('git branch --show-current', { cwd: liveCwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null
    } catch { return null }
  }, [liveCwd])
  const memoryCount = useMemo(() => findMemoryFiles(props.cwd).length, [])  // eslint-disable-line react-hooks/exhaustive-deps
  const modeLabel = (state.permMode === 'acceptEdits' ? 'accept' : state.permMode === 'yolo' ? 'yolo' : state.permMode === 'plan' ? 'plan' : 'default')
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

  const inputActive = !state.pendingAsk && !state.pendingQuestion && !state.pendingPlanApproval && !resumeMode && !modelPickerMode && !outputStyleMode && !themeMode && !state.busy

  // —— 全屏几何（每帧算）——
  const rows = stdout?.rows ?? 24
  const availableH = Math.max(1, rows - bottomH)
  viewportRef.current = availableH
  // 内容矮 → 只占内容高（输入框紧跟）；内容超屏 → 钉满可用高裁剪。
  // totalH 未知(0)时先给满高：否则 0 高容器把内层也量成 0 → totalH 永卡 0 的死锁（banner 不显示）。
  const scrollH = totalH > 0 ? Math.min(totalH, availableH) : availableH
  const frameH = Math.min(scrollH + bottomH, rows) // 实际渲染总高（un-park 用：ink 把光标留在此底部）
  frameHRef.current = frameH
  const aboveInput = suggestionsActive ? suggestions.length : 0
  // 输入框光标行（1-based 从顶算）：ScrollView(scrollH) + bottomRef 顶 marginTop 空行(BLOCK_GAP，栅格化加)
  // + 提示行(1) + 上方 suggestions + 输入框上边线(1) + 光标内容行(1)。
  // 末项加 parkRowOffset：value 折行时光标落到末视觉行（否则停在折行首行）。±1 由 pty 微调
  const caretRow = Math.max(1, scrollH + BLOCK_GAP + 1 + aboveInput + 2 + parkRowOffset(draft, (stdout?.columns ?? 80) - 2 * GUTTER, dispWidth))

  // 停泊状态：active=已泊待解；row/col=最新停泊目标；enabled=输入框激活可泊；id=重停泊去抖句柄。
  const parkRef = useRef<{ active: boolean; row: number; col: number; enabled: boolean; id?: ReturnType<typeof setTimeout> }>({ active: false, row: 1, col: 1, enabled: false })

  // 量底部区域高（提示行+输入框/弹窗+页脚）→ 算可用高 → 应用 auto-follow + 位置提示。每帧跑，稳定后幂等不再 setState。
  useLayoutEffect(() => {
    try {
      const h = bottomRef.current ? measureElement(bottomRef.current).height : 0
      // 拒绝物理不可能的瞬态毛刺：底部区高 ≥ 屏高时 measureElement 偶发返回越界值（实测 80 on rows=55），
      // 会致 availableH=1 → scrollH=1 → caretRow 塌进 banner（光标错位）。≥ 屏高一律忽略，保留上次有效值。
      if (h > 0 && h < (stdout?.rows ?? 24) && h !== bottomH) setBottomH(h)
    } catch { /* ignore */ }
    const avail = Math.max(1, (stdout?.rows ?? 24) - bottomH)
    viewportRef.current = avail
    const ms = Math.max(0, totalRef.current - avail)
    const next = applyFollow(scrollRef.current, ms, stuckRef.current)
    if (next !== scrollRef.current) setOffset(next)
    const ni = scrollInfo(next, avail, totalRef.current)
    setInfo(prev => (prev.moreAbove === ni.moreAbove && prev.moreBelow === ni.moreBelow
      && prev.top === ni.top && prev.bottom === ni.bottom && prev.total === ni.total) ? prev : ni)
  })

  // IME 光标停泊：写帧前把光标移回内容底部（frameH，ink log-update 假设光标在上帧底部），停泊用绝对 CUP 到 caretRow。
  useEffect(() => {
    if (!stdout?.isTTY || CURSOR_PARK_OFF) return
    const out = stdout as NodeJS.WriteStream & { __origWrite?: typeof stdout.write }
    const orig = out.write.bind(out)
    out.__origWrite = orig
    out.write = ((chunk: any, ...rest: any[]) => {
      if (parkRef.current.active) {
        parkRef.current.active = false
        orig(`\x1b[${frameHRef.current};1H`)  // 移回实际渲染底部，让 ink eraseLines 从正确处起
      }
      const r = (orig as any)(chunk, ...rest)
      // ink 写完后补一次重停泊（去抖）：否则 ink 收尾把光标留在全屏底部，一次性 setTimeout 停泊会输掉竞争。
      if (parkRef.current.enabled) {
        clearTimeout(parkRef.current.id)
        parkRef.current.id = setTimeout(() => {
          try { orig(`\x1b[?25h\x1b[${parkRef.current.row};${parkRef.current.col}H`); parkRef.current.active = true } catch { /* 忽略 */ }
        }, 0)
      }
      return r
    }) as typeof out.write
    return () => { out.write = orig; delete out.__origWrite }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    parkRef.current.enabled = !!inputActive && !!stdout?.isTTY && !CURSOR_PARK_OFF
    if (!parkRef.current.enabled) return
    const out = stdout as NodeJS.WriteStream & { __origWrite?: typeof stdout.write }
    const orig = out.__origWrite ?? out.write.bind(out)
    const col = parkCol(draft, (stdout.columns ?? 80) - 2 * GUTTER, dispWidth)
    // 记录最新停泊目标，供 write-wrapper 在 ink 每次写完后补停泊（赢得与 ink 收尾的竞争）。
    parkRef.current.row = caretRow
    parkRef.current.col = col + GUTTER
    const id = setTimeout(() => {
      try {
        ;(orig as any)(`\x1b[?25h\x1b[${caretRow};${col + GUTTER}H`)
        parkRef.current.active = true
      } catch { /* 忽略写入失败 */ }
    }, 0)
    return () => clearTimeout(id)
  })

  return (
    <Box flexDirection="column" height={rows} paddingX={GUTTER}>
      <ScrollView
        items={state.transcript}
        scrollOffset={scrollOffset}
        height={scrollH}
        onMeasureTotal={onMeasureTotal}
        banner={<Banner cwd={props.cwd} model={state.model} />}
      />
      <Box ref={bottomRef} flexDirection="column" flexShrink={0} marginTop={BLOCK_GAP}>
        <Text dimColor>
          {(info.moreAbove || info.moreBelow)
            ? `${info.moreAbove ? '▲ 上有更多' : '▲ 已到顶'} · ${info.moreBelow ? '▼ 下有更多' : '▼ 已到底'} · 行 ${info.top}–${info.bottom}/${info.total}${stuckRef.current ? ' · 跟随' : ''}`
            : ' '}
        </Text>
        {state.pendingQuestion
          ? <QuestionDialog questions={state.pendingQuestion.questions} onDone={a => core.resolveQuestion(a)} />
          : state.pendingAsk
          ? <PermissionDialog ask={state.pendingAsk} onDecide={d => core.resolveAsk(d)} />
          : state.pendingPlanApproval
          ? <PlanApprovalDialog pending={state.pendingPlanApproval} onDecide={approved => core.resolvePlanApproval(approved)} />
          : resumeMode
            ? <SelectList
                items={core.resumeList().map(s => s.preview)}
                onPick={i => { core.resume(core.resumeList()[i].file); setResumeMode(false) }}
                onCancel={() => setResumeMode(false)}
              />
            : modelPickerMode
            ? <SelectList
                items={core.modelList().map(m => m.label)}
                onPick={i => { core.applyModel(core.modelList()[i].id); setModelPickerMode(false) }}
                onCancel={() => setModelPickerMode(false)}
              />
            : outputStyleMode
            ? <SelectList
                items={core.outputStyleList().map(s => `${s.name}${s.description ? ' — ' + s.description : ''}`)}
                onPick={i => { core.applyOutputStyle(core.outputStyleList()[i].name); setOutputStyleMode(false) }}
                onCancel={() => setOutputStyleMode(false)}
              />
            : themeMode
            ? <SelectList
                items={themeNames().map(n => (n === themeName ? '● ' : '  ') + n)}
                onPick={i => {
                  const name = themeNames()[i]
                  setThemeName(name)
                  try { const raw = loadRawUserSettings(); raw.theme = name; saveRawUserSettings(raw) } catch { /* 持久化失败不阻断热切 */ }
                  setThemeMode(false)
                }}
                onCancel={() => setThemeMode(false)}
              />
            : <>
                {state.busy && <Spinner turnStartAt={state.turnStartAt} turnOutTokens={state.turnOutTokens} hookLabel={state.hookProgress} tip={state.spinnerTip} />}
                {suggestionsActive && <Suggestions items={suggestions} onPick={handlePick} />}
                <InputBox
                  onSubmit={submit}
                  onInterrupt={() => core.interrupt()}
                  onChange={handleDraftChange}
                  suggestionsActive={suggestionsActive}
                  history={historyItems}
                  busy={state.busy}
                  valueOverride={valueOverride}
                  onSteer={(t, a) => core.steer(t, a as import('./pasteFold.js').TextEntry[] | undefined)}
                  onSteerPop={() => { const v = core.steerPop(); if (v !== undefined) setValueOverride(prev => ({ text: v, nonce: (prev?.nonce ?? 0) + 1 })) }}
                  steerQueueSize={core.steerQueue().length}
                  steerQueueItems={core.steerQueue()}
                />
              </>
        }
        <StatusFooter
          model={state.model}
          mode={modeLabel}
          cwdBase={cwdBase}
          branch={branch}
          memoryCount={memoryCount}
          contextUsed={state.contextUsed()}
          contextWindow={state.contextWindow()}
          cost={state.sessionCost()}
          hitRate={state.cacheHitRate()}
          cacheSavings={state.cacheSavings()}
          tokenBudget={state.tokenBudget()}
          budgetUsed={state.budgetUsed()}
          thinking={state.thinking}
          effortLevel={state.effortLevel}
          toolCounts={toolCounts}
          statusLineOutput={state.statusLineOutput}
        />
      </Box>
    </Box>
  )
}
