# 输入框附件：文本粘贴折叠 + 图片识别注入 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ①1:1 复刻 CC 的文本粘贴折叠（`[Pasted text #N]`/`[...Truncated text...]` + 发送时展开）；②拖图片文件/粘贴剪贴板截图 → 发送时 GLM-4.6v 识别 → 文字注入会话（不切会话模型）。

**Architecture:** 附件解析统一在 `send`（CC 式 submit 解析）：InputBox 只管「抓取→占位符+附件 map」，提交时把 `(displayText, attachments[])` 交给 `send`，`send` 先展开文本占位符、再对图片占位符调 `describeImage`（GLM-4.6v，带用户文本上下文），最后照走 `expandAtRefs`+`runTurn`。主流式管线（api.ts）不动（messages any[] 透传）。

**Tech Stack:** TypeScript / ESM / ink5 / OpenAI SDK（GLM OpenAI 兼容）/ vitest。

## Global Constraints

- **两阶段**：Phase 1（文本折叠 + 附件 threading 底座，Task 1-3，可独立 ship）；Phase 2（图片，Task 4-8）。
- **TUI 双组件铁律**：改 `onSubmit`/`submit` 接线，`src/tui/App.tsx` 与 `src/tui/FullscreenApp.tsx` **必须双改并都冒烟**。
- **文本部分 1:1 CC**（实读 bundle v2.1.76 确证）：折叠阈值 `>800字符 || >min(rows-10,2)换行`；整 buffer `>10000字符` 截断（头500+占位符+尾500，不丢内容）；占位符 `[Pasted text #N]`/`[Pasted text #N +M lines]`/`[...Truncated text #N +M lines...]`；提取正则 `/\[(Pasted text|\.\.\.Truncated text) #(\d+)(?: \+\d+ lines)?(\.)*\]/g`；普通 Backspace 整块删行尾占位符；发送时占位符内联展开回原文。
- **图片有意偏离 CC**（用户钦定）：不发原图 block、不切会话模型；GLM 侧识别→文字注入。GLM 视觉实读确证：`glm-4.6v`，OpenAI 兼容 `image_url` base64 data URL，端点同现有 GLM preset，≤5MB/≤5图/png-jpg。
- **id 计数器**：`useRef(1)`，文本/图片共享，单调不复用（submit 即解析，history 无占位符）。
- 用本地构建冒烟：`node /Users/silas/loop/deepcode/dist/index.js`。

---

## Phase 1 — 文本粘贴折叠 + 附件 threading 底座

### Task 1: `src/tui/pasteFold.ts`（纯逻辑）

**Files:** Create `src/tui/pasteFold.ts`；Test `test/pasteFold.test.ts`

**Interfaces — Produces:**
```ts
export interface TextEntry { id: number; type: 'text'; content: string }
export const PASTE_CHAR_THRESHOLD = 800
export const TRUNCATE_LIMIT = 10000
export const KEEP_HALF = 500
export function countNewlines(s: string): number
export function normalizePaste(s: string): string
export function newlineThreshold(rows: number): number
export function shouldFold(text: string, rows: number): boolean
export function makePlaceholder(id: number, lines: number): string
export function makeTruncatePlaceholder(id: number, lines: number): string
export function truncateBuffer(text: string, id: number): { newText: string; entry: TextEntry } | null
export const PLACEHOLDER_RE: RegExp
export function expandTextPlaceholders(text: string, map: Map<number, { content: string }>): string
export function stripTrailingPlaceholder(text: string): string | null
```

