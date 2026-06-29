# SKIP 件批1：Sleep 工具 + Spinner tips 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 deepcode 加两件原 SKIP 件——4.3 可打断的 Sleep 工具、5.10 spinner tips（按会话冷却去重，每会话固定一条），照搬 CC 行为。

**Architecture:** Sleep 是一个新只读工具（轮询 `ctx.signal.aborted`，进只读并发批）。Tips 拆三层：纯逻辑选择算法（`src/tui/tips.ts`）+ app 管理的持久态（`src/tipsState.ts` → `~/.deepcode/state.json`，独立于用户手写 settings.json）+ 配置开关（`Settings.spinnerTips`/`spinnerTipsOverride`）。启动时选一条 tip 存入 `ChatState.spinnerTip`，整会话不变，Spinner 在状态行下方渲染一条 dim 文本。

**Tech Stack:** TypeScript / ESM / zod / ink5 / vitest。

## Global Constraints

- **TUI 双组件铁律**：任何改 Spinner 接线的地方，`src/tui/App.tsx` 与 `src/tui/FullscreenApp.tsx` **必须双改**（默认全屏跑 FullscreenApp，漏一个则默认路径不生效）。
- **新增工具同步三处**：`src/tools/index.ts` 的 `allTools`、`test/tools.registry.test.ts` 计数断言、判断是否加 `GLOBAL_SUBAGENT_DENY`（Sleep 纯等待→**不加**）。
- **新增顶层 Settings 字段须在 `src/settingsLayers.ts` 的 `parsePresent` 注册**，否则分层合并时被丢弃（3.9 既有坑）。新字段 `spinnerTips`/`spinnerTipsOverride` 为非敏感 UX，**不进 `DANGEROUS_TOP_KEYS`**。
- **可变运行态（startupCount/tipsHistory）不入 settings.json**，存独立 `~/.deepcode/state.json`，避免污染用户手写配置 + 分层机制。
- **tips 节奏（D2）= 每会话一条固定**（启动选一次，整会话不变；rotation 跨会话发生）。
- **生产代码 `src/` 可用 `Math.random`**（仅 Workflow DSL 脚本禁用，本批不涉及）。
- 中文文案，对齐 deepcode 既有工具风格。
- Sleep input 单位 = `seconds`，正整数，范围 1–3600（D1）。Sleep 描述**不含** `<tick>` check-in 行（deepcode 无调度层，D4）。

---

### Task 1: Sleep 工具

**Files:**
- Create: `src/tools/sleep.ts`
- Modify: `src/tools/index.ts:4-16`（import + allTools）
- Modify: `test/tools.registry.test.ts:6-8`（计数 11→12）
- Test: `test/tools.sleep.test.ts`

**Interfaces:**
- Consumes: `Tool`、`ToolContext`（`src/tools/types.ts`）。
- Produces: `export const sleepTool: Tool<typeof schema>`，`name='Sleep'`，`isReadOnly=true`，`needsPermission=()=>false`。

- [ ] **Step 1: 写失败测试** `test/tools.sleep.test.ts`

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sleepTool } from '../src/tools/sleep.js'
import type { ToolContext } from '../src/tools/types.js'

function makeCtx(signal: AbortSignal): ToolContext {
  return {
    cwd: () => process.cwd(),
    setCwd: () => {},
    signal,
    fileState: new Map(),
  } as ToolContext
}

