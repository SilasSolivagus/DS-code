# 第 2 层收尾批 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 deepcode 补齐第 2 层三件真实增量：effort 思考档位系统、自动 compact 健壮性（熔断器+预警色）、char-based 工具结果兜底拦截。

**Architecture:** 纯函数优先（`capToolResult`/`detectEffortKeyword`/`shouldAutoCompact`/`contextBarColor` 全可单测），再接线到 api/loop/useChat/StatusFooter。effort 用「`thinking:boolean` 总开关 + `effortLevel` 档」最小改动向后兼容（默认 medium = 现状）。

**Tech Stack:** TypeScript/ESM、vitest、ink5、ink-testing-library。

## Global Constraints

- effort 默认 `'medium'`（不传时 `reasoning_effort: opts.effortLevel ?? 'medium'`，字节级等价现状）。
- `/think` 与 `/effort` 共存：`thinking` 是总开关，`effortLevel∈{low,medium,high}` 是开时用哪档；`/effort off` = `thinking=false`。
- 关键词升档为**本轮临时**（不改持久状态、不 appendMeta）。
- 熔断器计数 `consecutiveCompactFailures` **绝不落盘、resume/bind 归零**（防 resume 刷屏）；上限 `MAX_AUTO_COMPACT_FAILURES = 3`。
- char 兜底阈值默认 `100_000`，可经 `settings.maxToolResultChars` 覆盖。
- 不做：Microcompact(2.2)、Cost 告警(2.6 已完成)、CC budgetTokens/adaptive、`/fast`、token countTokens 多后端。
- ESM import 带 `.js` 后缀。纯逻辑免冒烟；碰 TUI（Task 5/6/8 渲染部分）合 main 前用户真机 `npm start` 冒烟。
- 每任务结束跑该任务测试 + `npm run -s typecheck`；全批完成跑全量 `npm test`+typecheck+build。

---

### Task 1: `capToolResult` 纯函数（char 兜底截断）

**Files:**
- Modify: `src/text.ts`
- Test: `test/text.test.ts`（新建）

**Interfaces:**
- Produces: `export function capToolResult(content: string, maxChars: number): string` —— 超 `maxChars` 时保留头 70% + 尾 20% + 中间替换为截断标注；否则原样。

- [ ] **Step 1: Write the failing test**

新建 `test/text.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { capToolResult } from '../src/text.js'

describe('capToolResult', () => {
  it('欠阈原样返回', () => {
    expect(capToolResult('hello', 100)).toBe('hello')
  })
  it('等于阈值原样返回', () => {
    const s = 'x'.repeat(100)
    expect(capToolResult(s, 100)).toBe(s)
  })
  it('超阈截断：保留头尾 + 标注被截字符数，且总长远小于原文', () => {
    const s = 'a'.repeat(700) + 'b'.repeat(300) // 1000 字符
    const out = capToolResult(s, 100)
    expect(out.length).toBeLessThan(s.length)
    expect(out).toContain('已截断')
    expect(out.startsWith('a')).toBe(true) // 保留了头
    expect(out.endsWith('b')).toBe(true)   // 保留了尾
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/text.test.ts`
Expected: FAIL —— `capToolResult is not a function`。

- [ ] **Step 3: Write minimal implementation**

在 `src/text.ts` 末尾追加：

```typescript
/** 工具结果字符级兜底截断：超 maxChars 时保留头 70% + 尾 20%，中间替换为标注。DeepSeek 无 tokenizer 故按字符估。 */
export function capToolResult(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  const head = Math.floor(maxChars * 0.7)
  const tail = Math.floor(maxChars * 0.2)
  const cut = content.length - head - tail
  return content.slice(0, head) + `\n…[工具结果过大，已截断 ${cut} 字符]…\n` + content.slice(content.length - tail)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/text.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/text.ts test/text.test.ts
git commit -m "feat(2.5): capToolResult 字符级工具结果兜底截断纯函数"
```

---

### Task 2: 接线 capToolResult 到 loop + config