- [ ] **Step 1: 写失败测试** `test/pasteFold.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import {
  countNewlines, normalizePaste, newlineThreshold, shouldFold, makePlaceholder,
  makeTruncatePlaceholder, truncateBuffer, expandTextPlaceholders, stripTrailingPlaceholder,
} from '../src/tui/pasteFold.js'

describe('pasteFold', () => {
  it('countNewlines', () => { expect(countNewlines('a\nb\r\nc\rd')).toBe(3) })
  it('normalizePaste：\\r→\\n、tab→4空格、剥控制符留\\n', () => {
    expect(normalizePaste('a\tb\r\nc\x07')).toBe('a    b\nc')
  })
  it('newlineThreshold = min(rows-10,2)', () => {
    expect(newlineThreshold(24)).toBe(2); expect(newlineThreshold(11)).toBe(1)
  })
  it('shouldFold：>800字符 或 >阈值换行', () => {
    expect(shouldFold('x'.repeat(801), 24)).toBe(true)
    expect(shouldFold('x'.repeat(800), 24)).toBe(false)
    expect(shouldFold('\n\n\n', 24)).toBe(true)   // 3换行>2
    expect(shouldFold('\n\n', 24)).toBe(false)
  })
  it('makePlaceholder', () => {
    expect(makePlaceholder(1, 0)).toBe('[Pasted text #1]')
    expect(makePlaceholder(2, 5)).toBe('[Pasted text #2 +5 lines]')
  })
  it('truncateBuffer：≤10000 返回 null', () => { expect(truncateBuffer('x'.repeat(10000), 1)).toBeNull() })
  it('truncateBuffer：>10000 头500+占位符+尾500，中间存 entry', () => {
    const text = 'H'.repeat(500) + 'M\nM'.repeat(4000) + 'T'.repeat(500)
    const r = truncateBuffer(text, 7)!
    expect(r.newText.startsWith('H'.repeat(500))).toBe(true)
    expect(r.newText.endsWith('T'.repeat(500))).toBe(true)
    expect(r.newText).toContain('[...Truncated text #7 +')
    expect(r.entry.id).toBe(7)
    expect(r.entry.content.length).toBe(text.length - 1000)
  })
  it('expandTextPlaceholders：两类占位符→content', () => {
    const map = new Map([[1, { content: 'FULL1' }], [2, { content: 'MID2' }]])
    expect(expandTextPlaceholders('a [Pasted text #1] b [...Truncated text #2 +3 lines...] c', map))
      .toBe('a FULL1 b MID2 c')
  })
  it('expandTextPlaceholders：孤儿占位符（map无）原样留', () => {
    expect(expandTextPlaceholders('x [Pasted text #9] y', new Map())).toBe('x [Pasted text #9] y')
  })
  it('stripTrailingPlaceholder：行尾占位符整块删', () => {
    expect(stripTrailingPlaceholder('hi [Pasted text #1 +5 lines]')).toBe('hi ')
    expect(stripTrailingPlaceholder('hi there')).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — Run `npm test -- pasteFold` → FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/tui/pasteFold.ts`**