describe('sleepTool', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('自然完成返回已等待文案', async () => {
    const ac = new AbortController()
    const p = sleepTool.call({ seconds: 2 }, makeCtx(ac.signal))
    await vi.advanceTimersByTimeAsync(2000)
    expect(await p).toBe('已等待 2 秒')
  })

  it('中途中断返回已过秒数', async () => {
    const ac = new AbortController()
    const p = sleepTool.call({ seconds: 10 }, makeCtx(ac.signal))
    await vi.advanceTimersByTimeAsync(1000)
    ac.abort('interrupt')
    await vi.advanceTimersByTimeAsync(100)
    expect(await p).toMatch(/^已中断等待（已过 \d+ 秒）$/)
  })

  it('入参已中断则立即返回 0 秒', async () => {
    const ac = new AbortController()
    ac.abort('interrupt')
    const p = sleepTool.call({ seconds: 10 }, makeCtx(ac.signal))
    await vi.advanceTimersByTimeAsync(100)
    expect(await p).toBe('已中断等待（已过 0 秒）')
  })

  it('schema 拒绝越界秒数', () => {
    expect(sleepTool.inputSchema.safeParse({ seconds: 5000 }).success).toBe(false)
    expect(sleepTool.inputSchema.safeParse({ seconds: 0 }).success).toBe(false)
    expect(sleepTool.inputSchema.safeParse({ seconds: 1.5 }).success).toBe(false)
    expect(sleepTool.inputSchema.safeParse({ seconds: 30 }).success).toBe(true)
  })

  it('元数据：只读、免审批', () => {
    expect(sleepTool.isReadOnly).toBe(true)
    expect(sleepTool.needsPermission({ seconds: 1 })).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tools.sleep`
Expected: FAIL（`Cannot find module '../src/tools/sleep.js'`）

- [ ] **Step 3: 实现 `src/tools/sleep.ts`**

```ts
// src/tools/sleep.ts
import { z } from 'zod'
import type { Tool } from './types.js'

const schema = z.object({
  seconds: z.number().int().min(1).max(3600).describe('等待的秒数（1–3600）'),
})

export const sleepTool: Tool<typeof schema> = {
  name: 'Sleep',
  description:
    '等待指定的秒数。用户随时可以中断等待。\n\n' +
    '当用户让你休息/等待，或你暂时无事可做、在等待某事发生时使用。\n\n' +
    '可与其他工具并发调用——不会互相干扰。\n\n' +
    '优于 `Bash(sleep ...)`：不会占用一个 shell 进程。\n\n' +
    '注意：每次唤醒消耗一次 API 调用，且提示缓存在 5 分钟不活动后过期，请据此权衡等待时长。',
  inputSchema: schema,
  isReadOnly: true,
  needsPermission: () => false,
  async call(input, ctx) {
    const start = Date.now()
    const targetMs = input.seconds * 1000
    await new Promise<void>(resolve => {
      const timer = setInterval(() => {
        if (ctx.signal.aborted || Date.now() - start >= targetMs) {
          clearInterval(timer)
          resolve()
        }
      }, 100)
    })
    if (ctx.signal.aborted) {
      const elapsed = Math.round((Date.now() - start) / 1000)
      return `已中断等待（已过 ${elapsed} 秒）`
    }
    return `已等待 ${input.seconds} 秒`
  },
}
```

- [ ] **Step 4: 注册到 allTools** — `src/tools/index.ts`

import 区加（line 14 后）：
```ts
import { sleepTool } from './sleep.js'
```
`allTools` 数组末尾加 `sleepTool`：
```ts
export const allTools: Tool<any>[] = [readTool, globTool, grepTool, bashTool, editTool, writeTool, notebookEditTool, configTool, exitPlanModeTool, enterWorktreeTool, exitWorktreeTool, sleepTool]
```

- [ ] **Step 5: 更新注册计数测试** — `test/tools.registry.test.ts:6-8`

```ts
  it('注册了十二个工具（含 ExitPlanMode、EnterWorktree、ExitWorktree、Sleep）', () => {
    expect(allTools.map(t => t.name).sort()).toEqual(['Bash', 'Config', 'Edit', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree', 'Glob', 'Grep', 'NotebookEdit', 'Read', 'Sleep', 'Write'])
  })
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npm test -- tools.sleep tools.registry`
Expected: PASS（全部）

- [ ] **Step 7: 提交**

```bash
git add src/tools/sleep.ts src/tools/index.ts test/tools.sleep.test.ts test/tools.registry.test.ts
git commit -m "feat(4.3): 可打断的 Sleep 工具（照搬 CC，只读可并发）"
```

---

### Task 2: tips 持久态 store（`src/tipsState.ts`）

**Files:**
- Create: `src/tipsState.ts`
- Test: `test/tipsState.test.ts`

**Interfaces:**
- Produces:
  - `interface AppState { startupCount: number; tipsHistory: Record<string, number> }`
  - `loadAppState(file?: string): AppState`
  - `saveAppState(state: AppState, file?: string): void`

- [ ] **Step 1: 写失败测试** `test/tipsState.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadAppState, saveAppState } from '../src/tipsState.js'

let dir: string
let file: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-tipsstate-'))
  file = path.join(dir, 'state.json')
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('tipsState', () => {
  it('缺失文件返回默认', () => {
    expect(loadAppState(file)).toEqual({ startupCount: 0, tipsHistory: {} })
  })

  it('往返持久化', () => {
    saveAppState({ startupCount: 7, tipsHistory: { 'a': 3 } }, file)
    expect(loadAppState(file)).toEqual({ startupCount: 7, tipsHistory: { 'a': 3 } })
  })

  it('损坏 JSON 回落默认', () => {
    fs.writeFileSync(file, '{ not json')
    expect(loadAppState(file)).toEqual({ startupCount: 0, tipsHistory: {} })
  })

  it('字段类型异常被清洗', () => {
    fs.writeFileSync(file, JSON.stringify({ startupCount: -5, tipsHistory: { a: 'x', b: 2 } }))
    expect(loadAppState(file)).toEqual({ startupCount: 0, tipsHistory: { b: 2 } })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tipsState`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/tipsState.ts`**

```ts
// src/tipsState.ts — app 管理的可变运行态，独立于用户手写 settings.json
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STATE_FILE = path.join(os.homedir(), '.deepcode', 'state.json')

export interface AppState {
  startupCount: number
  tipsHistory: Record<string, number>
}

export function loadAppState(file: string = STATE_FILE): AppState {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const startupCount = typeof raw?.startupCount === 'number' && raw.startupCount >= 0 ? Math.floor(raw.startupCount) : 0
    const tipsHistory: Record<string, number> =
      raw?.tipsHistory && typeof raw.tipsHistory === 'object' && !Array.isArray(raw.tipsHistory)
        ? Object.fromEntries(Object.entries(raw.tipsHistory).filter(([, v]) => typeof v === 'number') as [string, number][])
        : {}
    return { startupCount, tipsHistory }
  } catch {
    return { startupCount: 0, tipsHistory: {} }
  }
}

export function saveAppState(state: AppState, file: string = STATE_FILE): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(state, null, 2))
  } catch { /* 持久化失败不阻断启动 */ }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- tipsState`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tipsState.ts test/tipsState.test.ts
git commit -m "feat(5.10): app 持久态 store（startupCount/tipsHistory → state.json）"
```

---

### Task 3: tips 选择逻辑 + 注册表（`src/tui/tips.ts`）

**Files:**
- Create: `src/tui/tips.ts`
- Test: `test/tips.test.ts`

**Interfaces:**
- Consumes: 无（纯逻辑）。
- Produces:
  - `interface Tip { id: string; content: string; cooldownSessions: number; isRelevant: (ctx: TipContext) => boolean }`
  - `interface TipContext { startupCount: number }`
  - `interface SpinnerTipsOverride { tips?: string[]; excludeDefault?: boolean }`
  - `const DEFAULT_TIPS: Tip[]`
  - `selectTip(input: { startupCount: number; tipsHistory: Record<string, number>; override?: SpinnerTipsOverride; rng?: () => number }): Tip | null`
  - `recordTipShown(id: string, startupCount: number, history: Record<string, number>): Record<string, number>`

- [ ] **Step 1: 写失败测试** `test/tips.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { selectTip, recordTipShown, DEFAULT_TIPS } from '../src/tui/tips.js'

describe('tips selectTip', () => {
  it('未显示过的 tip 可被选中（cooldown=Infinity 优先）', () => {
    const tip = selectTip({ startupCount: 1, tipsHistory: {}, rng: () => 0 })
    expect(tip).not.toBeNull()
    expect(DEFAULT_TIPS.some(t => t.id === tip!.id)).toBe(true)
  })

  it('冷却期内的 tip 被过滤', () => {
    // 所有默认 tip 都在上个会话显示过且 cooldown 未到 → 仅极个别可选；构造全冷却
    const history = Object.fromEntries(DEFAULT_TIPS.map(t => [t.id, 100]))
    const tip = selectTip({ startupCount: 101, tipsHistory: history, rng: () => 0 })
    // startupCount-100=1，小于所有 cooldown(>=3) → 全被过滤
    expect(tip).toBeNull()
  })

  it('isRelevant=false 被过滤（new-user-warmup 在 startupCount>=10 不相关）', () => {
    const onlyWarmup = selectTip({ startupCount: 50, tipsHistory: {}, rng: () => 0 })
    // rng=0 选第一个合格项；new-user-warmup 因 startupCount>=10 不相关，不会是它
    expect(onlyWarmup?.id).not.toBe('new-user-warmup')
  })

  it('excludeDefault 时仅返回自定义 tip', () => {
    const tip = selectTip({
      startupCount: 1, tipsHistory: {},
      override: { tips: ['我的提示'], excludeDefault: true }, rng: () => 0,
    })
    expect(tip?.content).toBe('我的提示')
    expect(tip?.id).toBe('custom-0')
  })

  it('全部被过滤返回 null', () => {
    const history = Object.fromEntries(DEFAULT_TIPS.map(t => [t.id, 1000]))
    const tip = selectTip({ startupCount: 1000, tipsHistory: history, rng: () => 0 })
    expect(tip).toBeNull()
  })

  it('rng 决定从合格集选哪个', () => {
    const a = selectTip({ startupCount: 1, tipsHistory: {}, rng: () => 0 })
    const b = selectTip({ startupCount: 1, tipsHistory: {}, rng: () => 0.999 })
    expect(a!.id).not.toBe(b!.id)
  })
})

describe('recordTipShown', () => {
  it('写入当前会话号且不可变', () => {
    const h0 = { x: 1 }
    const h1 = recordTipShown('y', 9, h0)
    expect(h1).toEqual({ x: 1, y: 9 })
    expect(h0).toEqual({ x: 1 }) // 原对象不变
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tips.test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/tui/tips.ts`**

```ts
// src/tui/tips.ts — spinner tips 选择逻辑（照搬 CC：按会话计数冷却去重）。纯逻辑。
export interface TipContext { startupCount: number }

export interface Tip {
  id: string
  content: string
  cooldownSessions: number
  isRelevant: (ctx: TipContext) => boolean
}

export interface SpinnerTipsOverride { tips?: string[]; excludeDefault?: boolean }

export const DEFAULT_TIPS: Tip[] = [
  { id: 'new-user-warmup', content: '从小功能或 bug 修复开始，让 deepcode 先给出计划，再核对它建议的改动', cooldownSessions: 3, isRelevant: c => c.startupCount < 10 },
  { id: 'plan-mode', content: '复杂任务先按 Shift+Tab 进入 Plan 模式，让它先规划再动手', cooldownSessions: 5, isRelevant: () => true },
  { id: 'git-worktree', content: '用 EnterWorktree 在隔离的 git 工作树里并行跑多条任务，互不干扰', cooldownSessions: 10, isRelevant: () => true },
  { id: 'model-switch', content: '用 /model 在 DeepSeek / GLM 各档位之间切换', cooldownSessions: 10, isRelevant: () => true },
  { id: 'memory', content: '用 /memory 查看和管理 deepcode 的跨会话记忆', cooldownSessions: 15, isRelevant: () => true },
  { id: 'fork-rename', content: '用 /fork 复制会话试不同思路，用 /rename 给会话起名区分', cooldownSessions: 10, isRelevant: () => true },
  { id: 'steering', content: 'deepcode 干活时直接打字回车即可补充或转向，无需先打断', cooldownSessions: 8, isRelevant: () => true },
  { id: 'compact', content: '上下文变长时用 /compact 压缩，保留要点后继续干活', cooldownSessions: 12, isRelevant: () => true },
]

function buildCustomTips(override?: SpinnerTipsOverride): Tip[] {
  if (!override?.tips?.length) return []
  return override.tips.map((content, i) => ({
    id: `custom-${i}`, content, cooldownSessions: 0, isRelevant: () => true,
  }))
}

export function selectTip(input: {
  startupCount: number
  tipsHistory: Record<string, number>
  override?: SpinnerTipsOverride
  rng?: () => number
}): Tip | null {
  const { startupCount, tipsHistory, override, rng = Math.random } = input
  const base = override?.excludeDefault ? [] : DEFAULT_TIPS
  const pool = [...base, ...buildCustomTips(override)]
  const ctx: TipContext = { startupCount }
  const eligible = pool.filter(t => {
    if (!t.isRelevant(ctx)) return false
    const last = tipsHistory[t.id]
    const sinceShown = last === undefined ? Infinity : startupCount - last
    return sinceShown >= t.cooldownSessions
  })
  if (eligible.length === 0) return null
  return eligible[Math.floor(rng() * eligible.length)]
}

export function recordTipShown(id: string, startupCount: number, history: Record<string, number>): Record<string, number> {
  return { ...history, [id]: startupCount }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- tips.test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tui/tips.ts test/tips.test.ts
git commit -m "feat(5.10): tips 选择逻辑 + 默认注册表（照搬 CC 冷却去重算法）"
```

---

### Task 4: config 配置字段 + 分层注册

**Files:**
- Modify: `src/config.ts`（Settings 接口加 2 字段；`loadRawUserSettings` 解析；新增 `parseSpinnerTipsOverride`）
- Modify: `src/settingsLayers.ts`（import + `parsePresent` 注册）
- Test: `test/config.spinnerTips.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `Settings.spinnerTips?: boolean`
  - `Settings.spinnerTipsOverride?: { tips?: string[]; excludeDefault?: boolean }`
  - `parseSpinnerTipsOverride(raw: unknown): { tips?: string[]; excludeDefault?: boolean } | undefined`（config.ts 导出，settingsLayers 复用）

- [ ] **Step 1: 写失败测试** `test/config.spinnerTips.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseSpinnerTipsOverride } from '../src/config.js'
import { loadLayeredSettings } from '../src/settingsLayers.js'

describe('parseSpinnerTipsOverride', () => {
  it('合法对象保留', () => {
    expect(parseSpinnerTipsOverride({ tips: ['a', 'b'], excludeDefault: true }))
      .toEqual({ tips: ['a', 'b'], excludeDefault: true })
  })
  it('过滤非字符串 tip', () => {
    expect(parseSpinnerTipsOverride({ tips: ['a', 1, null] })).toEqual({ tips: ['a'] })
  })
  it('空/非法 → undefined', () => {
    expect(parseSpinnerTipsOverride(null)).toBeUndefined()
    expect(parseSpinnerTipsOverride({})).toBeUndefined()
    expect(parseSpinnerTipsOverride([])).toBeUndefined()
  })
})

describe('spinnerTips 分层', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-spin-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('user scope spinnerTips=false 经分层保留', () => {
    const userDir = path.join(dir, 'home', '.deepcode')
    fs.mkdirSync(userDir, { recursive: true })
    // 用 flagPath 注入用户配置文件以隔离真实 ~/.deepcode
    const flag = path.join(dir, 'flag.json')
    fs.writeFileSync(flag, JSON.stringify({ spinnerTips: false, spinnerTipsOverride: { tips: ['x'] } }))
    const s = loadLayeredSettings(dir, flag).settings
    expect(s.spinnerTips).toBe(false)
    expect(s.spinnerTipsOverride).toEqual({ tips: ['x'] })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- config.spinnerTips`
Expected: FAIL（`parseSpinnerTipsOverride` 未导出 / 字段 undefined）

- [ ] **Step 3: config.ts 加字段 + 解析**

`Settings` 接口在 `worktree?: ...` 行后加：
```ts
  /** spinner tips 轮播开关（缺省 true）。纯 UX，非敏感，全层生效。 */
  spinnerTips?: boolean
  /** 自定义 spinner tips 覆盖（对齐 CC spinnerTipsOverride）。 */
  spinnerTipsOverride?: { tips?: string[]; excludeDefault?: boolean }
```

新增导出函数（放在 `parsePermissions` 附近）：
```ts
export function parseSpinnerTipsOverride(raw: unknown): { tips?: string[]; excludeDefault?: boolean } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const out: { tips?: string[]; excludeDefault?: boolean } = {}
  if (Array.isArray(r.tips)) {
    const tips = r.tips.filter((t): t is string => typeof t === 'string')
    if (tips.length) out.tips = tips
  }
  if (typeof r.excludeDefault === 'boolean') out.excludeDefault = r.excludeDefault
  return Object.keys(out).length ? out : undefined
}
```

`loadRawUserSettings` 返回对象里（`worktree: parseWorktreeConfig(raw?.worktree),` 后）加：
```ts
    spinnerTips: typeof raw?.spinnerTips === 'boolean' ? raw.spinnerTips : undefined,
    spinnerTipsOverride: parseSpinnerTipsOverride(raw?.spinnerTipsOverride),
```

- [ ] **Step 4: settingsLayers.ts 注册 parsePresent**

import 行（从 `'./config.js'` 导入处）追加 `parseSpinnerTipsOverride`。
`parsePresent` 内 `if ('worktree' in raw) {...}` 后加：
```ts
  if (typeof raw.spinnerTips === 'boolean') p.spinnerTips = raw.spinnerTips
  if ('spinnerTipsOverride' in raw) { const o = parseSpinnerTipsOverride(raw.spinnerTipsOverride); if (o) p.spinnerTipsOverride = o }
```

- [ ] **Step 5: 跑测试确认通过 + 回归**

Run: `npm test -- config.spinnerTips settingsLayers config`
Expected: PASS（含既有 config/settingsLayers 测试无回归）

- [ ] **Step 6: 提交**

```bash
git add src/config.ts src/settingsLayers.ts test/config.spinnerTips.test.ts
git commit -m "feat(5.10): Settings 加 spinnerTips/spinnerTipsOverride（非敏感，全层生效）"
```

---

### Task 5: Spinner 组件加 tip 渲染

**Files:**
- Modify: `src/tui/components/Spinner.tsx`
- Test: `test/spinner.test.ts`（扩展）

**Interfaces:**
- Consumes: 无新依赖。
- Produces: `SpinnerProps` 加 `tip?: string | null`；有 tip 且非 hookLabel 分支时，状态行下方渲染 `💡 {tip}`（dim 色）。

- [ ] **Step 1: 写失败测试**（追加到 `test/spinner.test.ts`）

```ts
import { render } from 'ink-testing-library'
import React from 'react'
import { Spinner } from '../src/tui/components/Spinner.js'

it('有 tip 时在状态行下方渲染 💡', () => {
  const { lastFrame } = render(
    React.createElement(Spinner, { turnStartAt: Date.now(), turnOutTokens: 0, tip: '用 /model 切换档位' }),
  )
  expect(lastFrame()).toContain('💡 用 /model 切换档位')
})

it('hookLabel 优先，tip 不显示', () => {
  const { lastFrame } = render(
    React.createElement(Spinner, { turnStartAt: Date.now(), turnOutTokens: 0, hookLabel: '正在运行 Stop 钩子…', tip: 'X' }),
  )
  expect(lastFrame()).toContain('正在运行 Stop 钩子…')
  expect(lastFrame()).not.toContain('💡')
})

it('无 tip 不渲染 💡', () => {
  const { lastFrame } = render(
    React.createElement(Spinner, { turnStartAt: Date.now(), turnOutTokens: 0 }),
  )
  expect(lastFrame()).not.toContain('💡')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- spinner`
Expected: FAIL（无 💡 渲染）

- [ ] **Step 3: 改 `src/tui/components/Spinner.tsx`**

import 行改为引入 `Box`：
```ts
import { Text, Box } from 'ink'
```
`SpinnerProps` 加字段：
```ts
interface SpinnerProps {
  turnStartAt: number | null
  turnOutTokens: number
  hookLabel?: string | null
  tip?: string | null
}
```
函数签名解构加 `tip`，return 改为 Box 列布局（hookLabel 分支不变）：
```ts
export function Spinner({ turnStartAt, turnOutTokens, hookLabel, tip }: SpinnerProps) {
  // …（symIdx/tick/verb/effect 不变）…
  if (hookLabel) {
    return <Text color={T.accent}>{symbol} {hookLabel}</Text>
  }
  return (
    <Box flexDirection="column">
      <Text color={T.accent}>
        {symbol} {verb}… ({fmtElapsed(elapsed)} · ↓ {fmtTokens(turnOutTokens)} tokens · esc 中断)
      </Text>
      {tip ? <Text color={T.dim}>💡 {tip}</Text> : null}
    </Box>
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- spinner`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tui/components/Spinner.tsx test/spinner.test.ts
git commit -m "feat(5.10): Spinner 状态行下方渲染 tip（dim，hookLabel 优先）"
```

---

### Task 6: useChat 启动选 tip + ChatState 接线

**Files:**
- Modify: `src/tui/useChat.ts`（import；启动 bump+select；`ChatState` 加 `spinnerTip`；状态快照加 `spinnerTip`）
- Test: `test/useChat.spinnerTip.test.ts`

**Interfaces:**
- Consumes: `loadAppState`/`saveAppState`（Task 2）、`selectTip`/`recordTipShown`（Task 3）、`Settings.spinnerTips`/`spinnerTipsOverride`（Task 4）。
- Produces: `ChatState.spinnerTip: string | null`（会话固定，启动算一次）。

- [ ] **Step 1: 写失败测试** `test/useChat.spinnerTip.test.ts`

> 说明：useChat 是重型 hook，难以整体渲染。本测试覆盖**启动副作用纯逻辑**——抽出的 `computeSpinnerTip` 辅助（在 Step 3 一并导出），验证 bump + select + 持久化 record。

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { computeSpinnerTip } from '../src/tui/useChat.js'

let file: string
beforeEach(() => { file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-uct-')), 'state.json') })
afterEach(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }))

describe('computeSpinnerTip', () => {
  it('spinnerTips=false 时返回 null 且不写盘', () => {
    expect(computeSpinnerTip({ spinnerTips: false }, file, () => 0)).toBeNull()
    expect(fs.existsSync(file)).toBe(false)
  })

  it('默认开启：选一条 tip 并持久化 startupCount+1 与历史', () => {
    const tip = computeSpinnerTip({}, file, () => 0)
    expect(typeof tip).toBe('string')
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(saved.startupCount).toBe(1)
    expect(Object.keys(saved.tipsHistory).length).toBe(1)
  })

  it('连续两次启动：startupCount 递增', () => {
    computeSpinnerTip({}, file, () => 0)
    computeSpinnerTip({}, file, () => 0)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).startupCount).toBe(2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- useChat.spinnerTip`
Expected: FAIL（`computeSpinnerTip` 未导出）

- [ ] **Step 3: 改 `src/tui/useChat.ts`**

文件顶部 import 区加：
```ts
import { loadAppState, saveAppState } from '../tipsState.js'
import { selectTip, recordTipShown } from './tips.js'
import type { Settings } from '../config.js'
```
（若 `Settings` 已 import 则复用，勿重复。）

新增导出辅助（放在 `ChatState` 接口附近的模块作用域，便于单测）：
```ts
/** 启动时算一次 spinner tip：递增会话计数→按冷却选一条→记录历史→持久化。返回 tip 文案或 null。 */
export function computeSpinnerTip(
  settings: Pick<Settings, 'spinnerTips' | 'spinnerTipsOverride'>,
  stateFile?: string,
  rng?: () => number,
): string | null {
  if (settings.spinnerTips === false) return null
  const st = stateFile ? loadAppState(stateFile) : loadAppState()
  st.startupCount += 1
  const tip = selectTip({ startupCount: st.startupCount, tipsHistory: st.tipsHistory, override: settings.spinnerTipsOverride, rng })
  if (tip) st.tipsHistory = recordTipShown(tip.id, st.startupCount, st.tipsHistory)
  if (stateFile) saveAppState(st, stateFile); else saveAppState(st)
  return tip?.content ?? null
}
```

`ChatState` 接口（line ~185，`hookProgress` 附近）加：
```ts
  spinnerTip: string | null // 5.10 本会话固定显示的 tip（null=关闭/无合格）
```

在 useChat 函数体内（`settings` 可用之后、状态快照构建之前，建议紧邻 `let hookProgress` 声明处）加：
```ts
  const spinnerTip: string | null = computeSpinnerTip(settings)
```

状态快照对象（line ~366，含 `hookProgress` 的那个字面量）加入 `spinnerTip`：
```ts
    …, hookProgress, spinnerTip, sessionCost, …
```

- [ ] **Step 4: 跑测试确认通过 + useChat 回归**

Run: `npm test -- useChat.spinnerTip useChat`
Expected: PASS（既有 useChat 测试无回归）

- [ ] **Step 5: 提交**

```bash
git add src/tui/useChat.ts test/useChat.spinnerTip.test.ts
git commit -m "feat(5.10): 启动算一次 spinnerTip 入 ChatState（每会话固定）"
```

---

### Task 7: App + FullscreenApp 双接线

**Files:**
- Modify: `src/tui/App.tsx:285`
- Modify: `src/tui/FullscreenApp.tsx:314`

**Interfaces:**
- Consumes: `ChatState.spinnerTip`（Task 6）、Spinner `tip` prop（Task 5）。
- Produces: 两个 App 的 `<Spinner/>` 传入 `tip={state.spinnerTip}`。

- [ ] **Step 1: 改 App.tsx:285**

```tsx
              {state.busy && <Spinner turnStartAt={state.turnStartAt} turnOutTokens={state.turnOutTokens} hookLabel={state.hookProgress} tip={state.spinnerTip} />}
```

- [ ] **Step 2: 改 FullscreenApp.tsx:314**

```tsx
                {state.busy && <Spinner turnStartAt={state.turnStartAt} turnOutTokens={state.turnOutTokens} hookLabel={state.hookProgress} tip={state.spinnerTip} />}
```

- [ ] **Step 3: 全量构建 + 测试**

Run: `npm run build && npm test`
Expected: tsc 无错；全测试 PASS。

- [ ] **Step 4: 提交**

```bash
git add src/tui/App.tsx src/tui/FullscreenApp.tsx
git commit -m "feat(5.10): App + FullscreenApp 双接线 spinnerTip"
```

---

## 真机冒烟（合并前，碰 TUI）

> 用**本地构建**跑，勿用全局旧版：`node /Users/silas/loop/deepcode/dist/index.js`（欢迎页确认 v0.8.0 + 工具列表含 Sleep）。

1. **Sleep 可打断**：让模型「sleep 30 秒」→ 看到等待 → 按 ESC/或回车补充消息 → 确认软中断后返回「已中断等待（已过 N 秒）」并续跑。
2. **Sleep 完成**：「sleep 3 秒然后说完成」→ 确认 3 秒后返回「已等待 3 秒」。
3. **tips 显示**：启动后发任意消息触发 busy → spinner 下方出现 `💡 …` 一条，整会话不变。
4. **tips 跨会话轮换**：`/clear` 或重启 → 出现**另一条** tip（冷却去重生效）。
5. **关闭开关**：`~/.deepcode/settings.json` 设 `"spinnerTips": false` → 重启 → 无 💡 行。
6. 截图回传 4 处（Sleep 中断、tips 显示、跨会话换 tip、关闭后无 tip）。

---

## Self-Review 记录

- **Spec 覆盖**：4.3 Sleep（Task 1）✅；5.10 tips 全链路——持久态（T2）/选择逻辑（T3）/配置（T4）/渲染（T5）/启动接线（T6）/双 App（T7）✅。D1 单位 seconds≤3600（T1 schema）✅；D2 每会话固定（T6 启动算一次）✅；D3 dim 行（T5）✅；D4 无 tick（T1 描述）✅。
- **类型一致性**：`computeSpinnerTip` 签名（T6）↔ `selectTip`/`recordTipShown`（T3）↔ `loadAppState`/`saveAppState`（T2）↔ `Settings.spinnerTips*`（T4）↔ `ChatState.spinnerTip`（T6）↔ Spinner `tip`（T5）逐一对齐。
- **占位符扫描**：无 TODO/「类似上文」；每步含真实代码。
- **风险**：T6 `computeSpinnerTip` 在 useChat 函数体调用位置须确保 `settings` 已就绪——置于 `hookProgress` 声明附近（settings 早于该处可用）。冒烟前 `npm run build` 验 tsc。
