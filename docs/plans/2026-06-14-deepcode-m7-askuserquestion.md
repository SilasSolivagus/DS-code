# AskUserQuestion 实现计划（M7 子项 1/3）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 deepcode 加 AskUserQuestion 工具——模型在歧义/需选择时弹结构化多选题问用户（CC 全平奇：单选/多选/「其他」自由输入/preview 并排/备注），headless 不注册。

**Architecture:** 工厂工具 `makeAskUserQuestionTool({ ask })`（同 makeAgentTool 注入），`ask` 由 useChat 用「挂起 Promise + pendingQuestion 状态」桥实现（镜像现有权限弹窗 pendingAsk/resolveAsk）。新 QuestionDialog 组件镜像 PermissionDialog。headless.ts 不注册该工具。

**Tech Stack:** TypeScript ESM、ink 5、React 18、zod、vitest、ink-testing-library。

**设计依据：** `docs/specs/2026-06-14-deepcode-m7-askuserquestion-design.md`。CC 源码参照 `/Users/silas/Desktop/src/tools/AskUserQuestionTool`（note 键/preview 列宽等细节对齐）。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/tools/askUserQuestion.ts` | 创建 | schema + Question/Answer 类型 + 工厂工具 + JSON 结果格式化 |
| `src/tui/components/QuestionDialog.tsx` | 创建 | 逐题菜单/多选/Other/preview 并排/note |
| `src/tui/useChat.ts` | 改 | pendingQuestion/resolveQuestion + questionAsk 桥 + 注册工具 + Esc 兜底 + snap/ChatState/ChatCore |
| `src/tui/App.tsx` | 改 | 挂 QuestionDialog + inputActive 门 + draft 清除 effect |
| `test/tools.askUserQuestion.test.ts` | 创建 | 工具/schema/JSON 格式化/取消 |
| `test/tui.questionDialog.test.tsx` | 创建 | 组件交互 |
| `test/headless.test.ts` | 改 | 断言 headless 工具表不含 AskUserQuestion |

---

## Task 1: AskUserQuestion 工具 + schema + JSON 结果

**Files:**
- Create: `src/tools/askUserQuestion.ts`, `test/tools.askUserQuestion.test.ts`

- [ ] **Step 1: 写失败测试** `test/tools.askUserQuestion.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { makeAskUserQuestionTool, type Answer } from '../src/tools/askUserQuestion.js'

const ctx: any = { cwd: () => '/tmp', setCwd: () => {}, signal: new AbortController().signal, fileState: new Map() }

const Q = [{
  question: '认证方式用哪个？', header: '认证', multiSelect: false,
  options: [{ label: 'OAuth', description: '第三方登录' }, { label: '密码', description: '本地' }],
}]