```ts
// src/tui/pasteFold.ts — 文本粘贴折叠（1:1 复刻 CC bundle v2.1.76）。纯逻辑。
export interface TextEntry { id: number; type: 'text'; content: string }

export const PASTE_CHAR_THRESHOLD = 800   // CC DG1
export const TRUNCATE_LIMIT = 10000        // CC qfz
export const KEEP_HALF = 500               // CC Rxq/2

export function countNewlines(s: string): number {
  return (s.match(/\r\n|\r|\n/g) || []).length
}
export function normalizePaste(s: string): string {
  return s.replace(/\r\n|\r/g, '\n').replace(/\t/g, '    ').replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '')
}
export function newlineThreshold(rows: number): number { return Math.min(rows - 10, 2) }
export function shouldFold(text: string, rows: number): boolean {
  return text.length > PASTE_CHAR_THRESHOLD || countNewlines(text) > newlineThreshold(rows)
}
export function makePlaceholder(id: number, lines: number): string {
  return lines === 0 ? `[Pasted text #${id}]` : `[Pasted text #${id} +${lines} lines]`
}
export function makeTruncatePlaceholder(id: number, lines: number): string {
  return `[...Truncated text #${id} +${lines} lines...]`
}
export function truncateBuffer(text: string, id: number): { newText: string; entry: TextEntry } | null {
  if (text.length <= TRUNCATE_LIMIT) return null
  const head = text.slice(0, KEEP_HALF)
  const tail = text.slice(-KEEP_HALF)
  const mid = text.slice(KEEP_HALF, -KEEP_HALF)
  const ph = makeTruncatePlaceholder(id, countNewlines(mid))
  return { newText: head + ph + tail, entry: { id, type: 'text', content: mid } }
}
export const PLACEHOLDER_RE = /\[(Pasted text|\.\.\.Truncated text) #(\d+)(?: \+\d+ lines)?(\.)*\]/g
export function expandTextPlaceholders(text: string, map: Map<number, { content: string }>): string {
  return text.replace(PLACEHOLDER_RE, (m, _kind, idStr) => {
    const e = map.get(Number(idStr))
    return e ? e.content : m
  })
}
const TRAILING_RE = /(^|\s)\[(Pasted text #\d+(?: \+\d+ lines)?|\.\.\.Truncated text #\d+ \+\d+ lines\.\.\.)\]$/
export function stripTrailingPlaceholder(text: string): string | null {
  const m = text.match(TRAILING_RE)
  if (!m) return null
  return text.slice(0, m.index! + m[1].length)
}
```

- [ ] **Step 4: 跑测试确认通过** — Run `npm test -- pasteFold` → PASS

- [ ] **Step 5: 提交**
```bash
git add src/tui/pasteFold.ts test/pasteFold.test.ts
git commit -m "feat(paste): 文本折叠纯逻辑模块（1:1 CC：折叠/截断/展开/删除）"
```

---

### Task 2: InputBox 折叠接线 + 附件 map

**Files:** Modify `src/tui/components/InputBox.tsx`；Test `test/inputbox.fold.test.tsx`

**Interfaces:**
- Consumes: pasteFold（Task 1）。
- Produces: `onSubmit` 签名变为 `(text: string, attachments?: Attachment[]) => void`；`onSteer` 同。`Attachment` 暂只 `TextEntry`（Phase 2 加 ImageEntry）。InputBox 内部 `attachMap: Map<number, Attachment>` + `nextId = useRef(1)`。

- [ ] **Step 1: 写失败测试** `test/inputbox.fold.test.tsx`

```tsx
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { InputBox } from '../src/tui/components/InputBox.js'

it('粘贴 >800 字符折叠成占位符，提交时回传完整原文', async () => {
  const onSubmit = vi.fn()
  const { stdin } = render(<InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={[]} busy={false} />)
  const big = 'x'.repeat(900)
  stdin.write(big)          // 模拟粘贴（ink 合并为单 input）
  await new Promise(r => setTimeout(r, 20))
  stdin.write('\r')         // 提交
  await new Promise(r => setTimeout(r, 20))
  expect(onSubmit).toHaveBeenCalledTimes(1)
  const [text, attachments] = onSubmit.mock.calls[0]
  expect(text).toMatch(/\[Pasted text #1\]/)         // 显示文本是占位符
  expect(attachments[0].content).toBe(big)            // 附件携带完整原文
})
```

- [ ] **Step 2: 跑测试确认失败** — Run `npm test -- inputbox.fold` → FAIL（无折叠/onSubmit 单参）

- [ ] **Step 3: 改 `src/tui/components/InputBox.tsx`**

import 加：
```ts
import { useStdout } from 'ink'
import {
  normalizePaste, shouldFold, makePlaceholder, countNewlines, truncateBuffer,
  stripTrailingPlaceholder, type TextEntry,
} from '../pasteFold.js'
```
（注：`useStdout` 与现有 `import { Box, Text, useInput } from 'ink'` 合并。）

props 类型：`onSubmit`/`onSteer` 改签名携带附件：
```ts
  onSubmit: (text: string, attachments?: TextEntry[]) => void
  onSteer?: (text: string, attachments?: TextEntry[]) => void
```

组件内加附件状态（其它现有 ref 旁）：
```ts
  const { stdout } = useStdout()
  const attachMap = useRef(new Map<number, TextEntry>())
  const nextId = useRef(1)
```

粘贴折叠——`if (input)` 分支（现 line 113-116）替换为：
```ts
    if (input) {
      const clean = normalizePaste(input)
      if (!clean) return
      const rows = stdout?.rows ?? 24
      if (shouldFold(clean, rows)) {
        const id = nextId.current++
        attachMap.current.set(id, { id, type: 'text', content: clean })
        setVal(valueRef.current + makePlaceholder(id, countNewlines(clean)))
      } else {
        setVal(valueRef.current + clean)
      }
    }
```

整 buffer 截断——加 effect（组件体内）：
```ts
  const truncatedOnce = useRef(false)
  useEffect(() => {
    if (value === '') { truncatedOnce.current = false; return }
    if (truncatedOnce.current) return
    const r = truncateBuffer(value, nextId.current)
    if (r) { nextId.current++; attachMap.current.set(r.entry.id, r.entry); truncatedOnce.current = true; setVal(r.newText) }
  }, [value])  // eslint-disable-line react-hooks/exhaustive-deps
```

占位符整块删——`key.backspace || key.delete` 分支（现 line 108-110）替换为：
```ts
    if (key.backspace || key.delete) {
      const stripped = stripTrailingPlaceholder(valueRef.current)
      setVal(stripped !== null ? stripped : valueRef.current.slice(0, -1))
      return
    }
```

提交——`key.return` 非 busy 分支：把 `props.onSubmit(full)` 改为传附件 + 提交后清 map：
```ts
      const attachments = [...attachMap.current.values()]
      if (props.busy) props.onSteer?.(full, attachments)
      else props.onSubmit(full, attachments)
      attachMap.current = new Map(); nextId.current = 1
```
（`full` 含占位符；展开在 `send` 做。空守卫 `if (!full.trim()) return` 保留在前——对显示文本判断，对齐 CC。）

- [ ] **Step 4: 跑测试 + InputBox 回归** — Run `npm test -- inputbox` → PASS

- [ ] **Step 5: 提交**
```bash
git add src/tui/components/InputBox.tsx test/inputbox.fold.test.tsx
git commit -m "feat(paste): InputBox 折叠+截断+占位符删除+附件 map（onSubmit 带附件）"
```

---

### Task 3: send 文本展开 + 双 App threading

**Files:** Modify `src/tui/useChat.ts`（`send` 签名 + 文本展开）、`src/tui/App.tsx:133`、`src/tui/FullscreenApp.tsx`（submit 包装）；Test `test/useChat.expand.test.ts`

**Interfaces:**
- Consumes: `expandTextPlaceholders`（Task 1）、InputBox 附件（Task 2）。
- Produces: `send(line: string, attachments?: TextEntry[]): Promise<void>`；`steer(text: string, attachments?: TextEntry[]): void`；纯函数 `expandTextAttachments` / `resolveAttachments`。

**🔑 steer 路径（CC 考古确证，2026-06-29）**：实读 CC bundle v2.1.76+v2.1.193 确认 **CC 在「消息入队前」统一展开占位符**——立即发送和排队消息都在进入 message queue 之前展开，队列里存的是**已展开的完整文本**（图片才把 metadata 带进队列）。deepcode 的 steer 是独立路径（`onSteer → core.steer → steerQueue.enqueue`），故**必须在 enqueue 前展开**才忠实 CC。Phase 1 文本展开是同步的，steer 保持**同步**（不引入 async，避免破坏既有 steering 测试对 `steerQueue` 的同步断言）。send 与 steer 共用同步 helper `expandTextAttachments`（DRY）。图片（Phase 2）异步 describeImage 仅在 send 路径；busy 态拖图属罕见，Phase 2 再定（默认不支持，占位符留作已知限制）。

- [ ] **Step 1: 写失败测试** `test/useChat.expand.test.ts`（直测抽出的纯函数）

```ts
import { describe, it, expect } from 'vitest'
import { resolveAttachments, expandTextAttachments } from '../src/tui/useChat.js'

describe('resolveAttachments / expandTextAttachments（文本部分）', () => {
  it('展开文本占位符为完整原文', async () => {
    const out = await resolveAttachments('看这段 [Pasted text #1] 谢谢', [{ id: 1, type: 'text', content: 'A\nB\nC' }])
    expect(out).toBe('看这段 A\nB\nC 谢谢')
  })
  it('无附件原样返回', async () => {
    expect(await resolveAttachments('hello', undefined)).toBe('hello')
  })
  it('expandTextAttachments 同步展开（steer 路径用）', () => {
    expect(expandTextAttachments('a [Pasted text #1] b', [{ id: 1, type: 'text', content: 'X\nY' }])).toBe('a X\nY b')
    expect(expandTextAttachments('a', undefined)).toBe('a')
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — Run `npm test -- useChat.expand` → FAIL（未导出）

- [ ] **Step 3: useChat 加 `expandTextAttachments`/`resolveAttachments` + 改 `send` 签名**

import 加：`import { expandTextPlaceholders, type TextEntry } from './pasteFold.js'`

新增导出（模块作用域，Phase 2 会在 `resolveAttachments` 追加图片异步分支）：
```ts
/** 同步展开文本占位符（不含图片）。send 与 steer 共用，保证「入队前展开」（CC）。 */
export function expandTextAttachments(text: string, attachments?: TextEntry[]): string {
  if (!attachments?.length) return text
  const textMap = new Map(
    attachments.filter(a => a.type === 'text').map(a => [a.id, { content: a.content }]),
  )
  return expandTextPlaceholders(text, textMap)
}

/** 把 displayText 里的附件占位符解析成最终文本。Phase 1：仅文本（同步）。Phase 2：在此追加图片异步分支。 */
export async function resolveAttachments(text: string, attachments?: TextEntry[]): Promise<string> {
  return expandTextAttachments(text, attachments)
}
```

`send` 签名（现 `useChat.ts:906` 附近，`const send = async (line: string): Promise<void> =>`）改为带附件，函数体最前先解析：
```ts
  const send = async (line: string, attachments?: TextEntry[]): Promise<void> => {
    line = await resolveAttachments(line, attachments)
    // …（其余命令解析/expandAtRefs/runTurn 不变，line 现已是展开后的完整文本）…
```

- [ ] **Step 3b: steer 入队前展开（CC：expand before enqueue）**

`ChatCore` interface（`useChat.ts:218`/`:220`）签名同步加附件：
```ts
  send(line: string, attachments?: TextEntry[]): Promise<void>
  steer(text: string, attachments?: TextEntry[]): void
```
`steer` 实现（现 `useChat.ts:1292`）入队前**同步**展开（软中断仍立即触发，保持转向手感）：
```ts
    steer: (text: string, attachments?: TextEntry[]) => {
      if (!text.trim()) return                                   // 空守卫对显示文本判断（对齐 CC）
      const resolved = expandTextAttachments(text, attachments)  // 入队前展开（CC：队列存完整文本）
      steerQueue.enqueue(resolved, 'next')
      if (toolsRunning > 0) abort.abort('interrupt')
    },
```
（`steerQueue.enqueue` 仍同步，既有 steering 测试不受影响。`steerPop` 返回的就是已展开文本，回填 InputBox 即完整原文，CC-equivalent。）

- [ ] **Step 4: App.tsx submit 透传**（`App.tsx:133` 的 `submit` + `InputBox` 的 `onSteer`）
```tsx
  const submit = (text: string, attachments?: import('../pasteFold.js').TextEntry[]) => {
    // …（现有 valueOverride/历史等逻辑保留）…
    void core.send(text, attachments)
  }
```
并把 `<InputBox onSteer={...}>`（`App.tsx:299`）改为透传附件：`onSteer={(t, a) => core.steer(t, a)}`。

- [ ] **Step 5: FullscreenApp.tsx submit + onSteer 透传**（镜像 App.tsx：`submit` 包装传 attachments 给 `core.send`（`FullscreenApp.tsx:148`）+ `onSteer`（`FullscreenApp.tsx:327`）透传附件给 `core.steer`）。**TUI 双组件铁律：两处都改。**

- [ ] **Step 6: 构建 + 测试** — Run `npm run build && npm test -- useChat.expand inputbox` → PASS / tsc 无错

- [ ] **Step 7: 提交**
```bash
git add src/tui/useChat.ts src/tui/App.tsx src/tui/FullscreenApp.tsx test/useChat.expand.test.ts
git commit -m "feat(paste): send 解析附件占位符 + 双 App threading（文本展开）"
```

> **Phase 1 完成 = 文本折叠可独立 ship。** 真机冒烟（Phase 1 部分）：粘贴 >800字符/多行 → 折成 `[Pasted text #N]`；Backspace 整块删；提交后模型收到完整原文；粘 >10000 字符 → `[...Truncated text...]`。

---

## Phase 2 — 图片识别注入

### Task 4: providers.ts glm-4.6v + supportsVision

**Files:** Modify `src/providers.ts`；Test `test/providers.vision.test.ts`

- [ ] **Step 1: 写失败测试** `test/providers.vision.test.ts`
```ts
import { describe, it, expect } from 'vitest'
import { BUILTIN_PROVIDERS } from '../src/providers.js'
describe('GLM 视觉模型', () => {
  it('收录 glm-4.6v + supportsVision', () => {
    const m = BUILTIN_PROVIDERS.glm.meta['glm-4.6v']
    expect(m).toBeDefined()
    expect(m.supportsVision).toBe(true)
    expect(m.contextWindow).toBe(128_000)
  })
})
```

- [ ] **Step 2: 确认失败** — Run `npm test -- providers.vision` → FAIL

- [ ] **Step 3: 改 `src/providers.ts`**

`ModelMeta` 接口加（line 7-13 内）：
```ts
  supportsVision?: boolean
```
GLM `meta`（line 63-72 内）加两档：
```ts
      'glm-4.6v': { hit: 1, miss: 1, out: 3, contextWindow: 128_000, supportsThinking: true, supportsVision: true },
      'glm-4.6v-flash': { hit: 0, miss: 0, out: 0, contextWindow: 128_000, supportsThinking: true, supportsVision: true },
```

- [ ] **Step 4: 确认通过** — Run `npm test -- providers.vision` → PASS

- [ ] **Step 5: 提交**
```bash
git add src/providers.ts test/providers.vision.test.ts
git commit -m "feat(vision): providers 加 glm-4.6v/-flash + ModelMeta.supportsVision"
```

---

### Task 5: `src/imageDescribe.ts`（GLM 视觉识别）

**Files:** Create `src/imageDescribe.ts`；Test `test/imageDescribe.test.ts`

**Interfaces — Produces:**
```ts
export interface ImageInput { base64: string; mime: string }
/** 直连 GLM 视觉识别。无 GLM key → 抛 GlmKeyMissingError。 */
export async function describeImage(img: ImageInput, userText: string, deps?: { client?: any; model?: string }): Promise<string>
export class GlmKeyMissingError extends Error {}
```

- [ ] **Step 1: 写失败测试** `test/imageDescribe.test.ts`（注入 fake client，不打真实网络）
```ts
import { describe, it, expect } from 'vitest'
import { describeImage } from '../src/imageDescribe.js'

it('拼多模态请求并返回识别文字', async () => {
  let captured: any
  const fakeClient = { chat: { completions: { create: async (req: any) => { captured = req; return { choices: [{ message: { content: '识别结果X' } }] } } } } }
  const out = await describeImage({ base64: 'AAAA', mime: 'image/png' }, '这报错怎么解决', { client: fakeClient, model: 'glm-4.6v' })
  expect(out).toBe('识别结果X')
  expect(captured.model).toBe('glm-4.6v')
  const content = captured.messages[0].content
  expect(content.find((p: any) => p.type === 'image_url').image_url.url).toBe('data:image/png;base64,AAAA')
  expect(content.find((p: any) => p.type === 'text').text).toContain('这报错怎么解决')
})
```

- [ ] **Step 2: 确认失败** — Run `npm test -- imageDescribe` → FAIL

- [ ] **Step 3: 实现 `src/imageDescribe.ts`**
```ts
// src/imageDescribe.ts — 拖/粘贴图片 → 调 GLM-4.6v 视觉识别 → 文字（与 active provider 解耦）。
import OpenAI from 'openai'
import { loadSettings } from './config.js'
import { BUILTIN_PROVIDERS } from './providers.js'

export interface ImageInput { base64: string; mime: string }
export class GlmKeyMissingError extends Error {
  constructor() { super('未配置 GLM key'); this.name = 'GlmKeyMissingError' }
}

const PROMPT = '结合用户的问题，转写并提取图中与问题相关的文字与关键信息；若是代码/报错/UI 截图，逐字转写关键文本，不要泛泛描述。'

function glmClient(): OpenAI {
  const settings = loadSettings()
  const glm = BUILTIN_PROVIDERS.glm
  const key = process.env[glm.apiKeyEnv] ?? (settings.providers as any)?.glm?.apiKey
  if (!key) throw new GlmKeyMissingError()
  return new OpenAI({ apiKey: key, baseURL: glm.baseURL, maxRetries: 0 })
}

export async function describeImage(
  img: ImageInput, userText: string, deps: { client?: any; model?: string } = {},
): Promise<string> {
  const client = deps.client ?? glmClient()
  const model = deps.model ?? 'glm-4.6v'
  const res = await client.chat.completions.create({
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `${PROMPT}\n\n用户的问题：${userText || '(无)'}` },
        { type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } },
      ],
    }],
    stream: false,
  })
  return res.choices?.[0]?.message?.content ?? ''
}
```

- [ ] **Step 4: 确认通过** — Run `npm test -- imageDescribe` → PASS

- [ ] **Step 5: 提交**
```bash
git add src/imageDescribe.ts test/imageDescribe.test.ts
git commit -m "feat(vision): describeImage — 直连 GLM-4.6v 识别图片为文字"
```

---

### Task 6: `src/clipboardImage.ts`（剪贴板/文件读图）

**Files:** Create `src/clipboardImage.ts`；Test `test/clipboardImage.test.ts`

**Interfaces — Produces:**
```ts
export const IMAGE_EXT_RE: RegExp                       // /\.(png|jpe?g)$/i
export const MAX_IMAGE_BYTES: number                     // 5*1024*1024
export function mimeForPath(p: string): string | null    // png→image/png, jpg/jpeg→image/jpeg, 否则 null
export function readImageFile(p: string): { base64: string; mime: string } | null  // 存在+格式+≤5MB 才返回
export function readClipboardImage(): { base64: string; mime: string } | null      // mac osascript→PNG；其它平台/无图→null
```

- [ ] **Step 1: 写失败测试** `test/clipboardImage.test.ts`（文件读取用临时 PNG；剪贴板仅测纯函数）
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { IMAGE_EXT_RE, mimeForPath, readImageFile } from '../src/clipboardImage.js'

describe('clipboardImage', () => {
  it('IMAGE_EXT_RE / mimeForPath', () => {
    expect(IMAGE_EXT_RE.test('a.png')).toBe(true); expect(IMAGE_EXT_RE.test('a.gif')).toBe(false)
    expect(mimeForPath('x.jpeg')).toBe('image/jpeg'); expect(mimeForPath('x.txt')).toBeNull()
  })
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-img-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
  it('readImageFile：小 PNG 读出 base64', () => {
    const f = path.join(dir, 'a.png'); fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const r = readImageFile(f)!; expect(r.mime).toBe('image/png'); expect(r.base64).toBe('iVBORw==')
  })
  it('readImageFile：非图/不存在→null', () => {
    expect(readImageFile(path.join(dir, 'a.txt'))).toBeNull()
    expect(readImageFile(path.join(dir, 'nope.png'))).toBeNull()
  })
})
```

- [ ] **Step 2: 确认失败** — Run `npm test -- clipboardImage` → FAIL

- [ ] **Step 3: 实现 `src/clipboardImage.ts`**
```ts
// src/clipboardImage.ts — 拖入图片文件 / 剪贴板截图 读为 base64（mac 优先）。
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

export const IMAGE_EXT_RE = /\.(png|jpe?g)$/i
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export function mimeForPath(p: string): string | null {
  const ext = p.toLowerCase().match(IMAGE_EXT_RE)?.[1]
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  return null
}
export function readImageFile(p: string): { base64: string; mime: string } | null {
  const mime = mimeForPath(p)
  if (!mime) return null
  try {
    const st = fs.statSync(p)
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return null
    return { base64: fs.readFileSync(p).toString('base64'), mime }
  } catch { return null }
}
/** mac：用 osascript 把剪贴板 PNG 写临时文件再读。非 mac / 无图 → null。 */
export function readClipboardImage(): { base64: string; mime: string } | null {
  if (process.platform !== 'darwin') return null
  const tmp = path.join(os.tmpdir(), `dc-clip-${process.pid}.png`)
  try {
    execFileSync('osascript', ['-e',
      `set png to (the clipboard as «class PNGf»)`,
      '-e', `set fp to open for access POSIX file "${tmp}" with write permission`,
      '-e', `write png to fp`, '-e', `close access fp`,
    ], { stdio: ['ignore', 'ignore', 'ignore'] })
    const r = readImageFile(tmp)
    return r
  } catch { return null } finally { try { fs.unlinkSync(tmp) } catch { /* 忽略 */ } }
}
```

- [ ] **Step 4: 确认通过** — Run `npm test -- clipboardImage` → PASS

- [ ] **Step 5: 提交**
```bash
git add src/clipboardImage.ts test/clipboardImage.test.ts
git commit -m "feat(vision): clipboardImage — 拖图片文件/剪贴板截图读 base64（mac）"
```

---

### Task 7: InputBox 图片抓取

**Files:** Modify `src/tui/components/InputBox.tsx`；Test `test/inputbox.image.test.tsx`

**Interfaces:**
- Consumes: clipboardImage（Task 6）。
- Produces: `ImageEntry = { id; type:'image'; base64; mime; source:'file'|'clipboard' }`；`Attachment = TextEntry | ImageEntry`（attachMap/onSubmit 泛化）。`[Image #N]` 占位符。

- [ ] **Step 1: 写失败测试** `test/inputbox.image.test.tsx`
```tsx
import { describe, it, expect, vi } from 'vitest'
import React from 'react'; import { render } from 'ink-testing-library'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { InputBox } from '../src/tui/components/InputBox.js'

it('拖入图片文件路径 → [Image #N] + 附件携带 base64', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-ib-'))
  const f = path.join(dir, 'shot.png'); fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const onSubmit = vi.fn()
  const { stdin } = render(<InputBox onSubmit={onSubmit} onInterrupt={() => {}} history={[]} busy={false} />)
  stdin.write(`'${f}'`)            // 终端拖文件粘的带引号路径
  await new Promise(r => setTimeout(r, 20)); stdin.write('\r'); await new Promise(r => setTimeout(r, 20))
  const [text, attachments] = onSubmit.mock.calls[0]
  expect(text).toMatch(/\[Image #1\]/)
  expect(attachments[0]).toMatchObject({ type: 'image', mime: 'image/png', source: 'file' })
  fs.rmSync(dir, { recursive: true, force: true })
})
```

- [ ] **Step 2: 确认失败** — Run `npm test -- inputbox.image` → FAIL

- [ ] **Step 3: 改 InputBox**

import 加：`import { readImageFile, readClipboardImage, IMAGE_EXT_RE } from '../clipboardImage.js'`。定义 `ImageEntry`/`Attachment` 类型（或从 pasteFold/新类型文件导出），`attachMap`/`onSubmit`/`onSteer` 泛型改 `Attachment`。

粘贴分支（Task 2 的 `if (input)` 块）**最前面**加图片检测（先于文本折叠）：
```ts
      // 图片：拖入的图片文件路径（去引号）
      const trimmed = input.trim().replace(/^['"]|['"]$/g, '').replace(/\\ /g, ' ')
      if (IMAGE_EXT_RE.test(trimmed)) {
        const img = readImageFile(trimmed)
        if (img) {
          const id = nextId.current++
          attachMap.current.set(id, { id, type: 'image', ...img, source: 'file' })
          setVal(valueRef.current + `[Image #${id}]`)
          return
        }
      }
      // 剪贴板截图：单字符触发键无意义；此处仅文件路径走上面。剪贴板图走专用键，见下。
```
剪贴板截图触发：因终端 Cmd+V 不传图字节，加一个显式读剪贴板的路径——在 `if (input)` 之外，当收到普通可见字符且 `readClipboardImage()` 命中时不抢占文本（避免每次按键调 osascript）。**实现取舍**：仅在「粘贴突发（input.length>1）且文本不像路径/普通文本、同时剪贴板有图」时尝试，或绑定一个键（如 Ctrl+V）显式贴图。本任务**采用显式键**：`key.ctrl && input==='v'` → `readClipboardImage()` 命中则插 `[Image #N]`：
```ts
    if (key.ctrl && input === 'v') {
      const img = readClipboardImage()
      if (img) {
        const id = nextId.current++
        attachMap.current.set(id, { id, type: 'image', ...img, source: 'clipboard' })
        setVal(valueRef.current + `[Image #${id}]`)
      }
      return
    }
```
（放在 `key.ctrl || key.meta || key.tab` 早返回之前。）

- [ ] **Step 4: 确认通过 + 回归** — Run `npm test -- inputbox` → PASS

- [ ] **Step 5: 提交**
```bash
git add src/tui/components/InputBox.tsx test/inputbox.image.test.tsx
git commit -m "feat(vision): InputBox 图片抓取（拖文件 + Ctrl+V 贴剪贴板截图 → [Image #N]）"
```

---

### Task 8: send 图片识别编排

**Files:** Modify `src/tui/useChat.ts`（`resolveAttachments` 加图片分支 + 工具步显示）；Test 扩展 `test/useChat.expand.test.ts`

**Interfaces:**
- Consumes: `describeImage`（Task 5）、ImageEntry（Task 7）。
- Produces: `resolveAttachments` 处理 `[Image #N]` → describeImage → `<图片#N 识别(glm-4.6v)>…</图片#N>`。

- [ ] **Step 1: 追加失败测试**
```ts
import { resolveAttachments } from '../src/tui/useChat.js'
it('图片占位符 → describeImage 注入', async () => {
  const fakeDescribe = async () => '报错是 NPE，第12行空指针'
  const out = await resolveAttachments('这报错？ [Image #1]', [{ id: 1, type: 'image', base64: 'A', mime: 'image/png', source: 'file' }], { describe: fakeDescribe })
  expect(out).toContain('<图片#1 识别(glm-4.6v)>报错是 NPE，第12行空指针</图片#1>')
  expect(out).not.toContain('[Image #1]')
})
```

- [ ] **Step 2: 确认失败** — Run `npm test -- useChat.expand` → FAIL

- [ ] **Step 3: 扩展 `resolveAttachments`**（useChat.ts）

import 加：`import { describeImage, GlmKeyMissingError } from '../imageDescribe.js'`

```ts
export async function resolveAttachments(
  text: string,
  attachments?: Attachment[],
  deps: { describe?: typeof describeImage; onStep?: (id: number) => void; onError?: (msg: string) => void } = {},
): Promise<string> {
  if (!attachments?.length) return text
  // 1) 文本占位符内联展开
  const textMap = new Map(attachments.filter(a => a.type === 'text').map(a => [a.id, { content: (a as TextEntry).content }]))
  let out = expandTextPlaceholders(text, textMap)
  // 2) 图片占位符 → describeImage 注入
  const describe = deps.describe ?? describeImage
  const userText = expandTextPlaceholders(text, textMap).replace(/\[Image #\d+\]/g, '').trim()
  for (const a of attachments) {
    if (a.type !== 'image') continue
    const img = a as ImageEntry
    deps.onStep?.(img.id)
    let injected: string
    try {
      const desc = await describe({ base64: img.base64, mime: img.mime }, userText)
      injected = `<图片#${img.id} 识别(glm-4.6v)>${desc}</图片#${img.id}>`
    } catch (e) {
      const reason = e instanceof GlmKeyMissingError ? '未配置 GLM key' : '识别失败'
      deps.onError?.(reason)
      injected = `<图片#${img.id} 无法识别：${reason}>`
    }
    out = out.replace(`[Image #${img.id}]`, injected)
  }
  return out
}
```
`send` 调用处接入工具步显示 + 错误 notice：
```ts
    line = await resolveAttachments(line, attachments, {
      onStep: id => pushTranscript({ kind: 'tool', name: '识别图片', desc: `#${id} · glm-4.6v`, running: false, ok: true }),
      onError: msg => notice('warn', msg),
    })
```
（`pushTranscript`/`notice` 用 useChat 现有等价 API；工具步用既有 tool transcript item 结构。）

- [ ] **Step 4: 确认通过 + 全测** — Run `npm run build && npm test` → PASS / tsc 无错

- [ ] **Step 5: 提交**
```bash
git add src/tui/useChat.ts test/useChat.expand.test.ts
git commit -m "feat(vision): send 编排图片识别注入（describeImage + 工具步 + 降级）"
```

---

## 真机冒烟（合并前，碰 TUI 双组件）

> `node /Users/silas/loop/deepcode/dist/index.js`（默认全屏 FullscreenApp；另 `--inline` 验 App）。

1. **文本折叠**：粘 >800字符/多行 → `[Pasted text #N]`；Backspace 整块删；提交后模型收完整原文（看回答引用了原文细节）。
2. **整 buffer 截断**：粘 >10000 字符 → `[...Truncated text #N +M lines...]`，提交后完整发送。
3. **拖图片文件**：把 .png/.jpg 拖进输入框 → `[Image #1]`；问「这图里报错怎么解决」提交 → 见 `⏺ 识别图片 #1 · glm-4.6v` → 回答基于图中文字。
4. **剪贴板截图**：截图后 Ctrl+V → `[Image #N]` → 同上。
5. **无 GLM key**：临时移除 GLM key → 拖图提交 → 提示「未配置 GLM key」+ 占位符降级，主消息仍发。
6. **DeepSeek 主模型下图片可用**（核心价值）：active=deepseek 时拖图仍经 GLM 识别注入，DeepSeek 基于文字回答。
7. 截图回传：文本折叠、截断、拖图识别、Ctrl+V、无 key 降级。

---

## Self-Review
- **Spec 覆盖**：文本折叠（T1-3，1:1 CC 阈值/占位符/截断/删除/展开）✅；图片（T4 providers / T5 describeImage / T6 抓取 / T7 InputBox / T8 send 编排，含工具步+无 key 降级）✅；双 App threading（T3/T7）✅。
- **对 spec 的细化（已在计划显式）**：①文本占位符展开从「InputBox 内」移到 `send` 的 `resolveAttachments`（与图片统一一个解析点，更 CC-like；InputBox 只管抓取+map）②剪贴板截图用**显式 Ctrl+V**触发（终端 Cmd+V 不传图字节，避免每键调 osascript 的性能/越权问题）——属实现取舍，spec「粘贴剪贴板截图」语义不变。
- **占位符/类型一致性**：`Attachment=TextEntry|ImageEntry` 贯穿 InputBox/onSubmit/send/resolveAttachments；`[Pasted text #N]`/`[...Truncated...]`/`[Image #N]` 三类占位符各有解析路；`describeImage` 注入 deps 便于测试。
- **范围**：主流式 api.ts 不动（messages any[] 透传）；paste-cache 不做；图片 ≤5MB/png-jpg/Ctrl+V。