**Files:**
- Modify: `src/config.ts`（Settings + loadSettings）
- Modify: `src/loop.ts`（LoopDeps + execCall）
- Modify: `src/tui/useChat.ts`（runLoop deps）
- Modify: `src/headless.ts`（runLoop deps）
- Test: `test/loop.test.ts`

**Interfaces:**
- Consumes: `capToolResult`（Task 1）。
- Produces: `LoopDeps.maxToolResultChars?: number`；`Settings.maxToolResultChars: number`。

- [ ] **Step 1: Write the failing test**

在 `test/loop.test.ts` 末尾、最后一个 `})` 之前追加（工具返回超大内容 → 回灌 messages 的 tool 消息被截断）：

```typescript
  it('超大工具结果按 maxToolResultChars 截断后再回灌 messages（缓存/上下文保护）', async () => {
    const big = 'Z'.repeat(5000)
    const huge = {
      name: 'Huge', isReadOnly: true, needsPermission: () => false,
      inputSchema: z.object({}), call: async () => big,
    }
    script.push(
      { result: { content: '', toolCalls: [{ id: 'h1', name: 'Huge', args: '{}' }], usage, finishReason: 'tool_calls' } },
      { result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const deps = makeDeps([huge as any])
    deps.maxToolResultChars = 200
    const messages: any[] = [{ role: 'user', content: 'hi' }]
    await drain(runLoop(messages, deps))
    const toolMsg = messages.find(m => m.role === 'tool')
    expect(toolMsg.content.length).toBeLessThan(5000)
    expect(toolMsg.content).toContain('已截断')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/loop.test.ts -t 截断`
Expected: FAIL —— tool 消息仍是全长 5000、不含「已截断」。

- [ ] **Step 3: 实现 config**

在 `src/config.ts` 的 `interface Settings`（第 31 行起）`costWarnUSD: number` 后加：

```typescript
  costWarnUSD: number
  maxToolResultChars: number
```

在 `loadSettings` 返回对象（第 82 行 `costWarnUSD` 后）加：

```typescript
    costWarnUSD: raw?.costWarnUSD ?? 2,
    maxToolResultChars: raw?.maxToolResultChars ?? 100_000,
```

- [ ] **Step 4: 实现 loop 接线**

在 `src/loop.ts` 顶部 import 加 `capToolResult`（与现有 `sanitize` 同源）：

```typescript
import { sanitize, capToolResult } from './text.js'
```

在 `LoopDeps` 接口（`drainInjections?` 附近）加字段：

```typescript
  /** 工具结果字符级兜底上限，超出截断后再回灌 messages（保护上下文/前缀缓存）。缺省由 caller 传 settings.maxToolResultChars。 */
  maxToolResultChars?: number
```

在 `execCall` 成功分支，PostToolUse hook 处理之后、`return { ok: true, content, ms }` 之前加截断（hook 看到完整输出，注入 messages 的是截断后）：

```typescript
      if (post.additionalContext) content += `\n\n<hook-context>\n${post.additionalContext}\n</hook-context>`
    }
    content = capToolResult(content, deps.maxToolResultChars ?? 100_000)
    return { ok: true, content, ms: Date.now() - t0 }
```

- [ ] **Step 5: 接线 useChat + headless**

在 `src/tui/useChat.ts` 的 `const deps: LoopDeps = {` 块（~第 508 行，`thinking,` 附近）加：

```typescript
        thinking,
        maxToolResultChars: settings.maxToolResultChars,
```

在 `src/headless.ts` 的 `runLoop(messages, {` 块（~第 104 行 `thinking: false,` 后）加：

```typescript
    thinking: false,
    maxToolResultChars: settings.maxToolResultChars,
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run test/loop.test.ts && npm run -s typecheck`
Expected: PASS + typecheck 0。

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/loop.ts src/tui/useChat.ts src/headless.ts test/loop.test.ts
git commit -m "feat(2.5): 接线 capToolResult 到 loop execCall + settings.maxToolResultChars"
```

---

### Task 3: `detectEffortKeyword` 纯函数（关键词升档）

**Files:**
- Modify: `src/text.ts`
- Test: `test/text.test.ts`

**Interfaces:**
- Produces: `export function detectEffortKeyword(text: string): 'high' | null` —— 命中 `ultrathink`/`think harder`/`think hard`（不分大小写、词边界）返回 `'high'`，否则 `null`。

- [ ] **Step 1: Write the failing test**

在 `test/text.test.ts` 末尾追加：

```typescript
import { detectEffortKeyword } from '../src/text.js'