describe('AskUserQuestion 工具', () => {
  it('isReadOnly / 不需权限 / schema 基本校验', () => {
    const tool = makeAskUserQuestionTool({ ask: async () => null })
    expect(tool.name).toBe('AskUserQuestion')
    expect(tool.isReadOnly).toBe(true)
    expect(tool.needsPermission({ questions: Q } as any)).toBe(false)
    expect(tool.inputSchema.safeParse({ questions: Q }).success).toBe(true)
    // 少于 2 个选项应失败
    expect(tool.inputSchema.safeParse({ questions: [{ ...Q[0], options: [Q[0].options[0]] }] }).success).toBe(false)
  })

  it('call 返回 JSON：键为 question，值含 selected/note/freeText', async () => {
    const answers: Answer[] = [{ header: '认证', question: '认证方式用哪个？', selected: ['OAuth'], note: '先用 Google' }]
    const tool = makeAskUserQuestionTool({ ask: async () => answers })
    const out = await tool.call({ questions: Q }, ctx)
    const parsed = JSON.parse(out)
    expect(parsed['认证方式用哪个？'].selected).toEqual(['OAuth'])
    expect(parsed['认证方式用哪个？'].note).toBe('先用 Google')
  })

  it('多选 + freeText 进 JSON', async () => {
    const answers: Answer[] = [{ header: '功能', question: '要哪些？', selected: ['A', 'B'], freeText: '还要C' }]
    const tool = makeAskUserQuestionTool({ ask: async () => answers })
    const out = await tool.call({ questions: Q }, ctx)
    const p = JSON.parse(out)['要哪些？']
    expect(p.selected).toEqual(['A', 'B'])
    expect(p.other).toBe('还要C')
  })

  it('ask 返回 null（取消）→ 返回取消文案', async () => {
    const tool = makeAskUserQuestionTool({ ask: async () => null })
    const out = await tool.call({ questions: Q }, ctx)
    expect(out).toContain('取消')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/tools.askUserQuestion.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写** `src/tools/askUserQuestion.ts`:
```ts
// src/tools/askUserQuestion.ts
// AskUserQuestion 工具（CC 全平奇）：模型弹结构化多选题问用户。工厂注入 ask（由 TUI 提供；headless 不注册）。
import { z } from 'zod'
import type { Tool } from './types.js'

const optionSchema = z.object({
  label: z.string(),
  description: z.string(),
  preview: z.string().optional(),
})

const questionSchema = z.object({
  question: z.string(),
  header: z.string(),
  multiSelect: z.boolean(),
  options: z.array(optionSchema).min(2).max(4),
})

const schema = z.object({
  questions: z.array(questionSchema).min(1).max(4),
})

export type Question = z.infer<typeof questionSchema>
export type QOption = z.infer<typeof optionSchema>
export type Answer = { header: string; question: string; selected: string[]; note?: string; freeText?: string }

/** 把用户答案编码为模型可读的 JSON（键=question 文本） */
function formatAnswers(answers: Answer[]): string {
  const obj: Record<string, { selected: string[]; note?: string; other?: string }> = {}
  for (const a of answers) {
    obj[a.question] = { selected: a.selected }
    if (a.note) obj[a.question].note = a.note
    if (a.freeText) obj[a.question].other = a.freeText
  }
  return JSON.stringify(obj)
}

export function makeAskUserQuestionTool(deps: {
  ask: (questions: Question[]) => Promise<Answer[] | null>
}): Tool<typeof schema> {
  return {
    name: 'AskUserQuestion',
    description:
      '当需要用户拍板（歧义、多种合理选择、需要偏好）时，弹结构化多选题问用户，而不是自作主张。1–4 题，每题 2–4 个选项，可多选；返回用户选择的 JSON。仅交互式可用。',
    inputSchema: schema,
    isReadOnly: true,
    needsPermission: () => false,
    async call(input) {
      const answers = await deps.ask(input.questions)
      if (!answers) return '用户取消了提问，请自行按最佳判断继续。'
      return formatAnswers(answers)
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/tools.askUserQuestion.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck + 提交**

Run: `npm run typecheck`（无输出）
```bash
git add src/tools/askUserQuestion.ts test/tools.askUserQuestion.test.ts
git commit -m "feat(M7): AskUserQuestion 工具（schema + 工厂 + JSON 结果格式化）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: QuestionDialog 组件

镜像 PermissionDialog（accent 面板 + useInput）。单选/多选/「其他」自由输入/preview 并排/备注/逐题。

**Files:**
- Create: `src/tui/components/QuestionDialog.tsx`, `test/tui.questionDialog.test.tsx`

- [ ] **Step 1: 写失败测试** `test/tui.questionDialog.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { QuestionDialog } from '../src/tui/components/QuestionDialog.js'
import type { Question } from '../src/tools/askUserQuestion.js'

const delay = (ms = 25) => new Promise(r => setTimeout(r, ms))

const single: Question[] = [{
  question: '认证方式？', header: '认证', multiSelect: false,
  options: [{ label: 'OAuth', description: '第三方' }, { label: '密码', description: '本地' }],
}]

describe('QuestionDialog', () => {
  it('渲染问句、选项、进度', () => {
    const f = render(<QuestionDialog questions={single} onDone={() => {}} />).lastFrame()!
    expect(f).toContain('认证方式？')
    expect(f).toContain('OAuth')
    expect(f).toContain('其他')
    expect(f).toContain('(1/1)')
  })

  it('数字键直选 → onDone 带 selected（无备注则按 Enter 跳过 note）', async () => {
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={single} onDone={onDone} />)
    await delay()
    stdin.write('1')       // 选 OAuth → 进 note
    await delay()
    stdin.write('\r')      // note 空 → 确认，单题结束
    await delay()
    expect(onDone).toHaveBeenCalledTimes(1)
    const ans = onDone.mock.calls[0][0]
    expect(ans[0].selected).toEqual(['OAuth'])
    expect(ans[0].note).toBeUndefined()
  })

  it('备注：选完输入备注 → 进 answer', async () => {
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={single} onDone={onDone} />)
    await delay()
    stdin.write('1'); await delay()        // 选 OAuth → note 模式
    stdin.write('先用谷歌'); await delay()
    stdin.write('\r'); await delay()
    expect(onDone.mock.calls[0][0][0].note).toBe('先用谷歌')
  })

  it('多选：空格勾选两项 + Enter', async () => {
    const multi: Question[] = [{
      question: '要哪些？', header: '功能', multiSelect: true,
      options: [{ label: 'A', description: '' }, { label: 'B', description: '' }, { label: 'C', description: '' }],
    }]
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={multi} onDone={onDone} />)
    await delay()
    stdin.write(' ');                 await delay()  // 勾 A
    stdin.write('\x1B[B'); stdin.write(' '); await delay()  // ↓ 到 B，勾 B
    stdin.write('\r');                await delay()  // 提交 → note
    stdin.write('\r');                await delay()  // note 空 → 确认
    expect(onDone.mock.calls[0][0][0].selected).toEqual(['A', 'B'])
  })

  it('其他（自由输入）→ freeText', async () => {
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={single} onDone={onDone} />)
    await delay()
    stdin.write('3'); await delay()        // 第3项=「其他」
    stdin.write('自定义答案'); await delay()
    stdin.write('\r'); await delay()       // other 提交 → note
    stdin.write('\r'); await delay()       // note 空 → 确认
    const a = onDone.mock.calls[0][0][0]
    expect(a.freeText).toBe('自定义答案')
    expect(a.selected).toEqual(['自定义答案'])
  })

  it('Esc → onDone(null)', async () => {
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={single} onDone={onDone} />)
    await delay()
    stdin.write('\x1B'); await delay()
    expect(onDone).toHaveBeenCalledWith(null)
  })

  it('有 preview 时并排渲染聚焦项预览', () => {
    const wp: Question[] = [{
      question: '选布局', header: '布局', multiSelect: false,
      options: [{ label: 'A', description: '', preview: '预览内容XYZ' }, { label: 'B', description: '' }],
    }]
    const f = render(<QuestionDialog questions={wp} onDone={() => {}} />).lastFrame()!
    expect(f).toContain('预览内容XYZ')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/tui.questionDialog.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 写** `src/tui/components/QuestionDialog.tsx`:
```tsx
// src/tui/components/QuestionDialog.tsx
// AskUserQuestion 弹窗：逐题菜单（单选/多选/「其他」自由输入/preview 并排/备注），镜像 PermissionDialog。
// 交互细节（note 键/preview 列宽）对齐 CC 源码 /Users/silas/Desktop/src/tools/AskUserQuestionTool。
import React, { useState } from 'react'
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
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [answers, setAnswers] = useState<Answer[]>([])
  const [mode, setMode] = useState<'select' | 'other' | 'note'>('select')
  const [buf, setBuf] = useState('')
  const [draft, setDraft] = useState<Answer | null>(null)

  const q = questions[qi]
  const opts = [...q.options, { label: OTHER, description: '' }]
  const otherIdx = q.options.length
  const isOther = (i: number) => i === otherIdx

  // 选完一题 → 暂存草稿，进入备注机会
  const toNote = (selected: string[], freeText?: string) => {
    setDraft({ header: q.header, question: q.question, selected, freeText })
    setMode('note'); setBuf('')
  }
  // 提交答案 → 下一题或结束
  const commit = (ans: Answer) => {
    const next = [...answers, ans]
    if (qi + 1 >= questions.length) { onDone(next); return }
    setAnswers(next); setQi(qi + 1); setIdx(0); setChecked(new Set()); setMode('select'); setBuf(''); setDraft(null)
  }

  useInput((input, key) => {
    if (key.escape) { onDone(null); return }

    if (mode === 'other') {
      if (key.return) { const t = buf.trim(); toNote([t || '(空)'], t || undefined); return }
      if (key.backspace || key.delete) { setBuf(b => b.slice(0, -1)); return }
      if (!key.ctrl && !key.meta && input) setBuf(b => b + input)
      return
    }
    if (mode === 'note') {
      if (key.return) { commit({ ...draft!, note: buf.trim() || undefined }); return }
      if (key.backspace || key.delete) { setBuf(b => b.slice(0, -1)); return }
      if (!key.ctrl && !key.meta && input) setBuf(b => b + input)
      return
    }

    // select
    if (key.upArrow) { setIdx(i => Math.max(0, i - 1)); return }
    if (key.downArrow) { setIdx(i => Math.min(opts.length - 1, i + 1)); return }
    if (q.multiSelect && input === ' ' && !isOther(idx)) {
      setChecked(c => { const n = new Set(c); n.has(idx) ? n.delete(idx) : n.add(idx); return n }); return
    }
    if (key.return || /^[1-9]$/.test(input)) {
      const sel = /^[1-9]$/.test(input) ? Number(input) - 1 : idx
      if (sel < 0 || sel >= opts.length) return
      if (isOther(sel)) { setMode('other'); setBuf(''); return }
      if (q.multiSelect && key.return) {
        const picks = checked.size ? [...checked] : [sel]
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/tui.questionDialog.test.tsx`
Expected: PASS（7 用例）。若某用例因 ink stdin 时序偶发不稳，适度增大 `delay()`。

- [ ] **Step 5: typecheck + 提交**

Run: `npm run typecheck`
```bash
git add src/tui/components/QuestionDialog.tsx test/tui.questionDialog.test.tsx
git commit -m "feat(M7): QuestionDialog 组件（单选/多选/其他/preview 并排/备注/逐题）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: useChat 接线（pendingQuestion 桥 + 注册工具 + Esc 兜底）

镜像 pendingAsk/resolveAsk。

**Files:**
- Modify: `src/tui/useChat.ts`
- Test: `test/useChat.askquestion.test.ts`（创建）

- [ ] **Step 1: 写失败测试** `test/useChat.askquestion.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { createChatCore } from '../src/tui/useChat.js'

// 仅验证 pendingQuestion 桥的状态机：questionAsk 设状态、resolveQuestion 解锁。
// 这里直接通过反射不可行（questionAsk 是内部），改为黑盒：构造 core 后断言 ChatState 含 pendingQuestion 字段且初始为 null。
describe('useChat AskUserQuestion 桥', () => {
  it('ChatState 暴露 pendingQuestion（初始 null），ChatCore 暴露 resolveQuestion', () => {
    const core = createChatCore({
      client: {} as any, yolo: false, cwd: '/tmp',
      sessionDir: '/tmp/dc-test-' + Math.random().toString(36).slice(2),
      onState: () => {},
    })
    expect(core.state.pendingQuestion).toBeNull()
    expect(typeof core.resolveQuestion).toBe('function')
  })
})
```
（注：questionAsk 的完整挂起-解锁链由 QuestionDialog 组件测试 + 集成覆盖；此处只钉住 ChatState/ChatCore 契约，避免脆弱的内部 mock。`createChatCore` 已支持 `sessionDir` 注入隔离落盘。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/useChat.askquestion.test.ts`
Expected: FAIL（`pendingQuestion`/`resolveQuestion` 不存在）

- [ ] **Step 3: 改 `src/tui/useChat.ts`**

3a. 顶部 import 区加：
```ts
import { makeAskUserQuestionTool, type Question, type Answer } from '../tools/askUserQuestion.js'
```

3b. 在 `PendingAsk` 接口附近（约 129 行）加类型：
```ts
export interface PendingQuestion { questions: Question[]; resolve: (a: Answer[] | null) => void }
```

3c. `ChatState` 接口（约 131-145 行）加字段：
```ts
  pendingQuestion: PendingQuestion | null
```

3d. `ChatCore` 接口（约 147-157 行）加方法：
```ts
  resolveQuestion(answers: Answer[] | null): void
```

3e. 在 `let pendingAsk: PendingAsk | null = null`（约 196 行）下加：
```ts
  let pendingQuestion: PendingQuestion | null = null
```

3f. `snap()`（约 213 行）的返回对象里，`pendingAsk` 后加 `pendingQuestion`：
```ts
    transcript, busy, model, thinking, permMode, pendingAsk, pendingQuestion, usageLog, lastTokPerSec, turnStartAt, turnOutTokens, sessionCost, cacheHitRate, contextPct,
```

3g. 在权限桥 `const ask = ...`（约 298 行）下加 questionAsk 桥：
```ts
  // AskUserQuestion 桥：挂起 Promise + pendingQuestion 状态，UI 用 resolveQuestion 回答
  const questionAsk = (questions: Question[]): Promise<Answer[] | null> =>
    new Promise<Answer[] | null>(res => {
      pendingQuestion = { questions, resolve: res }
      setState()
    })
```

3h. 工具装配（约 266-272 行）的 `tools` 数组里，在 makeWebFetchTool 之后加：
```ts
    makeAskUserQuestionTool({ ask: questionAsk }),
```

3i. Esc/中断兜底：找到 interrupt 里对 pendingAsk 的兜底（约 534-536 行 `if (pendingAsk) { ... p.resolve('no') }`），在其后加：
```ts
    if (pendingQuestion) { const p = pendingQuestion; pendingQuestion = null; setState(); p.resolve(null) }
```

3j. 在 ChatCore 返回对象里（`resolveAsk` 附近）加 `resolveQuestion`：
```ts
    resolveQuestion(answers) { if (pendingQuestion) { const p = pendingQuestion; pendingQuestion = null; setState(); p.resolve(answers) } },
```
（按该文件 ChatCore 返回对象的既有写法风格放置——找到 `resolveAsk(d) { ... }` 那处，紧邻加。）

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run test/useChat.askquestion.test.ts && npm test && npm run typecheck`
Expected: 新测试 PASS、全量绿、typecheck 干净

- [ ] **Step 5: 提交**
```bash
git add src/tui/useChat.ts test/useChat.askquestion.test.ts
git commit -m "feat(M7): useChat 接 AskUserQuestion（pendingQuestion 桥 + 注册工具 + Esc 兜底）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: App 挂载 + headless 排除断言 + 集成验收

**Files:**
- Modify: `src/tui/App.tsx`
- Test: `test/headless.test.ts`（改，加断言）

- [ ] **Step 1: 改 `src/tui/App.tsx`**

1a. import 区加：
```ts
import { QuestionDialog } from './components/QuestionDialog.js'
```

1b. `inputActive`（约 157 行 `const inputActive = !state.pendingAsk && !resumeMode && !state.busy`）改为：
```ts
  const inputActive = !state.pendingAsk && !state.pendingQuestion && !resumeMode && !state.busy
```

1c. draft 清除 effect（约 60-67 行，依赖 `[!!state.pendingAsk, resumeMode]`）：把条件与依赖都加上 pendingQuestion：
```ts
    if (state.pendingAsk || state.pendingQuestion || resumeMode) {
```
依赖数组改为：
```ts
  }, [!!state.pendingAsk, !!state.pendingQuestion, resumeMode])  // eslint-disable-line react-hooks/exhaustive-deps
```

1d. 渲染区（约 198-199 行 `{state.pendingAsk ? <PermissionDialog .../> : ...}`）——在 PermissionDialog 三元之外、同级补一个 QuestionDialog 分支。把原：
```tsx
      {state.pendingAsk
        ? <PermissionDialog ask={state.pendingAsk} onDecide={d => core.resolveAsk(d)} />
        : ...原有 else 内容...}
```
改为先判 pendingQuestion（两者互斥，同一时刻只挂一个）：
```tsx
      {state.pendingQuestion
        ? <QuestionDialog questions={state.pendingQuestion.questions} onDone={a => core.resolveQuestion(a)} />
        : state.pendingAsk
        ? <PermissionDialog ask={state.pendingAsk} onDecide={d => core.resolveAsk(d)} />
        : ...原有 else 内容...}
```
（保持原 else 分支内容不变，只在最外层加一个 pendingQuestion 优先分支。）

- [ ] **Step 2: headless 不含该工具——加断言到 `test/headless.test.ts`**

先确认 headless 工具组装：`src/headless.ts` 的 `tools` 数组**未**包含 makeAskUserQuestionTool（Task 1-3 不动 headless.ts，天然不含）。在 `test/headless.test.ts` 末尾加一条断言守住此契约：
```ts
import { readFileSync } from 'node:fs'
it('headless 工具表不注册 AskUserQuestion（无人可答）', () => {
  const src = readFileSync(new URL('../src/headless.ts', import.meta.url), 'utf8')
  expect(src.includes('makeAskUserQuestionTool')).toBe(false)
})
```
（用源码静态断言，避免构造完整 headless 运行环境；若 `test/headless.test.ts` 已 import `readFileSync` 则不重复。）

- [ ] **Step 3: 全量回归 + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: 全绿、typecheck 干净、build 成功

- [ ] **Step 4: pty 冒烟（手动验证交互）**

在真终端 `npm start`，构造一次让模型调 AskUserQuestion 的提问（或临时在 dev 里直接渲染 QuestionDialog），核对：单选数字键、多选空格、其他自由输入、有 preview 时并排、备注、Esc 取消。记录结果。
（注：pty 自动化对多步交互脆弱，此项以真终端人工核对为准；自动覆盖已由组件测试完成。）

- [ ] **Step 5: 提交**
```bash
git add src/tui/App.tsx test/headless.test.ts
git commit -m "feat(M7): App 挂 QuestionDialog + headless 不注册断言 + 集成

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 自查

- **Spec 覆盖**：schema(T1)、工厂工具+JSON 结果(T1)、headless 不注册(T1 默认+T4 断言)、pendingQuestion 桥/resolveQuestion/Esc 兜底(T3)、QuestionDialog 单选/多选/Other/preview/note/逐题(T2)、App 挂载+inputActive 门(T4)、结果格式 JSON(T1)、取消路径(T1+T2+T3)。全覆盖。
- **类型一致**：`Question`/`Answer`/`QOption`（T1 定义，T2/T3 用）；`makeAskUserQuestionTool({ask})`、`PendingQuestion`、`resolveQuestion`、`pendingQuestion`（T1/T3 定义，T3/T4 用）；`renderMarkdown`（已存在，T2 用）。前后一致。
- **顺序依赖**：T1（工具/类型）→ T2（组件，依赖 Question/Answer 类型）→ T3（接线，依赖工具+类型）→ T4（装配，依赖组件+桥）。严格串行。
- **无占位**：每步含真实代码/命令/期望。
- **不碰**：loop/api/session/permissions/headless 逻辑零改动（headless 仅「不注册」，靠不动它实现）；其余工具不动。
- **CC 对齐**：note 触发流程/preview 列宽（T2 用固定 width=42 折中）等细节，实现时可参照 CC 源码 `/Users/silas/Desktop/src/tools/AskUserQuestionTool` 微调，不阻塞主线。
