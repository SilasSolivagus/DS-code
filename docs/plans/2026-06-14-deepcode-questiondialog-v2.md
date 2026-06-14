# QuestionDialog v2（对齐 CC 重写）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 AskUserQuestion 弹窗重写为对齐 CC 的交互模型——顶部 tab 导航条（Tab/方向键回上一题重选、选择保留）、单选选中即进下一题、多选「下一步/提交」确认按钮、末尾提交复核页（列全部答案 + 提交/取消）；单个单选题省略复核页选完即结束；**去掉 note 备注**完全对齐 CC。

**Architecture:** 重写 `QuestionDialog.tsx` 的交互状态机（`qi` 0..N，==N 为提交页；每题草稿 `{picks:Set, freeText}` 存 ref、tab 间切换保留）。`askUserQuestion.ts` 去掉 `Answer.note` 与 formatAnswers 的 note 分支。**契约完全不变**：`onDone(Answer[]|null)`、useChat `pendingQuestion/resolveQuestion`、App 挂载、headless 不注册——这四处一行不动。

**Tech Stack:** TypeScript ESM、ink 5、React 18、zod、vitest、ink-testing-library。

**设计依据：** 记忆 `deepcode-project.md` 2026-06-14「M7① QuestionDialog v2」条目。CC 源码参照 `/Users/silas/Desktop/src/components/permissions/AskUserQuestionPermissionRequest/{QuestionNavigationBar,QuestionView,SubmitQuestionsView}.tsx`（编译混淆，只读交互语义）。

**ink 同步连键铁律：** ink 的 `useInput` 同步连发多键会在一个 React batch 内读到 stale state。所有影响分支判断的量（`qi`/`cursor`/`drafts`/`mode`/`buf`/`submitCur`）**必须配 ref**：`updateX` 原子更新 `ref+state`，handler 一律读 `ref`，render 读 `state`/`tick`。沿用现有 v1 的 `qiRef`/`idxRef` 模式。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/tools/askUserQuestion.ts` | 改 | `Answer` 去 `note`；`formatAnswers` 去 note 分支 |
| `src/tui/components/QuestionDialog.tsx` | 重写 | 新交互模型：tab 导航 + 单选即进 + 多选确认按钮 + 提交复核页 + hideSubmitTab + preview 并排；无 note |
| `test/tools.askUserQuestion.test.ts` | 改 | 删 note 用例/断言 |
| `test/tui.questionDialog.test.tsx` | 重写 | 覆盖新交互模型全路径 |

**不碰：** `src/tui/useChat.ts`（pendingQuestion 桥）、`src/tui/App.tsx`（挂载）、`src/headless.ts`（不注册）、`test/useChat.askquestion.test.ts`、`test/headless.test.ts`——契约不变，零改动。

---

## Task 1: 工具去 note（Answer 类型 + formatAnswers）

**Files:**
- Modify: `src/tools/askUserQuestion.ts`
- Test: `test/tools.askUserQuestion.test.ts`

- [ ] **Step 1: 先确认 note 无其他消费者**

Run: `grep -rn "\.note\|note:" src/ | grep -i answer; grep -rn "note" src/tools/askUserQuestion.ts src/tui/components/QuestionDialog.tsx`
Expected: 命中仅在 `askUserQuestion.ts`、`QuestionDialog.tsx`、测试中（useChat/App 不引用 `Answer.note`）。若发现其他消费者，停下来报告。

- [ ] **Step 2: 改测试** `test/tools.askUserQuestion.test.ts` —— 把 note 用例替换为无 note 版本。整文件改为：

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
    expect(tool.inputSchema.safeParse({ questions: [{ ...Q[0], options: [Q[0].options[0]] }] }).success).toBe(false)
  })

  it('call 返回 JSON：键为 question，值含 selected', async () => {
    const answers: Answer[] = [{ header: '认证', question: '认证方式用哪个？', selected: ['OAuth'] }]
    const tool = makeAskUserQuestionTool({ ask: async () => answers })
    const out = await tool.call({ questions: Q }, ctx)
    const parsed = JSON.parse(out)
    expect(parsed['认证方式用哪个？'].selected).toEqual(['OAuth'])
    expect(parsed['认证方式用哪个？'].note).toBeUndefined()
  })

  it('多选 + freeText 进 JSON（other）', async () => {
    const answers: Answer[] = [{ header: '功能', question: '要哪些？', selected: ['A', 'B', '还要C'], freeText: '还要C' }]
    const tool = makeAskUserQuestionTool({ ask: async () => answers })
    const out = await tool.call({ questions: Q }, ctx)
    const p = JSON.parse(out)['要哪些？']
    expect(p.selected).toEqual(['A', 'B', '还要C'])
    expect(p.other).toBe('还要C')
  })

  it('ask 返回 null（取消）→ 返回取消文案', async () => {
    const tool = makeAskUserQuestionTool({ ask: async () => null })
    const out = await tool.call({ questions: Q }, ctx)
    expect(out).toContain('取消')
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run test/tools.askUserQuestion.test.ts`
Expected: 类型/断言失败（`Answer` 仍含 note；note 用例已删但 formatAnswers 仍写 note 不影响——主要确认编译期 `note` 字段引用处）。实际本步可能因 TS 宽松而部分通过；以 Step 5 typecheck 为准。