describe('detectEffortKeyword', () => {
  it('命中 ultrathink → high', () => {
    expect(detectEffortKeyword('请 ultrathink 这个问题')).toBe('high')
    expect(detectEffortKeyword('ULTRATHINK now')).toBe('high')
  })
  it('命中 think harder / think hard → high', () => {
    expect(detectEffortKeyword('think harder about edge cases')).toBe('high')
    expect(detectEffortKeyword('please Think Hard')).toBe('high')
  })
  it('无关键词 → null', () => {
    expect(detectEffortKeyword('just fix the bug')).toBe(null)
    expect(detectEffortKeyword('rethinking the design')).toBe(null) // 不误伤 rethinking
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/text.test.ts -t detectEffortKeyword`
Expected: FAIL —— `detectEffortKeyword is not a function`。

- [ ] **Step 3: Write minimal implementation**

在 `src/text.ts` 末尾追加：

```typescript
/** 检测用户输入里的「加强思考」关键词，命中返回 'high'（本轮临时升 effort 档），否则 null。 */
export function detectEffortKeyword(text: string): 'high' | null {
  return /\bultrathink\b|\bthink\s+har(?:d|der)\b/i.test(text) ? 'high' : null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/text.test.ts`
Expected: PASS（全部 capToolResult + detectEffortKeyword）。

- [ ] **Step 5: Commit**

```bash
git add src/text.ts test/text.test.ts
git commit -m "feat(2.1): detectEffortKeyword 关键词升档纯函数"
```

---

### Task 4: api/loop effortLevel 透传

**Files:**
- Modify: `src/api.ts`（ChatOptions + chatStream）
- Modify: `src/loop.ts`（LoopDeps + chatStream 调用）
- Test: `test/api.test.ts`

**Interfaces:**
- Produces: `ChatOptions.effortLevel?: 'low'|'medium'|'high'`；`LoopDeps.effortLevel?: 'low'|'medium'|'high'`。
- 语义：`thinking=true` → `reasoning_effort: opts.effortLevel ?? 'medium'`；`thinking=false` → `thinking:{type:'disabled'}`（无 reasoning_effort）。

- [ ] **Step 1: Write the failing test**

在 `test/api.test.ts` 末尾追加（用假 client 捕获 create() body）：

```typescript
import { chatStream } from '../src/api.js'

async function captureCreateBody(opts: any): Promise<any> {
  const bodies: any[] = []
  const client: any = {
    chat: { completions: { create: async (body: any) => { bodies.push(body); return (async function* () {})() } } },
  }
  const gen = chatStream(client, { model: 'm', messages: [], tools: [], signal: new AbortController().signal, ...opts })
  let r: any; do { r = await gen.next() } while (!r.done)
  return bodies[0]
}

describe('chatStream effortLevel 透传', () => {
  it('thinking 开 + effortLevel=high → reasoning_effort=high', async () => {
    const body = await captureCreateBody({ thinking: true, effortLevel: 'high' })
    expect(body.reasoning_effort).toBe('high')
    expect(body.thinking).toEqual({ type: 'enabled' })
  })
  it('thinking 开但不传 effortLevel → 默认 medium（向后兼容）', async () => {
    const body = await captureCreateBody({ thinking: true })
    expect(body.reasoning_effort).toBe('medium')
  })
  it('thinking 关 → disabled、无 reasoning_effort', async () => {
    const body = await captureCreateBody({ thinking: false })
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.reasoning_effort).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api.test.ts -t effortLevel`
Expected: FAIL —— effortLevel=high 时仍返回 `reasoning_effort: 'medium'`（写死）。

- [ ] **Step 3: 实现 api.ts**

在 `src/api.ts` `ChatOptions` 接口（第 105-111 行）`thinking: boolean` 后加：

```typescript
  thinking: boolean
  effortLevel?: 'low' | 'medium' | 'high'
```

把 chatStream 第 126-128 行：

```typescript
        ...(opts.thinking
          ? { reasoning_effort: 'medium', thinking: { type: 'enabled' } }
          : { thinking: { type: 'disabled' } }),
```

改为：

```typescript
        ...(opts.thinking
          ? { reasoning_effort: opts.effortLevel ?? 'medium', thinking: { type: 'enabled' } }
          : { thinking: { type: 'disabled' } }),
```

- [ ] **Step 4: 实现 loop.ts 透传**

在 `src/loop.ts` `LoopDeps` 接口 `thinking: boolean` 后加：

```typescript
  thinking: boolean
  effortLevel?: 'low' | 'medium' | 'high'
```

在 chatStream 调用（第 144-150 行）`thinking: deps.thinking,` 后加：

```typescript
        thinking: deps.thinking,
        effortLevel: deps.effortLevel,
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run test/api.test.ts && npm run -s typecheck`
Expected: PASS + typecheck 0。

- [ ] **Step 6: Commit**

```bash
git add src/api.ts src/loop.ts test/api.test.ts
git commit -m "feat(2.1/2.7): chatStream effortLevel 透传（reasoning_effort 不再写死 medium）"
```

---

### Task 5: useChat effort 状态 + /effort 命令 + 关键词升档 + 持久化

**Files:**
- Modify: `src/tui/useChat.ts`
- Test: `test/tui.effort.test.tsx`（新建）
- Modify: `src/session.ts`（SessionMeta 加 effortLevel，若类型需要）

**Interfaces:**
- Consumes: `detectEffortKeyword`（Task 3）；`LoopDeps.effortLevel`（Task 4）。
- Produces: `ChatState.effortLevel: 'low'|'medium'|'high'`。

- [ ] **Step 1: Write the failing test**

新建 `test/tui.effort.test.tsx`（mock chatStream 捕获 opts）：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const script: Array<{ deltas?: any[]; result: any }> = []
const captured: any[] = []
vi.mock('../src/api.js', async orig => ({
  ...(await orig() as any),
  chatStream: vi.fn((_client: any, opts: any) => {
    captured.push(opts)
    return (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      for (const d of scene.deltas ?? []) yield typeof d === 'string' ? { type: 'text', delta: d } : d
      return scene.result
    })()
  }),
}))

import { createChatCore } from '../src/tui/useChat.js'

const usage = { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0 }
let sessionDir: string
beforeEach(() => { script.length = 0; captured.length = 0; vi.clearAllMocks(); sessionDir = mkdtempSync(path.join(tmpdir(), 'dc-eff-')) })

function core() {
  return createChatCore({ client: {} as any, yolo: true, cwd: tmpdir(), sessionDir, onState: () => {} })
}

describe('useChat effort 档位', () => {
  it('默认 medium', () => {
    const c = core()
    expect(c.state.effortLevel).toBe('medium')
    c.dispose()
  })
  it('/effort high 设档 + 开 thinking', async () => {
    const c = core()
    await c.send('/effort high')
    expect(c.state.effortLevel).toBe('high')
    expect(c.state.thinking).toBe(true)
    c.dispose()
  })
  it('/effort off 关 thinking', async () => {
    const c = core()
    await c.send('/effort high')
    await c.send('/effort off')
    expect(c.state.thinking).toBe(false)
    c.dispose()
  })
  it('普通消息把当前 effortLevel 透传给 chatStream', async () => {
    const c = core()
    await c.send('/effort high')
    script.push({ result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' } })
    await c.send('hi')
    expect(captured.at(-1).effortLevel).toBe('high')
    expect(captured.at(-1).thinking).toBe(true)
    c.dispose()
  })
  it('关键词 ultrathink 本轮临时升 high，不改持久档', async () => {
    const c = core() // 默认 medium、thinking off
    script.push({ result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' } })
    await c.send('ultrathink 修这个 bug')
    expect(captured.at(-1).effortLevel).toBe('high')
    expect(captured.at(-1).thinking).toBe(true)
    expect(c.state.effortLevel).toBe('medium') // 持久档不变
    c.dispose()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tui.effort.test.tsx`
Expected: FAIL —— `c.state.effortLevel` undefined / `/effort` 未处理。

- [ ] **Step 3: useChat 状态 + 接口**

在 `src/tui/useChat.ts`：

3a. `ChatState` 接口（`thinking: boolean` 附近）加：

```typescript
  thinking: boolean
  effortLevel: 'low' | 'medium' | 'high'
```

3b. init（`let thinking = false` 第 201 行后）加：

```typescript
  let thinking = false
  let effortLevel: 'low' | 'medium' | 'high' = 'medium'
```

3c. `snap()` 返回对象（第 263 行）把 `thinking,` 后补 `effortLevel,`：

```typescript
    transcript, busy, model, thinking, effortLevel, permMode, pendingAsk, pendingQuestion, usageLog, lastTokPerSec, turnStartAt, turnOutTokens, sessionCost, cacheHitRate, cacheSavings, contextPct,
```

- [ ] **Step 4: /effort 命令 + /think 保持**

在 `src/tui/useChat.ts` 现有 `/think` 分支（第 642-646 行）之后加 `/effort` 分支：

```typescript
    if (line.startsWith('/effort')) {
      const arg = line.slice('/effort'.length).trim().toLowerCase()
      if (arg === 'off') {
        thinking = false
        session.appendMeta({ cwd, model, thinking, effortLevel, permMode })
        notice('info', 'thinking 模式：关')
      } else if (arg === 'low' || arg === 'medium' || arg === 'high') {
        effortLevel = arg
        thinking = true
        session.appendMeta({ cwd, model, thinking, effortLevel, permMode })
        notice('info', `思考档位：${arg}（thinking 开）`)
      } else {
        notice('info', `当前思考档位：${thinking ? effortLevel : 'off'}。用法：/effort low|medium|high|off`)
      }
      setState()
      return
    }
```

（注意：`/effort` 分支必须放在 `/think` 等其它命令分支同区；用 `line.startsWith` 因为带参数。确认它在解析 customCommands/skill 之前匹配。）

- [ ] **Step 5: 持久化 effortLevel（meta 全站点）+ runLoop 透传 + 关键词升档**

5a. 把所有 `session.appendMeta({ cwd, model, thinking, permMode })`（第 632/637/644/651 行）和 `newSession({ cwd, model, thinking, permMode }, ...)`（第 347/677 行）统一改为带 `effortLevel`：`{ cwd, model, thinking, effortLevel, permMode }`。

5b. resume 恢复（第 284 行 `thinking = loaded.meta.thinking` 附近）加：

```typescript
    thinking = loaded.meta.thinking
    effortLevel = loaded.meta.effortLevel ?? 'medium'
```

5c. `src/session.ts` 的 SessionMeta 类型加可选 `effortLevel?: 'low'|'medium'|'high'`（grep `thinking` 定位 meta 类型；若 meta 是宽松 any 则免改）。

5d. runLoop 的 `const deps: LoopDeps`（第 508 行 `thinking,` 处）：实现关键词本轮临时升档。在 `runTurn`/`send` 构造 deps 前，根据本次用户输入算本轮 effort：

```typescript
      // 关键词本轮临时升档（不改持久状态）
      const kw = detectEffortKeyword(userText)
      const turnThinking = kw ? true : thinking
      const turnEffort = kw ?? effortLevel
```

并把 deps 里 `thinking,` 改为 `thinking: turnThinking,` 且加 `effortLevel: turnEffort,`。（`userText` = 本次 send 的用户原文；用实际变量名对齐 send 签名。）顶部 import 加 `detectEffortKeyword`：`import { ..., detectEffortKeyword } from '../text.js'`（与现有 text import 合并）。

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run test/tui.effort.test.tsx && npm run -s typecheck`
Expected: PASS + typecheck 0。

- [ ] **Step 7: Commit**

```bash
git add src/tui/useChat.ts src/session.ts test/tui.effort.test.tsx
git commit -m "feat(2.1/2.7): useChat effort 档位状态 + /effort 命令 + 关键词升档 + 持久化"
```

---

### Task 6: 状态行显示 effort + HELP_TEXT

**Files:**
- Modify: `src/tui/components/StatusFooter.tsx`
- Modify: `src/tui/App.tsx`、`src/tui/FullscreenApp.tsx`
- Modify: `src/tui/useChat.ts`（HELP_TEXT）
- Test: `test/tui.statusfooter.test.tsx`

**Interfaces:**
- Consumes: `ChatState.thinking`、`ChatState.effortLevel`（Task 5）。
- Produces: `StatusFooter` props 加 `thinking: boolean`、`effortLevel: 'low'|'medium'|'high'`。

- [ ] **Step 1: Write the failing test**

在 `test/tui.statusfooter.test.tsx` 的 `base` 对象加（`cacheSavings: 0,` 后）：

```typescript
  hitRate: 0,
  cacheSavings: 0,
  thinking: false,
  effortLevel: 'medium' as 'low' | 'medium' | 'high',
```

在 `describe('StatusFooter')` 内追加：

```typescript
  it('thinking 开时 Row 1 显示 think:档位', () => {
    const f = render(<StatusFooter {...base} thinking={true} effortLevel="high" />).lastFrame()!
    expect(f).toContain('think:high')
  })
  it('thinking 关时不显示 think 段', () => {
    const f = render(<StatusFooter {...base} thinking={false} />).lastFrame()!
    expect(f).not.toContain('think:')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tui.statusfooter.test.tsx`
Expected: FAIL —— 不含 `think:high`。

- [ ] **Step 3: 实现 StatusFooter**

props 类型加（`cost: number` 那组后，沿用 Task 已加的 hitRate/cacheSavings 后）：

```typescript
  thinking: boolean
  effortLevel: 'low' | 'medium' | 'high'
```

Row 1（第 32-33 行）：把

```tsx
        <Text dimColor>{` | ${props.mode}]`}</Text>
        <Text dimColor>{` | ${props.cwdBase}`}</Text>
```

改为（`]` 移到可选 think 段之后）：

```tsx
        <Text dimColor>{` | ${props.mode}`}</Text>
        {props.thinking && <Text dimColor>{` | think:${props.effortLevel}`}</Text>}
        <Text dimColor>{`]`}</Text>
        <Text dimColor>{` | ${props.cwdBase}`}</Text>
```

- [ ] **Step 4: 接线 App + HELP_TEXT**

`src/tui/App.tsx` 与 `src/tui/FullscreenApp.tsx` 的 `<StatusFooter` 调用各加：

```tsx
        thinking={state.thinking}
        effortLevel={state.effortLevel}
```

`src/tui/useChat.ts` HELP_TEXT（第 187 行）在 `/think` 那条后插入：

```
/effort 思考档位 low/medium/high/off\n
```

（即把 `'/model  flash↔pro 切换\n/think  thinking 模式开关\n` 改为 `...\n/think  thinking 模式开关\n/effort 思考档位 low/medium/high/off\n...`）

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run test/tui.statusfooter.test.tsx && npm run -s typecheck`
Expected: PASS（既有 6 用例 base 加了 thinking:false 不受影响 + 2 新用例）+ typecheck 0。

- [ ] **Step 6: Commit**

```bash
git add src/tui/components/StatusFooter.tsx src/tui/App.tsx src/tui/FullscreenApp.tsx src/tui/useChat.ts test/tui.statusfooter.test.tsx
git commit -m "feat(2.7): 状态行显示 think:档位 + HELP_TEXT 加 /effort"
```

---

### Task 7: 自动 compact 失败熔断器

**Files:**
- Modify: `src/compact.ts`（`shouldAutoCompact` 纯函数）
- Modify: `src/tui/useChat.ts`（计数器 + notice + 归零）
- Test: `test/compact.test.ts`

**Interfaces:**
- Produces: `export function shouldAutoCompact(promptTokens: number, threshold: number, failures: number, maxFailures: number): boolean` = `promptTokens > threshold && failures < maxFailures`。

- [ ] **Step 1: Write the failing test**

在 `test/compact.test.ts` 末尾追加：

```typescript
import { shouldAutoCompact } from '../src/compact.js'

describe('shouldAutoCompact', () => {
  it('超阈且未达失败上限 → true', () => {
    expect(shouldAutoCompact(201_000, 200_000, 0, 3)).toBe(true)
    expect(shouldAutoCompact(201_000, 200_000, 2, 3)).toBe(true)
  })
  it('欠阈 → false', () => {
    expect(shouldAutoCompact(199_000, 200_000, 0, 3)).toBe(false)
  })
  it('达失败上限 → 熔断 false（即便超阈）', () => {
    expect(shouldAutoCompact(300_000, 200_000, 3, 3)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/compact.test.ts -t shouldAutoCompact`
Expected: FAIL —— `shouldAutoCompact is not a function`。

- [ ] **Step 3: 实现纯函数**

在 `src/compact.ts` 末尾追加：

```typescript
/** 自动 compact 决策：超阈且未达连续失败上限才触发（熔断防无限重试烧钱）。 */
export function shouldAutoCompact(promptTokens: number, threshold: number, failures: number, maxFailures: number): boolean {
  return promptTokens > threshold && failures < maxFailures
}
```

- [ ] **Step 4: 接线 useChat 熔断**

在 `src/tui/useChat.ts`：

4a. 顶部 import 把 `summarize`（或现有 compact import）那行加 `shouldAutoCompact`：`import { summarize, shouldAutoCompact } from '../compact.js'`（用实际现有 import 路径/成员）。

4b. init 区（`let costWarned = false` 附近）加：

```typescript
  const MAX_AUTO_COMPACT_FAILURES = 3
  let consecutiveCompactFailures = 0
```

4c. 自动 compact 块（第 574-576 行）改为：

```typescript
    // 自动 compact（落盘之后；busy 保持 true 直到 compact 结束）
    if (shouldAutoCompact(lastPromptTokens, settings.compactTokens, consecutiveCompactFailures, MAX_AUTO_COMPACT_FAILURES)) {
      try { await doCompact('auto'); consecutiveCompactFailures = 0 }
      catch (e: any) {
        consecutiveCompactFailures++
        if (consecutiveCompactFailures >= MAX_AUTO_COMPACT_FAILURES) notice('warn', '自动压缩连续失败 3 次，已暂停（用 /compact 手动重试）')
        else notice('error', `[自动 compact 失败，将在下轮重试] ${e?.message ?? e}`)
      }
    }
```

4d. 手动 `/compact` 命令成功后归零：在 `/compact` 命令分支调用 `doCompact('manual')` 之后加 `consecutiveCompactFailures = 0`（grep `/compact` 定位）。

4e. resume 重置区（grep 注释「恢复后重置会话内状态」）加 `consecutiveCompactFailures = 0`。

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run test/compact.test.ts && npm run -s typecheck`
Expected: PASS + typecheck 0。

- [ ] **Step 6: Commit**

```bash
git add src/compact.ts src/tui/useChat.ts test/compact.test.ts
git commit -m "feat(2.3): 自动 compact 失败熔断器（连续 3 次停试，防无限重试烧钱）"
```

---

### Task 8: 上下文条预警色 + 接近阈值提示

**Files:**
- Modify: `src/tui/components/StatusFooter.tsx`（`contextBarColor` + 应用）
- Modify: `src/tui/useChat.ts`（≥90% 一次性 notice）
- Test: `test/tui.statusfooter.test.tsx`

**Interfaces:**
- Produces: `export function contextBarColor(pct: number): string` —— `pct>=95` → `T.err`；`pct>=80` → `T.warn`；否则 `T.accent`。

- [ ] **Step 1: Write the failing test**

在 `test/tui.statusfooter.test.tsx` 顶部 import 加：

```typescript
import { StatusFooter, contextBarColor } from '../src/tui/components/StatusFooter.js'
import { T } from '../src/tui/theme.js'
```

（若已 import StatusFooter，改成同行加 `contextBarColor`。）在 describe 内追加：

```typescript
  it('contextBarColor 分档：<80 accent, 80-94 warn, >=95 err', () => {
    expect(contextBarColor(50)).toBe(T.accent)
    expect(contextBarColor(85)).toBe(T.warn)
    expect(contextBarColor(96)).toBe(T.err)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tui.statusfooter.test.tsx -t contextBarColor`
Expected: FAIL —— `contextBarColor is not a function`。

- [ ] **Step 3: 实现 contextBarColor + 应用到进度条**

在 `src/tui/components/StatusFooter.tsx` 顶部（import 后）加导出：

```typescript
export function contextBarColor(pct: number): string {
  if (pct >= 95) return T.err
  if (pct >= 80) return T.warn
  return T.accent
}
```

把 Row 2 进度条 filled 段（第 40 行）的 `color={T.accent}` 改为按档：

```tsx
        <Text color={contextBarColor(props.contextPct)}>{bar.fill}</Text>
```

- [ ] **Step 4: useChat ≥90% 一次性提示**

在 `src/tui/useChat.ts`：

4a. init 区加 `let compactWarned = false`。

4b. 自动 compact 块之前（turn_end 处理后、计算了 lastPromptTokens 后），加接近阈值提示：

```typescript
    const ctxPct = settings.compactTokens ? (lastPromptTokens / settings.compactTokens) * 100 : 0
    if (!compactWarned && ctxPct >= 90) {
      compactWarned = true
      notice('warn', `上下文已用 ${Math.round(ctxPct)}%，接近自动压缩阈值`)
    }
```

4c. compact 成功后重置（`doCompact` 成功路径末尾或自动/手动 compact 成功后）：`compactWarned = false`。

4d. resume 重置区加 `compactWarned = false`。

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run test/tui.statusfooter.test.tsx && npm run -s typecheck`
Expected: PASS + typecheck 0。

- [ ] **Step 6: Commit**

```bash
git add src/tui/components/StatusFooter.tsx src/tui/useChat.ts test/tui.statusfooter.test.tsx
git commit -m "feat(2.3): 上下文条预警色分档 + 接近阈值一次性提示"
```

---

### 收尾：全量验证 + 真机冒烟

- [ ] **全量 test + typecheck + build**

Run: `npm test && npm run -s typecheck && npm run -s build`
Expected: 全绿。

- [ ] **真机冒烟（碰 TUI 部分）**

用户 `npm start`：①`/effort high` 后状态行显示 `think:high`；②`/think` 与 `/effort` 共存正常切换；③输入含 `ultrathink` 本轮自动升档（思考流出现）；④上下文条接近阈值变黄(≥80%)/红(≥95%)。

## Self-Review

- **Spec coverage**：组件1(effort)→Task 3/4/5/6；组件2(compact 健壮性)→Task 7(熔断器)+Task 8(预警色)；组件3(char-guard)→Task 1/2。spec「不做」项无任务（正确）。全覆盖。
- **Placeholder scan**：每步含完整代码/命令；少数接线步注明「grep 定位实际行」是因目标行号会随前序任务漂移，非占位（代码内容完整给出）。
- **Type consistency**：`effortLevel: 'low'|'medium'|'high'` 在 api/loop/useChat/StatusFooter 一致；`capToolResult(content,maxChars)`(Task1)↔`deps.maxToolResultChars`(Task2)一致；`shouldAutoCompact(promptTokens,threshold,failures,maxFailures)`(Task7)签名一致；`contextBarColor(pct)`(Task8)一致；`detectEffortKeyword`(Task3)↔useChat 调用(Task5)一致。
- **任务顺序**：纯函数(1,3,7-fn,8-fn)先 → 接线(2,4,5,6,7-wire,8-wire)。Task 6 依赖 Task 5 的 `state.effortLevel`；Task 2 依赖 Task 1；Task 5 依赖 Task 3/4。顺序无环。
