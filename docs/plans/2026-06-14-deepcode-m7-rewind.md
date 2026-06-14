# /rewind 实现计划（M7②）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 deepcode 加 `/rewind`——CC 式"后悔药"：列出每个 user 轮次为还原点，选轮 + 选三模式（仅对话/仅代码/两者），把文件还原到该轮开始时的内容（该轮起新建的文件删除）和/或截断对话历史。before-image 落盘持久化，resume 后仍可用。

**Architecture:** 新 `Checkpointer`（`src/checkpoint.ts`）落盘 before-image（index.jsonl + blob，cap 100 FIFO）。Edit/Write 写盘前经 `ToolContext.recordBeforeImage?` 钩子捕获。锚点 = **稳定单调 `turnId`**，持久化进 user 消息记录 `{t:'msg',m,turn}`，并以 `WeakMap<msgObj,turnId>` 在内存追踪（跨 compact 存活，因 `rebuildMessages` 用 `slice` 保留消息引用）。`/rewind` 由 App 两步 `SelectList` 驱动（镜像 `resumeMode`），调 useChat 的 `rewindList()`/`rewind(toTurnId, mode)`。

**Tech Stack:** TypeScript ESM、Node fs、ink 5、React 18、vitest、ink-testing-library。

**设计依据：** `docs/specs/2026-06-14-deepcode-m7-rewind-design.md`。CC 机制实读 `/Users/silas/Desktop/src`（before-image checkpoints，非影子 git）。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/checkpoint.ts` | 建 | `Checkpointer`：capture/restoreFiles/fileCountAt + 落盘 blob/index + cap 100 FIFO（纯逻辑，临时目录单测） |
| `src/tools/types.ts` | 改 | `ToolContext` 加 `recordBeforeImage?(absPath): void` |
| `src/tools/edit.ts` | 改 | `fs.writeFileSync` 前 `ctx.recordBeforeImage?.(p)` |
| `src/tools/write.ts` | 改 | `fs.writeFileSync` 前 `ctx.recordBeforeImage?.(p)` |
| `src/session.ts` | 改 | `appendMessage(m, turn?)` 写 `{t:'msg',m,turn}`；`appendRewind(toTurnId)`；`loadSession` 处理 `{t:'rewind'}` 截断 + 返回 `messageTurnIds`/`maxTurnId` |
| `src/tui/useChat.ts` | 改 | 建 Checkpointer + `nextTurnId`/`currentTurnId` + `WeakMap` 锚点 + 注入 `recordBeforeImage` + `rewindList()`/`rewind()` + ChatCore 扩展 |
| `src/tui/App.tsx` | 改 | `/rewind` 两步 SelectList（点→模式） |
| `src/commands.ts` | 改 | HELP_TEXT 加 `/rewind` |

**不碰：** loop.ts、permissions、各只读工具、headless（不注入 recordBeforeImage，天然无 checkpoints）。

---

## Task 1: Checkpointer 落盘 before-image 存储

**Files:**
- Create: `src/checkpoint.ts`, `test/checkpoint.test.ts`

- [ ] **Step 1: 写失败测试** `test/checkpoint.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCheckpointer } from '../src/checkpoint.js'

let store: string, work: string
beforeEach(() => {
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-ckpt-'))
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-work-'))
})
afterEach(() => {
  fs.rmSync(store, { recursive: true, force: true })
  fs.rmSync(work, { recursive: true, force: true })
})
const f = (name: string) => path.join(work, name)