- [ ] **Step 4: 改实现** `src/tools/askUserQuestion.ts` —— `Answer` 去 `note`，`formatAnswers` 去 note 分支。改这两处：

`Answer` 类型（约 25 行）改为：
```ts
export type Answer = { header: string; question: string; selected: string[]; freeText?: string }
```

`formatAnswers`（约 28-36 行）改为：
```ts
/** 把用户答案编码为模型可读的 JSON（键=question 文本） */
function formatAnswers(answers: Answer[]): string {
  const obj: Record<string, { selected: string[]; other?: string }> = {}
  for (const a of answers) {
    obj[a.question] = { selected: a.selected }
    if (a.freeText) obj[a.question].other = a.freeText
  }
  return JSON.stringify(obj)
}
```

- [ ] **Step 5: 跑测试 + typecheck**

Run: `npx vitest run test/tools.askUserQuestion.test.ts && npm run typecheck`
Expected: 工具测试 PASS；typecheck 此时**会因 `QuestionDialog.tsx` 仍引用 `note` 而报错**——这是预期的，Task 2 重写组件后清除。**本步只需工具测试 PASS**；typecheck 留到 Task 2 末尾整体通过。

- [ ] **Step 6: 暂不提交**

Task 1 与 Task 2 在 typecheck 上耦合（旧组件引用 note）。先做 Task 2 再一起提交，或本步用 `--no-verify` 跳过钩子单独提交工具改动。推荐：**不提交，直接进 Task 2**，Task 2 末尾一并提交两文件。

---

## Task 2: QuestionDialog v2 重写（新交互模型）

新交互模型一次成型。先写完整新测试套件（失败），再实现组件到全绿。

**Files:**
- Rewrite: `src/tui/components/QuestionDialog.tsx`
- Rewrite: `test/tui.questionDialog.test.tsx`

### 交互模型（实现须严格遵守）

- **索引 `qi`**：0..N。`qi < N` 为第 qi 题；`qi === N` 为提交复核页。`hideSubmitTab`（仅当 `N===1 且 !multiSelect`）时无提交页，`lastQi = N-1`，选完即 `onDone`。
- **每题草稿** `drafts[qi] = { picks:Set<number>, freeText?:string }`，存 `draftsRef`（真相来源），变更后 `tick` 强制重渲。tab 间切换保留。
- **行结构**：单选 = `[opt0..optK, 其他]`；多选 = `[opt0..optK, 其他, 「下一步/提交」动作行]`。`otherRow = options.length`；`actionRow = options.length+1`（仅多选）。
- **导航键**（仅 select 模式生效）：`Tab`/`→` 下一题（到 `lastQi` 封顶）；`Shift+Tab`/`←` 上一题（到 0 封底）。切换保留选择。
- **单选**：`↑↓` 移光标；数字键 `1..options.length` 或在选项行 `Enter` → 记录单一选择并 `advance()`。在「其他」行 `Enter` → 进自由输入。
- **多选**：`空格` 勾选当前选项行（toggle）；数字键也 toggle；选项行 `Enter` **不提交**（无操作）；移到「动作行」`Enter` 才 `advance()`（确认本题）。「其他」行 `Enter` → 自由输入，输入后作为该题 `freeText` 并回列表。
- **`advance()`**：`qi+1`；若 `hideSubmitTab && qi+1>=N` → `onDone(buildAnswers())`；否则 `goTo(min(qi+1, N))`。
- **提交复核页**（`qi===N`）：列全部已答（NavBar 顶部「✓提交」高亮）；`↑↓` 在「提交答案/取消」间选；`Enter` 提交 → `onDone(buildAnswers())`，取消 → `onDone(null)`；`←`/`Shift+Tab` 回上一题。
- **`Esc`** 任意处 → `onDone(null)`。
- **preview**：聚焦项有 preview 时列表与预览框并排（沿用 v1，width=42）。
- **`buildAnswers()`**：按题序，仅收非空题（`picks.size>0 || freeText`）。`selected = picks.map(label)`，`freeText` 存在则 push 进 selected 并置 `Answer.freeText`。

