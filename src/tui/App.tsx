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
import { parkCol } from './caret.js'
import { Banner } from './components/Banner.js'
import { Transcript } from './components/Transcript.js'
import { InputBox } from './components/InputBox.js'
import { Suggestions } from './components/Suggestions.js'
import { PermissionDialog } from './components/PermissionDialog.js'
import { QuestionDialog } from './components/QuestionDialog.js'
import { SelectList } from './components/SelectList.js'
import { Spinner } from './components/Spinner.js'
import { StatusFooter } from './components/StatusFooter.js'

// CJK/全角字符按 2 列宽计（终端等宽规则）；用于算输入框插入点的列号。
// 逃生开关：设 DEEPCODE_NO_CURSOR_PARK=1 完全禁用 IME 光标停泊（退回原版 ink 行为）。
// 用于排查 Ghostty 等终端下的滚动/重绘问题——停泊每帧改写硬件光标，是最可能干扰滚动的非标准动作。
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

export function App(props: {
  client: any
  yolo: boolean
  cwd: string
  continueSession?: boolean
  sessionDir?: string  // 测试注入：隔离 session 落盘目录
  flagSettingsPath?: string
}) {
  const { exit } = useApp()
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
  const [rewindStep, setRewindStep] = useState<'point' | 'mode' | null>(null)
  const [rewindTurn, setRewindTurn] = useState<number | null>(null)
  const [lastSigint, setLastSigint] = useState(0)
  // 补全菜单隐藏：onPick 后记录刚选中的值，若 draft 恰好等于该值则不显示菜单
  const justPickedRef = useRef<string | null>(null)
  // InputBox value 注入：通过 nonce 强制 InputBox 接受新值
  const [valueOverride, setValueOverride] = useState<{ text: string; nonce: number } | undefined>(undefined)

  // pendingAsk / resumeMode / rewindStep 激活时清除 draft 和 valueOverride，防止 InputBox 卸载后 remount 时老值复活
  useEffect(() => {
    if (state.pendingAsk || state.pendingQuestion || resumeMode || rewindStep) {
      setDraft('')
      setValueOverride(undefined)
      justPickedRef.current = null
    }
  }, [!!state.pendingAsk, !!state.pendingQuestion, resumeMode, rewindStep])  // eslint-disable-line react-hooks/exhaustive-deps

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
      return computeSuggestions(draft, { cwd: props.cwd, customCommands: core.customCommands, skills: core.skills })
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
    if (text === '/rewind') { setRewindStep('point'); return }
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

  // —— IME 光标停泊（仅真 TTY）——
  // 病因：原版 ink 全程藏光标、把它留在输出末尾，中文输入法在硬件光标处画组字预编辑，
  // 于是字"跳"到最底部而非输入框内。直接发转义码把光标移进框会和 ink 的重绘冲突：
  // log-update 用 `eraseLines(上一帧行数)+新内容` 重绘，**假设光标停在上一帧底部**往上擦；
  // 光标被我移到框中间后，下一帧就从错误行开始擦 → 页脚重画错乱。
  // 协作解法：包装 stdout.write——ink 每次写帧前，若光标处于停泊态，先把它移回底部（下移
  // 同样行数），让 eraseLines 从正确位置开始；写完帧后再把光标停回插入点。两者不再对抗。
  const parkRef = useRef<{ active: boolean; up: number }>({ active: false, up: 0 })
  const inputActive = !state.pendingAsk && !state.pendingQuestion && !resumeMode && !rewindStep && !state.busy

  // 安装一次：包装 process.stdout.write，写帧前自动解除停泊（移回底部）
  // 诊断/逃生：DEEPCODE_NO_CURSOR_PARK=1 关掉整套光标停泊（退回原版 ink）——用于排查滚动/重绘问题。
  useEffect(() => {
    if (!process.stdout.isTTY || CURSOR_PARK_OFF) return
    const out = process.stdout as NodeJS.WriteStream & { __origWrite?: typeof process.stdout.write }
    const orig = out.write.bind(out)
    out.__origWrite = orig
    out.write = ((chunk: any, ...rest: any[]) => {
      const p = parkRef.current
      if (p.active) {
        p.active = false
        orig(`\x1b[${p.up}B`)  // 下移 up 行回到 ink 期望的底部；列无所谓，eraseLines 会重置
      }
      return (orig as any)(chunk, ...rest)
    }) as typeof out.write
    return () => { out.write = orig; delete out.__origWrite }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // 每帧渲染后把硬件光标停到输入框插入点（用原始 write 绕过上面的解除逻辑）。
  // 上移行数 = 底边线(1) + 页脚行数 + ink 末尾换行(1)；页脚 = 行1/行2/提示(3 固定) + 记忆行 + 工具行。
  // 故 = 5 + 记忆行(0/1) + 工具行(0/1)。页脚行数随内容变 → 必须动态算，否则光标偏。
  const linesBelowCaret = 5 + (memoryCount > 0 ? 1 : 0) + (toolCounts.length > 0 ? 1 : 0)
  useEffect(() => {
    if (!inputActive || !process.stdout.isTTY || CURSOR_PARK_OFF) return
    const out = process.stdout as NodeJS.WriteStream & { __origWrite?: typeof process.stdout.write }
    const orig = out.__origWrite ?? out.write.bind(out)
    const col = parkCol(draft, process.stdout.columns ?? 80, dispWidth)  // 折行/含换行时落到末行真实列，防超宽被钳
    const id = setTimeout(() => {
      try {
        ;(orig as any)(`\x1b[?25h\x1b[${linesBelowCaret}A\x1b[${col}G`)
        parkRef.current = { active: true, up: linesBelowCaret }
      } catch { /* 忽略写入失败 */ }
    }, 0)
    return () => clearTimeout(id)
  })

  return (
    <Box flexDirection="column">
      {/* 欢迎框交给 Transcript 作为 Static 首项：开机出现、随对话滚入历史留存，不消失也不反复重画（仿 CC） */}
      <Transcript items={state.transcript} banner={<Banner cwd={props.cwd} model={state.model} />} />
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
          : rewindStep === 'point'
          ? (() => {
              const pts = core.rewindList()
              if (pts.length === 0) {
                return <SelectList items={['暂无可回退的轮次（按 Esc 返回）']} onPick={() => setRewindStep(null)} onCancel={() => setRewindStep(null)} />
              }
              return <SelectList
                items={pts.map(p => `第 ${p.turnId} 轮：${p.preview}${p.fileCount ? `（${p.fileCount} 文件改动）` : ''}`)}
                onPick={i => { setRewindTurn(pts[i].turnId); setRewindStep('mode') }}
                onCancel={() => setRewindStep(null)}
              />
            })()
          : rewindStep === 'mode'
          ? <SelectList
              items={['仅对话（截断历史，文件不动）', '仅代码（还原文件，对话不动）', '两者']}
              onPick={i => {
                const mode = (['conversation', 'code', 'both'] as const)[i]
                if (rewindTurn !== null) core.rewind(rewindTurn, mode)
                setRewindStep(null); setRewindTurn(null)
              }}
              onCancel={() => { setRewindStep(null); setRewindTurn(null) }}
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
                onSteerNext={(t) => core.steerNext(t)}
                onSteerNow={(t) => core.steerNow(t)}
                onSteerPop={() => { const v = core.steerPop(); if (v !== undefined) setValueOverride(prev => ({ text: v, nonce: (prev?.nonce ?? 0) + 1 })) }}
                steerQueueSize={core.steerQueue().length}
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
      />
    </Box>
  )
}
