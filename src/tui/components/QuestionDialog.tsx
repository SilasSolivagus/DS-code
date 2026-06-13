// src/tui/components/QuestionDialog.tsx
// AskUserQuestion 弹窗：逐题菜单（单选/多选/「其他」自由输入/preview 并排/备注），镜像 PermissionDialog。
// 交互细节（note 键/preview 列宽）对齐 CC 源码 /Users/silas/Desktop/src/tools/AskUserQuestionTool。
import React, { useState, useRef } from 'react'
import { Box, Text, useInput } from 'ink'
import { T } from '../theme.js'
import { renderMarkdown } from '../markdown.js'
import type { Question, Answer } from '../../tools/askUserQuestion.js'

const OTHER = '其他（自由输入）'

export function QuestionDialog(props: {
  questions: Question[]
  onDone: (answers: Answer[] | null) => void
}) {
  const { questions, onDone } = props
  const [qi, setQi] = useState(0)
  const [idx, setIdx] = useState(0)
  const idxRef = useRef(0)  // sync ref so rapid arrow+space reads updated cursor
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const checkedRef = useRef<Set<number>>(new Set())  // sync ref for rapid reads
  const [answers, setAnswers] = useState<Answer[]>([])
  const [mode, setMode] = useState<'select' | 'other' | 'note'>('select')
  const modeRef = useRef<'select' | 'other' | 'note'>('select')
  const [buf, setBuf] = useState('')
  const bufRef = useRef('')
  const [draft, setDraft] = useState<Answer | null>(null)
  const draftRef = useRef<Answer | null>(null)

  const q = questions[qi]
  const opts = [...q.options, { label: OTHER, description: '' }]
  const otherIdx = q.options.length
  const isOther = (i: number) => i === otherIdx

  const updateIdx = (next: number) => { idxRef.current = next; setIdx(next) }
  const updateChecked = (next: Set<number>) => { checkedRef.current = next; setChecked(next) }
  const updateMode = (next: 'select' | 'other' | 'note') => { modeRef.current = next; setMode(next) }
  const updateBuf = (next: string) => { bufRef.current = next; setBuf(next) }
  const updateDraft = (next: Answer | null) => { draftRef.current = next; setDraft(next) }

  // 选完一题 → 暂存草稿，进入备注机会
  const toNote = (selected: string[], freeText?: string) => {
    const d: Answer = { header: q.header, question: q.question, selected, freeText }
    updateDraft(d); updateMode('note'); updateBuf('')
  }
  // 提交答案 → 下一题或结束
  const commit = (ans: Answer) => {
    const next = [...answers, ans]
    if (qi + 1 >= questions.length) { onDone(next); return }
    setAnswers(next); setQi(qi + 1)
    updateIdx(0); updateChecked(new Set()); updateMode('select'); updateBuf(''); updateDraft(null)
  }

  useInput((input, key) => {
    if (key.escape) { onDone(null); return }

    const curMode = modeRef.current

    if (curMode === 'other') {
      if (key.return) { const t = bufRef.current.trim(); toNote([t || '(空)'], t || undefined); return }
      if (key.backspace || key.delete) { updateBuf(bufRef.current.slice(0, -1)); return }
      if (!key.ctrl && !key.meta && input) updateBuf(bufRef.current + input)
      return
    }
    if (curMode === 'note') {
      if (key.return) { commit({ ...draftRef.current!, note: bufRef.current.trim() || undefined }); return }
      if (key.backspace || key.delete) { updateBuf(bufRef.current.slice(0, -1)); return }
      if (!key.ctrl && !key.meta && input) updateBuf(bufRef.current + input)
      return
    }

    // select
    if (key.upArrow) { const next = Math.max(0, idxRef.current - 1); updateIdx(next); return }
    if (key.downArrow) { const next = Math.min(opts.length - 1, idxRef.current + 1); updateIdx(next); return }
    if (q.multiSelect && input === ' ' && !isOther(idxRef.current)) {
      const cur = idxRef.current
      const n = new Set(checkedRef.current)
      n.has(cur) ? n.delete(cur) : n.add(cur)
      updateChecked(n); return
    }
    if (key.return || /^[1-9]$/.test(input)) {
      const sel = /^[1-9]$/.test(input) ? Number(input) - 1 : idxRef.current
      if (sel < 0 || sel >= opts.length) return
      if (isOther(sel)) { updateMode('other'); updateBuf(''); return }
      if (q.multiSelect && key.return) {
        const picks = checkedRef.current.size ? [...checkedRef.current] : [sel]
        toNote(picks.map(i => q.options[i].label)); return
      }
      toNote([opts[sel].label])
    }
  })

  const list = (
    <Box flexDirection="column">
      <Text bold color={T.accent}>{`(${qi + 1}/${questions.length}) ${q.question}`}</Text>
      {opts.map((o, i) => {
        const mark = q.multiSelect && !isOther(i) ? (checked.has(i) ? '[x] ' : '[ ] ') : ''
        const num = !q.multiSelect ? `${i + 1}. ` : ''
        return (
          <Box key={i} flexDirection="column">
            <Text color={i === idx ? T.accent : undefined} dimColor={i !== idx}>
              {i === idx ? '❯ ' : '  '}{num}{mark}{o.label}
            </Text>
            {o.description ? <Text dimColor>{`     ${o.description}`}</Text> : null}
          </Box>
        )
      })}
      <Text dimColor>{q.multiSelect ? '空格勾选 · Enter 提交 · Esc 取消' : '↑↓/数字 选择 · Enter 确认 · Esc 取消'}</Text>
    </Box>
  )

  let body: React.ReactNode = list
  if (mode === 'other') {
    body = (
      <Box flexDirection="column">
        <Text bold color={T.accent}>{q.question}</Text>
        <Text>其他：<Text color={T.accent}>{buf}</Text><Text inverse> </Text></Text>
        <Text dimColor>Enter 提交 · Esc 取消</Text>
      </Box>
    )
  } else if (mode === 'note') {
    body = (
      <Box flexDirection="column">
        <Text>已选：{draft?.selected.join('、')}</Text>
        <Text>备注（可空）：<Text color={T.accent}>{buf}</Text><Text inverse> </Text></Text>
        <Text dimColor>Enter 确认/下一题 · Esc 取消</Text>
      </Box>
    )
  } else if (q.options.some(o => o.preview)) {
    const focused = q.options[idx]
    body = (
      <Box>
        <Box flexDirection="column" width={42}>{list}</Box>
        <Box flexDirection="column" marginLeft={2} borderStyle="round" borderColor={T.dim} paddingX={1}>
          <Text>{focused?.preview ? renderMarkdown(focused.preview) : '（此项无预览）'}</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={T.accent} paddingX={1}>
      {body}
    </Box>
  )
}