- [ ] **Step 1: 重写失败测试** `test/tui.questionDialog.test.tsx`（整文件替换）:

```tsx
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { QuestionDialog } from '../src/tui/components/QuestionDialog.js'
import type { Question } from '../src/tools/askUserQuestion.js'

const delay = (ms = 30) => new Promise(r => setTimeout(r, ms))
const DOWN = '\x1B[B', UP = '\x1B[A', LEFT = '\x1B[D'

const single: Question[] = [{
  question: '认证方式？', header: '认证', multiSelect: false,
  options: [{ label: 'OAuth', description: '第三方' }, { label: '密码', description: '本地' }],
}]

const two: Question[] = [
  { question: 'Q1?', header: 'H1', multiSelect: false,
    options: [{ label: 'A1', description: '' }, { label: 'B1', description: '' }] },
  { question: 'Q2?', header: 'H2', multiSelect: false,
    options: [{ label: 'A2', description: '' }, { label: 'B2', description: '' }] },
]

describe('QuestionDialog v2', () => {
  it('渲染 tab 导航条、问句、选项、进度', () => {
    const f = render(<QuestionDialog questions={single} onDone={() => {}} />).lastFrame()!
    expect(f).toContain('认证方式？')
    expect(f).toContain('OAuth')
    expect(f).toContain('其他')
    expect(f).toContain('(1/1)')
    expect(f).toContain('认证')   // tab 头 = header
  })

  it('单选数字键：单个单选题选完即结束（hideSubmitTab，无复核页）', async () => {
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={single} onDone={onDone} />)
    await delay()
    stdin.write('1'); await delay()
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone.mock.calls[0][0][0].selected).toEqual(['OAuth'])
  })

  it('单选 Enter：在聚焦项确认即结束', async () => {
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={single} onDone={onDone} />)
    await delay()
    stdin.write('\r'); await delay()   // 光标默认在 OAuth
    expect(onDone.mock.calls[0][0][0].selected).toEqual(['OAuth'])
  })

  it('多题：答完两题 → 复核页 → 提交，答案各归各题', async () => {
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={two} onDone={onDone} />)
    await delay()
    stdin.write('1'); await delay()    // Q1 选 A1 → 进 Q2
    stdin.write('1'); await delay()    // Q2 选 A2 → 进复核页
    stdin.write('\r'); await delay()   // 复核页默认「提交答案」→ onDone
    expect(onDone).toHaveBeenCalledTimes(1)
    const ans = onDone.mock.calls[0][0]
    expect(ans).toHaveLength(2)
    expect(ans[0]).toMatchObject({ question: 'Q1?', selected: ['A1'] })
    expect(ans[1]).toMatchObject({ question: 'Q2?', selected: ['A2'] })
  })

  it('回上一题重选（←）：选择被覆盖', async () => {
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={two} onDone={onDone} />)
    await delay()
    stdin.write('1'); await delay()    // Q1 → A1，进 Q2
    stdin.write(LEFT); await delay()   // ← 回 Q1
    stdin.write('2'); await delay()    // 重选 B1，进 Q2
    stdin.write('1'); await delay()    // Q2 → A2，进复核页
    stdin.write('\r'); await delay()   // 提交
    const ans = onDone.mock.calls[0][0]
    expect(ans[0].selected).toEqual(['B1'])
    expect(ans[1].selected).toEqual(['A2'])
  })

  it('多选：空格勾两项 + 移到动作行 Enter 确认 → 复核页 → 提交', async () => {
    const multi: Question[] = [{
      question: '要哪些？', header: '功能', multiSelect: true,
      options: [{ label: 'A', description: '' }, { label: 'B', description: '' }, { label: 'C', description: '' }],
    }]
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={multi} onDone={onDone} />)
    await delay()
    stdin.write(' '); await delay()              // 勾 A（光标 0）
    stdin.write(DOWN); stdin.write(' '); await delay()  // ↓ 到 B，勾 B
    // 光标在 1，动作行 = options.length+1 = 4；↓×3 到动作行
    stdin.write(DOWN); stdin.write(DOWN); stdin.write(DOWN); await delay()
    stdin.write('\r'); await delay()             // 动作行确认 → 复核页
    stdin.write('\r'); await delay()             // 复核页提交
    expect(onDone.mock.calls[0][0][0].selected).toEqual(['A', 'B'])
  })

  it('多选：选项行 Enter 不提交', async () => {
    const multi: Question[] = [{
      question: '要哪些？', header: '功能', multiSelect: true,
      options: [{ label: 'A', description: '' }, { label: 'B', description: '' }],
    }]
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={multi} onDone={onDone} />)
    await delay()
    stdin.write(' '); await delay()    // 勾 A
    stdin.write('\r'); await delay()   // 选项行 Enter —— 应无操作
    expect(onDone).not.toHaveBeenCalled()
  })

  it('其他（自由输入）→ freeText（单个单选题即结束）', async () => {
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={single} onDone={onDone} />)
    await delay()
    stdin.write(DOWN); stdin.write(DOWN); await delay()  // 光标 0→1→2（其他行）
    stdin.write('\r'); await delay()                     // 进自由输入
    stdin.write('自定义答案'); await delay()
    stdin.write('\r'); await delay()                     // 确认 → 单题即结束
    const a = onDone.mock.calls[0][0][0]
    expect(a.freeText).toBe('自定义答案')
    expect(a.selected).toContain('自定义答案')
  })

  it('复核页取消 → onDone(null)', async () => {
    const onDone = vi.fn()
    const { stdin } = render(<QuestionDialog questions={two} onDone={onDone} />)
    await delay()
    stdin.write('1'); await delay()    // Q1
    stdin.write('1'); await delay()    // Q2 → 复核页
    stdin.write(DOWN); await delay()   // 选「取消」
    stdin.write('\r'); await delay()
    expect(onDone).toHaveBeenCalledWith(null)
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
Expected: 多数用例 FAIL（旧组件无 tab 导航/复核页/动作行语义）。

- [ ] **Step 3: 重写组件** `src/tui/components/QuestionDialog.tsx`（整文件替换）:

```tsx
// src/tui/components/QuestionDialog.tsx
// AskUserQuestion 弹窗 v2（对齐 CC）：顶部 tab 导航条（Tab/方向键回上一题重选、选择保留），
// 单选选中即进下一题，多选空格勾选+「下一步/提交」确认按钮，末尾提交复核页（列全部答案+提交/取消）。
// 单个单选题省略复核页、选完即结束（hideSubmitTab）。去掉 note（对齐 CC）。Esc 取消。
// ink 同步连键安全：qi/cursor/drafts/mode/buf/submitCur 全配 ref——updateX 原子更新 ref+state，
// handler 读 ref，render 读 state/tick。
import React, { useState, useRef } from 'react'
import { Box, Text, useInput } from 'ink'
import { T } from '../theme.js'
import { renderMarkdown } from '../markdown.js'
import type { Question, Answer } from '../../tools/askUserQuestion.js'

