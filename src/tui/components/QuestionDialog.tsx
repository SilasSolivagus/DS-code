// src/tui/components/QuestionDialog.tsx
// AskUserQuestion 弹窗 v2（对齐 CC）：顶部 tab 导航条（Tab/方向键回上一题重选、选择保留），
// 单选选中即进下一题，多选空格勾选+「下一步/提交」确认按钮，末尾提交复核页（列全部答案+提交/取消）。
// 单个单选题省略复核页、选完即结束（hideSubmitTab）。去掉 note（对齐 CC）。Esc 取消。
// ink 同步连键安全：qi/cursor/drafts/mode/buf/submitCur 全配 ref——updateX 原子更新 ref+state，
// handler 读 ref，render 读 state/tick。
import React, { useState, useRef } from 'react'
import { Box, Text, useInput } from 'ink'
import { useTheme } from '../theme.js'
import { renderMarkdown } from '../markdown.js'
import type { Question, Answer } from '../../tools/askUserQuestion.js'

const OTHER = '其他（自由输入）'

type Draft = { picks: Set<number>; freeText?: string }

export function QuestionDialog(props: {
  questions: Question[]
  onDone: (answers: Answer[] | null) => void
}) {
  const T = useTheme()
  const { questions, onDone } = props
  const N = questions.length
  const hideSubmitTab = N === 1 && !questions[0].multiSelect
  const submitIndex = N
  const lastQi = hideSubmitTab ? N - 1 : N

  const [qi, setQi] = useState(0)
  const qiRef = useRef(0)
  const [cursor, setCursor] = useState(0)
  const cursorRef = useRef(0)
  const draftsRef = useRef<Draft[]>(questions.map(() => ({ picks: new Set<number>() })))
  const [, setTick] = useState(0)
  const rerender = () => setTick(x => x + 1)
  const [mode, setMode] = useState<'select' | 'other'>('select')
  const modeRef = useRef<'select' | 'other'>('select')
  const [buf, setBuf] = useState('')
  const bufRef = useRef('')
  const [submitCur, setSubmitCur] = useState(0)
  const submitCurRef = useRef(0)

  const updateQi = (n: number) => { qiRef.current = n; setQi(n) }
  const updateCursor = (n: number) => { cursorRef.current = n; setCursor(n) }
  const updateMode = (m: 'select' | 'other') => { modeRef.current = m; setMode(m) }
  const updateBuf = (s: string) => { bufRef.current = s; setBuf(s) }
  const updateSubmitCur = (n: number) => { submitCurRef.current = n; setSubmitCur(n) }

  const otherRow = (q: Question) => q.options.length
  const actionRow = (q: Question) => q.options.length + 1
  const rowsFor = (q: Question) => q.options.length + 1 + (q.multiSelect ? 1 : 0)

  const buildAnswers = (): Answer[] => {
    const out: Answer[] = []
    questions.forEach((q, i) => {
      const d = draftsRef.current[i]
      const selected = [...d.picks].map(j => q.options[j].label)
      if (d.freeText) selected.push(d.freeText)
      if (selected.length === 0) return
      out.push({ header: q.header, question: q.question, selected, freeText: d.freeText })
    })
    return out
  }

  const goTo = (n: number) => {
    updateQi(n)
    updateMode('select'); updateBuf('')
    if (n >= submitIndex) { updateSubmitCur(0); updateCursor(0); return }
    const d = draftsRef.current[n]
    updateCursor(d && d.picks.size ? [...d.picks][0] : 0)
  }

  const advance = () => {
    const next = qiRef.current + 1
    if (hideSubmitTab && next >= submitIndex) { onDone(buildAnswers()); return }
    goTo(Math.min(next, submitIndex))
  }

  const chooseSingle = (optIdx: number) => {
    const d = draftsRef.current[qiRef.current]
    d.picks = new Set([optIdx]); d.freeText = undefined
    advance()
  }

  useInput((input, key) => {
    if (key.escape) { onDone(null); return }
    const curMode = modeRef.current

    if (curMode === 'other') {
      const q = questions[qiRef.current]
      if (key.return) {
        const t = bufRef.current.trim()
        draftsRef.current[qiRef.current].freeText = t || undefined
        if (q.multiSelect) { updateMode('select'); updateBuf(''); rerender() }
        else { updateMode('select'); advance() }
        return
      }
      if (key.backspace || key.delete) { updateBuf(bufRef.current.slice(0, -1)); return }
      if (!key.ctrl && !key.meta && input) {
        const clean = input.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '')
        if (clean) updateBuf(bufRef.current + clean)
      }
      return
    }

    if (key.tab && key.shift) { goTo(Math.max(0, qiRef.current - 1)); return }
    if (key.tab) { goTo(Math.min(lastQi, qiRef.current + 1)); return }
    if (key.leftArrow) { goTo(Math.max(0, qiRef.current - 1)); return }
    if (key.rightArrow) { goTo(Math.min(lastQi, qiRef.current + 1)); return }

    if (qiRef.current >= submitIndex) {
      if (key.upArrow) { updateSubmitCur(0); return }
      if (key.downArrow) { updateSubmitCur(1); return }
      if (key.return) { onDone(submitCurRef.current === 0 ? buildAnswers() : null) }
      return
    }

    const q = questions[qiRef.current]
    const rows = rowsFor(q)
    if (key.upArrow) { updateCursor(Math.max(0, cursorRef.current - 1)); return }
    if (key.downArrow) { updateCursor(Math.min(rows - 1, cursorRef.current + 1)); return }

    const cur = cursorRef.current
    if (q.multiSelect && input === ' ' && cur < q.options.length) {
      const d = draftsRef.current[qiRef.current]
      const n = new Set(d.picks); n.has(cur) ? n.delete(cur) : n.add(cur)
      d.picks = n; rerender(); return
    }
    if (/^[1-9]$/.test(input)) {
      const sel = Number(input) - 1
      if (sel >= q.options.length) return
      if (q.multiSelect) {
        const d = draftsRef.current[qiRef.current]
        const n = new Set(d.picks); n.has(sel) ? n.delete(sel) : n.add(sel)
        d.picks = n; rerender(); return
      }
      chooseSingle(sel); return
    }
    if (key.return) {
      if (cur === otherRow(q)) { updateMode('other'); updateBuf(draftsRef.current[qiRef.current].freeText ?? ''); return }
      if (q.multiSelect) { if (cur === actionRow(q)) advance(); return }
      chooseSingle(cur)
    }
  })

  const navBar = (
    <Box>
      <Text dimColor>← </Text>
      {questions.map((qq, i) => {
        const active = i === qi
        const d = draftsRef.current[i]
        const answered = d.picks.size > 0 || !!d.freeText
        return (
          <Text key={i} color={active ? T.accent : undefined} dimColor={!active}>
            {` ${answered ? '✓' : ' '}${qq.header} `}
          </Text>
        )
      })}
      {!hideSubmitTab && (
        <Text color={qi >= submitIndex ? T.accent : undefined} dimColor={qi < submitIndex}>{' ✓提交 '}</Text>
      )}
      <Text dimColor> →</Text>
    </Box>
  )

  let body: React.ReactNode
  if (mode === 'other') {
    const q = questions[qi]
    body = (
      <Box flexDirection="column">
        <Text bold color={T.accent}>{q.question}</Text>
        <Text>其他：<Text color={T.accent}>{buf}</Text><Text inverse> </Text></Text>
        <Text dimColor>Enter 确认 · Esc 取消</Text>
      </Box>
    )
  } else if (qi >= submitIndex) {
    const answers = buildAnswers()
    body = (
      <Box flexDirection="column">
        <Text bold color={T.accent}>复核答案</Text>
        {answers.length === 0 && <Text dimColor>（未选择任何答案）</Text>}
        {answers.map((a, i) => (
          <Box key={i} flexDirection="column" marginLeft={1}>
            <Text dimColor>• {a.question}</Text>
            <Text color={T.ok}>{`  → ${a.selected.join('、')}`}</Text>
          </Box>
        ))}
        <Box flexDirection="column" marginTop={1}>
          <Text color={submitCur === 0 ? T.accent : undefined} dimColor={submitCur !== 0}>{submitCur === 0 ? '❯ ' : '  '}提交答案</Text>
          <Text color={submitCur === 1 ? T.accent : undefined} dimColor={submitCur !== 1}>{submitCur === 1 ? '❯ ' : '  '}取消</Text>
        </Box>
        <Text dimColor>↑↓ 选择 · Enter 确认 · ←/Shift+Tab 回上一题 · Esc 取消</Text>
      </Box>
    )
  } else {
    const q = questions[qi]
    const d = draftsRef.current[qi]
    const list = (
      <Box flexDirection="column">
        <Text bold color={T.accent}>{`(${qi + 1}/${N}) ${q.question}`}</Text>
        {q.options.map((o, i) => {
          const focused = i === cursor
          const mark = q.multiSelect ? (d.picks.has(i) ? '[x] ' : '[ ] ') : `${i + 1}. `
          return (
            <Box key={i} flexDirection="column">
              <Text color={focused ? T.accent : undefined} dimColor={!focused}>
                {focused ? '❯ ' : '  '}{mark}{o.label}
              </Text>
              {o.description ? <Text dimColor>{`     ${o.description}`}</Text> : null}
            </Box>
          )
        })}
        <Text color={cursor === otherRow(q) ? T.accent : undefined} dimColor={cursor !== otherRow(q)}>
          {cursor === otherRow(q) ? '❯ ' : '  '}{q.multiSelect ? (d.freeText ? '[x] ' : '[ ] ') : ''}{OTHER}{d.freeText ? `：${d.freeText}` : ''}
        </Text>
        {q.multiSelect && (
          <Text color={cursor === actionRow(q) ? T.accent : undefined} dimColor={cursor !== actionRow(q)}>
            {cursor === actionRow(q) ? '❯ ' : '  '}▶ {qi === N - 1 ? '提交' : '下一步'}
          </Text>
        )}
        <Text dimColor>
          {q.multiSelect
            ? '空格勾选 · Enter 确认按钮 · Tab/方向键 切换 · Esc 取消'
            : '↑↓/数字 选择 · Enter 确认 · Tab/方向键 切换 · Esc 取消'}
        </Text>
      </Box>
    )
    if (q.options.some(o => o.preview)) {
      const focusedOpt = q.options[cursor]
      body = (
        <Box>
          <Box flexDirection="column" width={42}>{list}</Box>
          <Box flexDirection="column" marginLeft={2} borderStyle="round" borderColor={T.dim} paddingX={1}>
            <Text>{focusedOpt?.preview ? renderMarkdown(focusedOpt.preview) : '（此项无预览）'}</Text>
          </Box>
        </Box>
      )
    } else {
      body = list
    }
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={T.accent} paddingX={1}>
      {navBar}
      {body}
    </Box>
  )
}