describe('Checkpointer', () => {
  it('capture 当轮去重：同 (turn,path) 只存首次（本轮开始内容）', () => {
    const cp = createCheckpointer(store)
    fs.writeFileSync(f('a.txt'), 'v1')
    cp.capture(f('a.txt'), 1)
    fs.writeFileSync(f('a.txt'), 'v2')
    cp.capture(f('a.txt'), 1)   // 同轮二次 → 跳过
    cp.restoreFiles(1)
    expect(fs.readFileSync(f('a.txt'), 'utf8')).toBe('v1')  // 还原到本轮开始 v1
  })

  it('restoreFiles 取"最早 ≥ T"快照', () => {
    const cp = createCheckpointer(store)
    fs.writeFileSync(f('a.txt'), 'turn1-start')
    cp.capture(f('a.txt'), 1)
    fs.writeFileSync(f('a.txt'), 'turn3-start')
    cp.capture(f('a.txt'), 3)
    fs.writeFileSync(f('a.txt'), 'latest')
    // 还原到 T=2：a.txt 在 turn>=2 的最早快照是 turn3 的 before-image = 'turn3-start'
    cp.restoreFiles(2)
    expect(fs.readFileSync(f('a.txt'), 'utf8')).toBe('turn3-start')
  })

  it('墓碑：本轮新建的文件，还原时删除', () => {
    const cp = createCheckpointer(store)
    cp.capture(f('new.txt'), 2)              // 捕获时文件不存在 → absent 墓碑
    fs.writeFileSync(f('new.txt'), 'created')
    cp.restoreFiles(2)
    expect(fs.existsSync(f('new.txt'))).toBe(false)
  })

  it('turn >= T 无快照的文件不动', () => {
    const cp = createCheckpointer(store)
    fs.writeFileSync(f('a.txt'), 'a-orig')
    cp.capture(f('a.txt'), 1)
    fs.writeFileSync(f('b.txt'), 'b-untouched')  // 从未 capture
    cp.restoreFiles(1)
    expect(fs.readFileSync(f('b.txt'), 'utf8')).toBe('b-untouched')
  })

  it('fileCountAt：某轮捕获的不同 path 数', () => {
    const cp = createCheckpointer(store)
    fs.writeFileSync(f('a.txt'), 'a'); cp.capture(f('a.txt'), 5)
    fs.writeFileSync(f('b.txt'), 'b'); cp.capture(f('b.txt'), 5)
    cp.capture(f('a.txt'), 5)  // 去重不重复计
    expect(cp.fileCountAt(5)).toBe(2)
    expect(cp.fileCountAt(9)).toBe(0)
  })

  it('落盘 + 重载：新实例从 index 复原可还原', () => {
    const cp1 = createCheckpointer(store)
    fs.writeFileSync(f('a.txt'), 'persisted-v1')
    cp1.capture(f('a.txt'), 1)
    fs.writeFileSync(f('a.txt'), 'changed')
    const cp2 = createCheckpointer(store)   // 重新打开同目录
    cp2.restoreFiles(1)
    expect(fs.readFileSync(f('a.txt'), 'utf8')).toBe('persisted-v1')
  })

  it('cap：超上限 FIFO 淘汰最旧条目', () => {
    const cp = createCheckpointer(store, 2)   // cap=2
    fs.writeFileSync(f('a.txt'), 'a'); cp.capture(f('a.txt'), 1)
    fs.writeFileSync(f('b.txt'), 'b'); cp.capture(f('b.txt'), 2)
    fs.writeFileSync(f('c.txt'), 'c'); cp.capture(f('c.txt'), 3)  // 淘汰 (1,a)
    fs.writeFileSync(f('a.txt'), 'a-new')
    cp.restoreFiles(1)
    // (1,a) 已淘汰 → a.txt 在 turn>=1 已无快照 → 不还原，保持 a-new
    expect(fs.readFileSync(f('a.txt'), 'utf8')).toBe('a-new')
    // (3,c) 仍在 → 可还原（先改再还原验证）
    fs.writeFileSync(f('c.txt'), 'c-changed')
    cp.restoreFiles(3)
    expect(fs.readFileSync(f('c.txt'), 'utf8')).toBe('c')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/checkpoint.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写** `src/checkpoint.ts`:

```ts
// src/checkpoint.ts
// CC 式 before-image 文件备份：Edit/Write 前把文件原内容（或"不存在"墓碑）按 turnId 存盘。
// /rewind 据此把文件还原到某轮开始时的状态。落盘 index.jsonl + 内容寻址 blob，cap 上限 FIFO 淘汰。
// 纯逻辑（fs 直用），无 React/ink 依赖。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

interface Entry { turn: number; path: string; kind: 'content' | 'absent'; blob?: string }

export interface RestoreResult { restored: string[]; deleted: string[]; failed: string[] }

export interface Checkpointer {
  /** Edit/Write 写盘前调：捕获 absPath 在本轮开始时的内容（同 (turn,path) 去重，只存首次）。 */
  capture(absPath: string, turn: number): void
  /** 还原到"第 toTurn 轮之前"：每个有快照的 path 取其 turn>=toTurn 的最早快照写回/删除。 */
  restoreFiles(toTurn: number): RestoreResult
  /** 某轮恰好捕获的不同 path 数（rewindList 预览"N 文件改动"）。 */
  fileCountAt(turn: number): number
}

export function createCheckpointer(storeDir: string, cap = 100): Checkpointer {
  const indexFile = path.join(storeDir, 'index.jsonl')
  const blobDir = path.join(storeDir, 'blobs')
  let entries: Entry[] = []

  // 重载已有 index（resume 后 /rewind 可用）
  try {
    for (const line of fs.readFileSync(indexFile, 'utf8').split('\n')) {
      if (!line) continue
      try { entries.push(JSON.parse(line)) } catch { /* 跳过损坏行 */ }
    }
  } catch { /* 首次，无 index */ }

  const persist = () => {
    fs.mkdirSync(storeDir, { recursive: true })
    fs.writeFileSync(indexFile, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''))
  }

  // cap：超上限 FIFO 淘汰最旧，并删不再被引用的 blob
  const enforceCap = () => {
    if (entries.length <= cap) return
    const dropped = entries.splice(0, entries.length - cap)
    const live = new Set(entries.filter(e => e.blob).map(e => e.blob!))
    for (const e of dropped) {
      if (e.blob && !live.has(e.blob)) {
        try { fs.rmSync(path.join(blobDir, e.blob)) } catch { /* 已不在 */ }
      }
    }
  }

  return {
    capture(absPath, turn) {
      if (entries.some(e => e.turn === turn && e.path === absPath)) return  // 当轮去重
      let entry: Entry
      if (fs.existsSync(absPath)) {
        const buf = fs.readFileSync(absPath)
        const hash = crypto.createHash('sha1').update(buf).digest('hex')
        fs.mkdirSync(blobDir, { recursive: true })
        const blobPath = path.join(blobDir, hash)
        if (!fs.existsSync(blobPath)) fs.writeFileSync(blobPath, buf)  // 内容寻址去重
        entry = { turn, path: absPath, kind: 'content', blob: hash }
      } else {
        entry = { turn, path: absPath, kind: 'absent' }
      }
      entries.push(entry)
      enforceCap()
      persist()
    },

    restoreFiles(toTurn) {
      const result: RestoreResult = { restored: [], deleted: [], failed: [] }
      const byPath = new Map<string, Entry>()
      for (const e of entries) {
        if (e.turn < toTurn) continue
        const cur = byPath.get(e.path)
        if (!cur || e.turn < cur.turn) byPath.set(e.path, e)  // 取最早 ≥ toTurn
      }
      for (const e of byPath.values()) {
        try {
          if (e.kind === 'absent') {
            if (fs.existsSync(e.path)) { fs.rmSync(e.path); result.deleted.push(e.path) }
          } else {
            const buf = fs.readFileSync(path.join(blobDir, e.blob!))
            fs.mkdirSync(path.dirname(e.path), { recursive: true })
            fs.writeFileSync(e.path, buf)
            result.restored.push(e.path)
          }
        } catch { result.failed.push(e.path) }
      }
      return result
    },

    fileCountAt(turn) {
      const paths = new Set<string>()
      for (const e of entries) if (e.turn === turn) paths.add(e.path)
      return paths.size
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/checkpoint.test.ts`
Expected: PASS（7 用例）

- [ ] **Step 5: typecheck + 提交**

Run: `npm run typecheck`
```bash
git add src/checkpoint.ts test/checkpoint.test.ts
git commit -m "feat(M7②): Checkpointer 落盘 before-image 存储（capture/restoreFiles/fileCountAt + cap FIFO)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: session.ts —— turnId 持久化 + rewind 截断

`appendMessage` 加可选 `turn`（仅 user 消息带）；新增 `appendRewind`；`loadSession` 读 `turn`、处理 `{t:'rewind'}` 截断、返回 `messageTurnIds`/`maxTurnId`。

**Files:**
- Modify: `src/session.ts`
- Test: `test/session.rewind.test.ts`（创建）

- [ ] **Step 1: 写失败测试** `test/session.rewind.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { newSession, loadSession } from '../src/session.js'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-sess-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('session turnId + rewind', () => {
  it('appendMessage 带 turn → loadSession 还原 messageTurnIds 与 maxTurnId', () => {
    const s = newSession({ cwd: '/x', model: 'm', thinking: false, permMode: 'default' }, dir)
    s.appendMessage({ role: 'user', content: 'q1' }, 1)
    s.appendMessage({ role: 'assistant', content: 'a1' })
    s.appendMessage({ role: 'user', content: 'q2' }, 2)
    const loaded = loadSession(s.file)
    // messages：system 首条 + q1 + a1 + q2（loadSession 自动含/不含 system 视实现；这里断言 user 的 turnId）
    const userIdx = loaded.messages.map((m, i) => [m, i] as const).filter(([m]) => m.role === 'user')
    expect(loaded.messageTurnIds[loaded.messages.indexOf(userIdx[0][0])]).toBe(1)
    expect(loaded.messageTurnIds[loaded.messages.indexOf(userIdx[1][0])]).toBe(2)
    expect(loaded.maxTurnId).toBe(2)
  })

  it('appendRewind 截断：丢弃 turnId>=toTurnId 的 user 消息及其后', () => {
    const s = newSession({ cwd: '/x', model: 'm', thinking: false, permMode: 'default' }, dir)
    s.appendMessage({ role: 'user', content: 'q1' }, 1)
    s.appendMessage({ role: 'assistant', content: 'a1' })
    s.appendMessage({ role: 'user', content: 'q2' }, 2)
    s.appendMessage({ role: 'assistant', content: 'a2' })
    s.appendRewind(2)                       // 回退到第 2 轮之前
    const loaded = loadSession(s.file)
    const contents = loaded.messages.map(m => m.content)
    expect(contents).toContain('q1')
    expect(contents).toContain('a1')
    expect(contents).not.toContain('q2')    // 第 2 轮及之后被截
    expect(contents).not.toContain('a2')
    expect(loaded.maxTurnId).toBe(2)        // maxTurnId 不回退（turnId 单调，2 已作废）
  })

  it('截断后续写新轮：turnId 取更大号（不复用 2）', () => {
    const s = newSession({ cwd: '/x', model: 'm', thinking: false, permMode: 'default' }, dir)
    s.appendMessage({ role: 'user', content: 'q1' }, 1)
    s.appendMessage({ role: 'user', content: 'q2' }, 2)
    s.appendRewind(2)
    s.appendMessage({ role: 'user', content: 'q3' }, 3)   // 续写用 3
    const loaded = loadSession(s.file)
    const contents = loaded.messages.map(m => m.content)
    expect(contents).toContain('q1')
    expect(contents).not.toContain('q2')
    expect(contents).toContain('q3')
    expect(loaded.maxTurnId).toBe(3)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/session.rewind.test.ts`
Expected: FAIL（`appendRewind`/`messageTurnIds`/`maxTurnId` 不存在）

- [ ] **Step 3: 改 `src/session.ts`**

3a. `SessionHandle` 接口（约 18-25 行）：把 `appendMessage` 签名改为带可选 turn，并加 `appendRewind`：
```ts
export interface SessionHandle {
  file: string
  appendMessage(m: any, turn?: number): void
  appendUsage(usage: UsageRecord['usage'], model: string): void
  appendFileState(entries: [string, number][]): void
  appendMeta(meta: SessionMeta): void
  appendCompact(): void
  appendRewind(toTurnId: number): void
}
```

3b. `LoadedSession` 接口（约 27-32 行）加两字段：
```ts
export interface LoadedSession {
  meta: SessionMeta
  messages: any[]
  usages: UsageRecord[]
  fileState: [string, number][]
  messageTurnIds: (number | undefined)[]  // 与 messages 等长；user 消息为其 turnId，其余 undefined
  maxTurnId: number                        // 文件中出现过的最大 turnId（单调，含被截断作废的号）
}
```

3c. `makeHandle`（约 42-60 行）的返回对象：`appendMessage` 带 turn，新增 `appendRewind`：
```ts
  return {
    file,
    appendMessage: (m, turn) => append(turn === undefined ? { t: 'msg', m } : { t: 'msg', m, turn }),
    appendUsage: (usage, model) => append({ t: 'usage', usage, model }),
    appendFileState: entries => append({ t: 'fs', entries }),
    appendMeta: meta => append({ t: 'meta', ...meta }),
    appendCompact: () => append({ t: 'compact' }),
    appendRewind: toTurnId => append({ t: 'rewind', toTurnId }),
  }
```

3d. `loadSession`（约 77-102 行）重写回放逻辑，维护 `messageTurnIds` 与 `maxTurnId`，处理 rewind：
```ts
export function loadSession(file: string): LoadedSession {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  let meta: SessionMeta = { cwd: '', model: 'deepseek-v4-flash', thinking: false, permMode: 'default' }
  let sawMeta = false
  let messages: any[] = []
  let messageTurnIds: (number | undefined)[] = []
  let maxTurnId = 0
  const usages: UsageRecord[] = []
  let fileState: [string, number][] = []
  for (const line of lines) {
    let r: any
    try { r = JSON.parse(line) } catch { continue }
    if (r.t === 'meta') {
      meta = {
        cwd: sawMeta ? meta.cwd : (r.cwd ?? ''),
        model: r.model ?? 'deepseek-v4-flash',
        thinking: r.thinking ?? false,
        permMode: r.permMode ?? 'default',
      }
      sawMeta = true
    }
    else if (r.t === 'msg') {
      messages.push(r.m)
      messageTurnIds.push(typeof r.turn === 'number' ? r.turn : undefined)
      if (typeof r.turn === 'number' && r.turn > maxTurnId) maxTurnId = r.turn
    }
    else if (r.t === 'usage') usages.push({ usage: r.usage, model: r.model })
    else if (r.t === 'fs') fileState = r.entries
    else if (r.t === 'compact') { messages = []; messageTurnIds = [] } // 压缩重置（turn 计数器 maxTurnId 不重置）
    else if (r.t === 'rewind') {
      const cut = messageTurnIds.findIndex(t => t === r.toTurnId)
      if (cut >= 0) { messages = messages.slice(0, cut); messageTurnIds = messageTurnIds.slice(0, cut) }
    }
  }
  const sanitized = sanitizeDanglingToolCalls(messages)
  // sanitize 可能补 tool 占位消息 → 末尾补齐 messageTurnIds（占位非 user，turnId undefined）
  while (messageTurnIds.length < sanitized.length) messageTurnIds.push(undefined)
  return { meta, messages: sanitized, usages, fileState, messageTurnIds, maxTurnId }
}
```
注意：`sanitizeDanglingToolCalls` 可能**插入** tool 占位消息到中间（不只末尾）。为保持 `messageTurnIds` 与 messages 对齐，改 `sanitizeDanglingToolCalls` 同步返回对齐的 turnIds——见 3e。

3e. 改 `sanitizeDanglingToolCalls` 同时维护 turnIds 对齐（约 105-118 行）：
```ts
/** 崩溃/截断可能留下没有 tool 结果的 assistant tool_calls，恢复后会被 API 拒收；补合成结果保持可恢复。
 *  同步对齐 turnIds（插入的占位 tool 消息 turnId 为 undefined）。 */
function sanitizeDanglingToolCalls(messages: any[], turnIds: (number | undefined)[]): { messages: any[]; turnIds: (number | undefined)[] } {
  const answered = new Set<string>()
  for (const m of messages) if (m?.role === 'tool' && m.tool_call_id) answered.add(m.tool_call_id)
  const out: any[] = []
  const outTurns: (number | undefined)[] = []
  messages.forEach((m, i) => {
    out.push(m); outTurns.push(turnIds[i])
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc?.id && !answered.has(tc.id)) { out.push({ role: 'tool', tool_call_id: tc.id, content: '（中断，无结果）' }); outTurns.push(undefined) }
      }
    }
  })
  return { messages: out, turnIds: outTurns }
}
```
并把 3d 末尾改为：
```ts
  const sani = sanitizeDanglingToolCalls(messages, messageTurnIds)
  return { meta, messages: sani.messages, usages, fileState, messageTurnIds: sani.turnIds, maxTurnId }
```
（删掉 3d 里旧的 `const sanitized = ...` 与 `while` 补齐两行。）

3f. `listSessions`（约 121-139 行）调用 `loadSession` 处不受影响（多返回字段无害）；无需改。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run test/session.rewind.test.ts && npm test`
Expected: 新测试 PASS（3 用例）；全量绿（现有 session 测试不回归——`messageTurnIds`/`maxTurnId` 是新增字段，旧调用方忽略即可）。

- [ ] **Step 5: typecheck + 提交**

Run: `npm run typecheck`
```bash
git add src/session.ts test/session.rewind.test.ts
git commit -m "feat(M7②): session turnId 持久化（{t:msg,turn}）+ appendRewind 截断 + loadSession 返回 messageTurnIds/maxTurnId

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Edit/Write before-image 钩子

`ToolContext` 加可选 `recordBeforeImage`；Edit/Write 写盘前调一次。

**Files:**
- Modify: `src/tools/types.ts`, `src/tools/edit.ts`, `src/tools/write.ts`
- Test: `test/tools.beforeImage.test.ts`（创建）

- [ ] **Step 1: 写失败测试** `test/tools.beforeImage.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { editTool } from '../src/tools/edit.js'
import { writeTool } from '../src/tools/write.js'
import type { ToolContext } from '../src/tools/types.js'

let work: string
beforeEach(() => { work = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-bi-')) })
afterEach(() => { fs.rmSync(work, { recursive: true, force: true }) })

function makeCtx(rec?: (p: string) => void): ToolContext {
  return {
    cwd: () => work, setCwd: () => {}, signal: new AbortController().signal,
    fileState: new Map(), recordBeforeImage: rec,
  } as ToolContext
}

describe('Edit/Write before-image 钩子', () => {
  it('Write 写盘前调 recordBeforeImage（绝对路径）', async () => {
    const rec = vi.fn()
    const ctx = makeCtx(rec)
    await writeTool.call({ file_path: 'a.txt', content: 'hi' }, ctx)
    expect(rec).toHaveBeenCalledWith(path.join(work, 'a.txt'))
  })

  it('Edit 写盘前调 recordBeforeImage', async () => {
    const p = path.join(work, 'b.txt')
    fs.writeFileSync(p, 'old')
    const rec = vi.fn()
    const ctx = makeCtx(rec)
    ctx.fileState.set(p, fs.statSync(p).mtimeMs)   // 过 read-before-edit 闸门
    await editTool.call({ file_path: 'b.txt', old_string: 'old', new_string: 'new' }, ctx)
    expect(rec).toHaveBeenCalledWith(p)
    expect(fs.readFileSync(p, 'utf8')).toBe('new')
  })

  it('无 recordBeforeImage（子代理/headless）不崩', async () => {
    const ctx = makeCtx(undefined)
    await expect(writeTool.call({ file_path: 'c.txt', content: 'x' }, ctx)).resolves.toContain('已写入')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/tools.beforeImage.test.ts`
Expected: FAIL（`recordBeforeImage` 未在类型/未被调用）

- [ ] **Step 3: 改三文件**

3a. `src/tools/types.ts` —— `ToolContext` 加字段（在 `todos?` 后）：
```ts
  /** /rewind before-image 钩子：Edit/Write 写盘前调，捕获文件原内容。子代理/headless 不注入（无快照）。 */
  recordBeforeImage?: (absPath: string) => void
```

3b. `src/tools/write.ts` —— 在 `fs.mkdirSync(...)` 之前（约 26 行前）插入钩子调用。把 call 体改为：
```ts
  async call(input, ctx) {
    const p = path.resolve(ctx.cwd(), input.file_path)
    if (fs.existsSync(p)) {
      const stateErr = checkFileState(p, ctx)
      if (stateErr) return stateErr
    }
    ctx.recordBeforeImage?.(p)   // 写盘前捕获（文件不存在→墓碑，存在→原内容）
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, input.content)
    ctx.fileState.set(p, fs.statSync(p).mtimeMs)
    return `已写入 ${p}（${input.content.length} 字符）。`
  },
```

3c. `src/tools/edit.ts` —— 在 `fs.writeFileSync(p, updated)`（约 58 行）之前插入。把那两行附近改为：
```ts
    ctx.recordBeforeImage?.(p)   // 写盘前捕获原内容
    fs.writeFileSync(p, updated)
    ctx.fileState.set(p, fs.statSync(p).mtimeMs)
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx vitest run test/tools.beforeImage.test.ts && npm test`
Expected: 新测试 PASS（3 用例）；全量绿（钩子可选，既有 Edit/Write 测试不回归）。

- [ ] **Step 5: typecheck + 提交**

Run: `npm run typecheck`
```bash
git add src/tools/types.ts src/tools/edit.ts src/tools/write.ts test/tools.beforeImage.test.ts
git commit -m "feat(M7②): ToolContext.recordBeforeImage 钩子 + Edit/Write 写盘前捕获

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: useChat 接线（Checkpointer + turnId 锚点 + rewindList/rewind）

镜像现有 `resume`/`pendingAsk` 模式。

**Files:**
- Modify: `src/tui/useChat.ts`
- Test: `test/useChat.rewind.test.ts`（创建）

- [ ] **Step 1: 写失败测试** `test/useChat.rewind.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChatCore } from '../src/tui/useChat.js'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-rw-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('useChat /rewind 契约', () => {
  it('ChatCore 暴露 rewindList/rewind；初始无还原点', () => {
    const core = createChatCore({ client: {} as any, yolo: false, cwd: '/tmp', sessionDir: dir, onState: () => {} })
    expect(typeof core.rewindList).toBe('function')
    expect(typeof core.rewind).toBe('function')
    expect(core.rewindList()).toEqual([])   // 还没有 user 轮
  })
})
```
（注：完整的 rewind 三模式效果依赖真实 runLoop（需 mock client 流），脆弱；此处只钉 ChatCore 契约 + 空态。文件还原逻辑已由 Task 1 Checkpointer 单测全覆盖，session 截断由 Task 2 覆盖。rewind 编排的集成在 Task 6 + pty 冒烟核对。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/useChat.rewind.test.ts`
Expected: FAIL（`rewindList`/`rewind` 不存在）

- [ ] **Step 3: 改 `src/tui/useChat.ts`**

3a. import 区（约 22-23 行）加 Checkpointer 与 os/path（path 已 import）：
```ts
import { createCheckpointer, type Checkpointer } from '../checkpoint.js'
import os from 'node:os'
```

3b. `ChatCore` 接口（约 151-162 行）加两方法与类型：
```ts
  rewindList(): { turnId: number; preview: string; fileCount: number }[]
  rewind(toTurnId: number, mode: 'conversation' | 'code' | 'both'): void
```

3c. 在 `ctx` 构造（约 182-188 行）之后、`messages` 之前，加 turnId 锚点状态与 checkpointer 占位：
```ts
  let nextTurnId = 1
  let currentTurnId = 0
  const turnOf = new WeakMap<object, number>()  // 内存锚点：user 消息对象 → turnId（跨 compact 存活，rebuildMessages 用 slice 保留引用）
  let checkpointer!: Checkpointer
```

3d. `ctx` 对象里加 `recordBeforeImage`（在 `todos,` 后）：
```ts
    recordBeforeImage: (absPath: string) => { if (currentTurnId > 0) checkpointer.capture(absPath, currentTurnId) },
```

3e. checkpointer 的初始化：每个 session 一个 store 目录（按会话文件名）。会话在 line 263-269 建立/恢复。**在 `restoreSession` 内**与**新建分支**都要建 checkpointer 并对齐 nextTurnId。改 `restoreSession`（约 234-258 行）：
- 末尾 `return loaded.messages...` 前，加：
```ts
    // turnId 锚点：从落盘 messageTurnIds 重建 WeakMap，nextTurnId 接最大号
    nextTurnId = loaded.maxTurnId + 1
    loaded.messages.forEach((m, i) => { if (loaded.messageTurnIds[i] !== undefined) turnOf.set(m, loaded.messageTurnIds[i]!) })
    checkpointer = createCheckpointer(checkpointStoreFor(file))
```
- 在 createChatCore 顶部加辅助（紧跟 `const sessionDir = ...` 之前或函数内合适处）：
```ts
  const checkpointStoreFor = (sessionFile: string) =>
    path.join(os.homedir(), '.deepcode', 'checkpoints', path.basename(sessionFile).replace(/\.jsonl$/, ''))
```
（测试注入 sessionDir 时，仍用 ~/.deepcode/checkpoints —— checkpoints 与 sessions 目录解耦；测试只验契约不验落盘路径，可接受。若要隔离，可改用 `path.join(sessionDir ?? 默认, '..','checkpoints', ...)`，本计划取简单版。）

3f. 新建会话分支（约 266-269 行 `else { session = newSession(...) ... }`）加 checkpointer：
```ts
  } else {
    session = newSession({ cwd, model, thinking, permMode }, sessionDir)
    session.appendMessage(messages[0]) // 持久化 system 消息
    checkpointer = createCheckpointer(checkpointStoreFor(session.file))
  }
```

3g. `runTurn`（约 318-419 行）里，给 user 消息分配 turnId、落盘带 turn、设 WeakMap、设 currentTurnId。找到 `messages.push(userMsg)`（约 345 行）那段，改为：
```ts
    dispatch({ type: 'push', item: { kind: 'user', text: displayLine } })
    const turnId = nextTurnId++
    currentTurnId = turnId
    const userMsg = {
      role: 'user',
      content: boundary.length ? `${userText}\n\n<system-reminder>\n${boundary.join('\n')}\n</system-reminder>` : userText,
    }
    turnOf.set(userMsg, turnId)
    messages.push(userMsg)
    session.appendMessage(userMsg, turnId) // user 输入即时落盘（带 turnId 锚点）
```

3h. `/clear`（约 489-500 行）新建会话后也要重建 checkpointer + 重置 turnId。在 `session = newSession(...)`、`session.appendMessage(messages[0])` 后加：
```ts
      checkpointer = createCheckpointer(checkpointStoreFor(session.file))
      nextTurnId = 1; currentTurnId = 0
```

3i. ChatCore 返回对象（约 543-579 行）加 `rewindList` 与 `rewind`（放在 `resume` 之后）：
```ts
    rewindList: () => {
      // 列内存中所有有 turnId 的 user 消息（compact 之后只剩边界后的轮），新→旧
      const out: { turnId: number; preview: string; fileCount: number }[] = []
      for (const m of messages) {
        if (m.role !== 'user') continue
        const t = turnOf.get(m)
        if (t === undefined) continue
        const raw = typeof m.content === 'string' ? m.content.split('\n<system-reminder>')[0] : ''
        out.push({ turnId: t, preview: raw.slice(0, 60), fileCount: checkpointer.fileCountAt(t) })
      }
      return out.reverse()
    },
    rewind: (toTurnId, mode) => {
      if (busy) return
      if (mode === 'code' || mode === 'both') {
        const r = checkpointer.restoreFiles(toTurnId)
        for (const p of [...r.restored, ...r.deleted]) ctx.fileState.delete(p) // 强制重新 Read
        const parts = [`还原 ${r.restored.length} 文件`, r.deleted.length ? `删除 ${r.deleted.length} 新建` : '', r.failed.length ? `失败 ${r.failed.length}` : ''].filter(Boolean)
        notice('info', `[rewind] 代码：${parts.join('、')}`)
      }
      if (mode === 'conversation' || mode === 'both') {
        const mi = messages.findIndex(m => turnOf.get(m) === toTurnId)
        if (mi >= 0) {
          // 截断 messages 到该 user 消息之前
          messages.length = mi
          // 截断 transcript：到对应的第 pos 个 'user' 项之前（pos = 该 turnId 在内存 user 轮中的序号）
          const liveTurnIds = messages.filter(m => m.role === 'user' && turnOf.has(m)).map(m => turnOf.get(m)!)
          const pos = liveTurnIds.length // 截断后剩 pos 个 user 轮 → 切到第 pos 个 'user' 项前
          let seen = 0, cut = transcript.length
          for (let i = 0; i < transcript.length; i++) {
            if (transcript[i].kind === 'user') { if (seen === pos) { cut = i; break } seen++ } }
          transcript = transcript.slice(0, cut)
          session.appendRewind(toTurnId)
          // nextTurnId 不回退（保持单调，作废 toTurnId 及之后号）
          setState()
        }
        notice('info', `[rewind] 对话已回退到第 ${toTurnId} 轮之前`)
      }
    },
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run test/useChat.rewind.test.ts && npm test && npm run typecheck`
Expected: 新测试 PASS；全量绿；typecheck 干净。重点确认现有 `test/tui.useChat.test.ts`、`test/tui.app.test.tsx`、session/resume 相关不回归。

- [ ] **Step 5: 提交**
```bash
git add src/tui/useChat.ts test/useChat.rewind.test.ts
git commit -m "feat(M7②): useChat 接 Checkpointer + turnId 锚点 + rewindList/rewind（三模式）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: App.tsx —— /rewind 两步 SelectList + HELP_TEXT

镜像 `resumeMode`：`/rewind` → 选还原点 → 选模式 → 执行。

**Files:**
- Modify: `src/tui/App.tsx`, `src/tui/useChat.ts`（HELP_TEXT）
- Test: `test/tui.rewind.test.tsx`（创建）

- [ ] **Step 1: 写失败测试** `test/tui.rewind.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { App } from '../src/tui/App.js'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dc-app-rw-'))

describe('App /rewind UX', () => {
  it('输入 /rewind 回车：无还原点时给提示、不崩', async () => {
    const { stdin, lastFrame, unmount } = render(
      <App client={{} as any} yolo={false} cwd="/tmp" sessionDir={tmp()} />
    )
    await new Promise(r => setTimeout(r, 30))
    stdin.write('/rewind'); await new Promise(r => setTimeout(r, 10))
    stdin.write('\r'); await new Promise(r => setTimeout(r, 30))
    expect(lastFrame()).toContain('暂无可回退')
    unmount()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/tui.rewind.test.tsx`
Expected: FAIL（/rewind 未处理）

- [ ] **Step 3: 改 `src/tui/App.tsx`**

3a. 加状态（约 59 行 `const [resumeMode, ...]` 附近）：
```ts
  const [rewindStep, setRewindStep] = useState<'point' | 'mode' | null>(null)
  const [rewindTurn, setRewindTurn] = useState<number | null>(null)
```

3b. draft 清除 effect（约 67-73 行）把 rewind 也纳入（条件与依赖数组都加 `rewindStep`）：
```ts
    if (state.pendingAsk || state.pendingQuestion || resumeMode || rewindStep) {
      setDraft(''); setValueOverride(undefined); justPickedRef.current = null
    }
  }, [!!state.pendingAsk, !!state.pendingQuestion, resumeMode, rewindStep])  // eslint-disable-line react-hooks/exhaustive-deps
```

3c. `submit`（约 116-123 行，与 `/exit`、`/resume` 拦截同级）拦 `/rewind`：
```ts
    if (text === '/rewind') { setRewindStep('point'); return }
```
（无还原点时也进 'point' 步，由渲染分支显示"暂无可回退"。）

3d. `inputActive`（约 163 行）加 `!rewindStep`：
```ts
  const inputActive = !state.pendingAsk && !state.pendingQuestion && !resumeMode && !rewindStep && !state.busy
```

3e. 渲染区（约 205-230 行）在 `resumeMode` 分支之后、`: <>` 之前，插入 rewind 分支。把 `resumeMode ? <SelectList .../>` 那段之后改为先判 rewindStep：
```tsx
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
              onCancel={() => setRewindStep(null)}
            />
```
（接在原 `resumeMode ? <SelectList .../>` 三元之后，保持原 `: <> ...输入框... </>` 收尾。）

- [ ] **Step 4: 改 HELP_TEXT** `src/tui/useChat.ts`（约 165 行），在 `/resume` 行后加：
```
\n/rewind 回退到某轮之前（仅对话/仅代码/两者）
```
（拼进 HELP_TEXT 字符串相应位置。）

- [ ] **Step 5: 跑测试 + 全量回归 + typecheck + build**

Run: `npx vitest run test/tui.rewind.test.tsx && npm test && npm run typecheck && npm run build`
Expected: 新测试 PASS；全量绿；typecheck/build 干净。

- [ ] **Step 6: 提交**
```bash
git add src/tui/App.tsx src/tui/useChat.ts test/tui.rewind.test.tsx
git commit -m "feat(M7②): App /rewind 两步 SelectList（选还原点→选三模式）+ HELP_TEXT

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 集成验收（端到端 + pty 冒烟）

**Files:** 无改动（验证 + 文档）。

- [ ] **Step 1: 全量回归 + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: 全绿、干净。

- [ ] **Step 2: 端到端脚本验证（Node 直跑 createChatCore + Checkpointer，不依赖 TUI/网络）**

写临时脚本 `/tmp/rewind-e2e.mjs`（用 `node --import tsx`）：建 core、手动注入 ctx.recordBeforeImage 已接好；模拟两轮：轮1 Write 建 a.txt、轮2 Edit 改 a.txt；调 `core.rewind(2,'code')` 断言 a.txt 回到轮2开始内容；`core.rewind(1,'both')` 断言 a.txt 被删（轮1墓碑）+ 对话截断。记录结果。（此步是手动 sanity，主逻辑已被 Task 1/2 单测覆盖。）

- [ ] **Step 3: pty 真终端冒烟（手动）**

真终端 `npm start`：让模型 Write/Edit 几个文件跨两三轮 → `/rewind` → 选某轮 → 分别试三模式，核对：仅代码（文件回滚、新建文件删、对话留）、仅对话（历史截断、文件留）、两者；Esc 各步取消；resume 后 `/rewind` 仍列出还原点（落盘生效）。记录结果。

- [ ] **Step 4: 文档 + 记忆**

更新 README roadmap（M7② /rewind ✓）；`deepcode-project.md` + MEMORY.md 标 M7② 完成、剩 M7③ 可写 subagent+worktree。

---

## 自查

- **Spec 覆盖**：三模式(T4 rewind + T5 mode 列表)、还原点=user 轮(T4 rewindList + turnId)、before-image 懒捕获(T1 capture + T3 钩子)、最早≥T 还原(T1 restoreFiles)、墓碑删新建(T1 + 测试)、对话截断(T2 appendRewind/loadSession + T4 rewind 内存截断)、稳定 turnId 持久化(T2 {t:msg,turn} + T4 nextTurnId/WeakMap)、compact 交互(T2 loadSession compact 不重置 maxTurnId + T4 WeakMap 跨 slice)、落盘+resume 可用(T1 重载 index + T4 restoreSession 重建锚点)、cap 100(T1)、fileState 清除(T4)、Bash 不管/headless 不注入(T3 可选钩子)、UX 两步 SelectList(T5)、HELP(T5)。全覆盖。
- **类型一致**：`Checkpointer`/`createCheckpointer`/`RestoreResult`（T1 定义，T4 用）；`recordBeforeImage?`（T3 types 定义，T3 edit/write + T4 useChat 用）；`SessionHandle.appendMessage(m,turn?)`/`appendRewind`/`LoadedSession.messageTurnIds`/`maxTurnId`（T2 定义，T4 用）；`rewindList()`/`rewind(toTurnId,mode)` 签名（T4 定义，T5 用）；`mode: 'conversation'|'code'|'both'`（T4/T5 一致）。前后一致。
- **顺序依赖**：T1（存储）→ T2（持久化/截断）→ T3（钩子）→ T4（接线，依赖 T1/T2/T3）→ T5（UX，依赖 T4）→ T6（验收）。严格串行。
- **无占位**：每步含真实代码/命令/期望。唯一手动项：T6 Step 2/3 端到端 sanity + pty 冒烟（rewind 编排依赖真实 runLoop 流，自动化脆弱，主逻辑已被纯逻辑单测覆盖）。
- **不碰**：loop.ts/permissions/只读工具/headless 逻辑零改动。