const OTHER = '其他（自由输入）'

type Draft = { picks: Set<number>; freeText?: string }

export function QuestionDialog(props: {
  questions: Question[]
  onDone: (answers: Answer[] | null) => void
}) {
  const { questions, onDone } = props
  const N = questions.length
  const hideSubmitTab = N === 1 && !questions[0].multiSelect
  const submitIndex = N                       // qi===N 为提交页
  const lastQi = hideSubmitTab ? N - 1 : N    // 导航封顶

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
  const [submitCur, setSubmitCur] = useState(0)  // 0=提交 1=取消
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

  // 进入某题/页：恢复光标到该题首个已选项（无则 0），重置输入模式
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

    // —— 自由文本输入（「其他」）——
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

    // —— tab 导航（题间 + 提交页切换，选择保留）——
    if (key.tab && key.shift) { goTo(Math.max(0, qiRef.current - 1)); return }
    if (key.tab) { goTo(Math.min(lastQi, qiRef.current + 1)); return }
    if (key.leftArrow) { goTo(Math.max(0, qiRef.current - 1)); return }
    if (key.rightArrow) { goTo(Math.min(lastQi, qiRef.current + 1)); return }

    // —— 提交复核页 ——
    if (qiRef.current >= submitIndex) {
      if (key.upArrow) { updateSubmitCur(0); return }
      if (key.downArrow) { updateSubmitCur(1); return }
      if (key.return) { onDone(submitCurRef.current === 0 ? buildAnswers() : null) }
      return
    }

    // —— 题内 select ——
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
      if (q.multiSelect) { if (cur === actionRow(q)) advance(); return }  // 选项行 Enter 不提交
      chooseSingle(cur)
    }
  })

  // —— 渲染 ——
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/tui.questionDialog.test.tsx`
Expected: 全部 PASS（12 用例）。若某用例因 ink stdin 同步时序偶发不稳，适度增大 `delay()`，或把同一交互拆成多次 `stdin.write` + `await delay()`（真终端按键天然有间隔）。

- [ ] **Step 5: 全量回归 + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: 全绿（240→约 245，questionDialog 用例数变化）、typecheck 干净（Task 1 的 note 引用此刻全清）、build 成功。
特别确认 `test/useChat.askquestion.test.ts`、`test/tui.app.test.tsx`、`test/headless.test.ts` 仍绿（契约未变）。

- [ ] **Step 6: 提交（Task 1 + Task 2 一起）**

```bash
git add src/tools/askUserQuestion.ts test/tools.askUserQuestion.test.ts \
        src/tui/components/QuestionDialog.tsx test/tui.questionDialog.test.tsx
git commit -m "feat(M7①): QuestionDialog v2 对齐 CC 重写（tab 导航/回改/多选确认按钮/提交复核页/去 note）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 集成验收（App 契约确认 + pty 冒烟）

**Files:** 无改动（仅验证）。

- [ ] **Step 1: 确认 App 挂载契约未破**

Run: `grep -n "QuestionDialog\|pendingQuestion\|resolveQuestion" src/tui/App.tsx`
Expected: App.tsx 约 205-206 行仍为 `state.pendingQuestion ? <QuestionDialog questions={...} onDone={a => core.resolveQuestion(a)} /> : ...`——`onDone(Answer[]|null)` 契约不变，无需改 App。

- [ ] **Step 2: pty 冒烟（真终端人工核对）**

在真终端 `npm start`，诱导模型调 AskUserQuestion（或临时 dev 直接渲染多题 QuestionDialog），核对：
1. 顶部 tab 导航条显示各题 header + ✓提交。
2. 单选数字/Enter 选中即进下一题。
3. `←`/`Shift+Tab` 回上一题，先前选择仍在，可重选覆盖。
4. 多选空格勾选，选项行 Enter 不提交，移到「下一步/提交」Enter 才确认。
5. 末题动作行文案为「提交」，非末题为「下一步」。
6. 复核页列全部答案 + 提交/取消，取消 = onDone(null)。
7. 「其他」自由输入；preview 并排；Esc 取消。
8. **无任何 note 备注环节**（已对齐 CC）。

记录结果。（注：多步交互的 pty 自动化脆弱，以真终端人工核对为准；自动覆盖已由组件测试完成。）

- [ ] **Step 3: 更新记忆**

实现完成后在 `deepcode-project.md` 标注「M7① QuestionDialog v2 已实现并合入」，并把 MEMORY.md 的「QuestionDialog v2 待做」改为已完成。

---

## 自查

- **Spec 覆盖**：tab 导航条(T2 navBar)、Tab/方向键回改+选择保留(T2 导航键 + goTo 恢复光标)、单选选中即进(T2 chooseSingle/advance)、多选确认按钮(T2 actionRow + 选项行 Enter 不提交)、submitButtonText 末题"提交"/否则"下一步"(T2 渲染 `qi===N-1?'提交':'下一步'`)、提交复核页(T2 `qi>=submitIndex` 分支 + 提交/取消)、hideSubmitTab 单个单选省略复核页选完即结束(T2 hideSubmitTab/advance)、去 note(T1 + T2 全程无 note)、Esc 取消(T1 工具 + T2 组件)、preview 并排(T2)。全覆盖。
- **类型一致**：`Answer`（T1 去 note，T2 用新形）、`Question`/`QOption`（不变）、`Draft`（T2 内部）、`buildAnswers`/`advance`/`goTo`/`chooseSingle`/`otherRow`/`actionRow`/`rowsFor`（T2 内一致引用）。`formatAnswers` 的 `other` 键对应 `freeText`（T1）。前后一致。
- **契约不变**：`onDone(Answer[]|null)`、useChat `pendingQuestion/resolveQuestion`、App 第 205-206 行、headless 不注册——T3 Step 1 验证未破。
- **无占位**：每步含真实代码/命令/期望。
- **风险**：①ink 同步连键 stale state——已全程用 ref（铁律）。②`buildAnswers` 只收非空题——未答题不进 JSON（对齐 CC filter 语义）。③多选「其他」freeText 与 picks 并存——`selected` 同时含勾选 label 与 freeText，`Answer.freeText` 另置（formatAnswers 的 `other` 取之）。
