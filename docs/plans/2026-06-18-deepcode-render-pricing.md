# 显示层批（A 批）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修 deepcode 3 个显示层问题：markdown 表格 CJK 列宽、流式渐进渲染、人民币计费。

**Architecture:** 纯逻辑优先（表格宽度、splitStablePrefix、CNY 定价可单测），再接 TUI（StreamingMarkdown 组件、$→¥ 展示）。

**Tech Stack:** TypeScript/ESM、vitest、ink5、marked、cli-highlight、string-width（已传递依赖）。

## Global Constraints

- `string-width@7.2.0` 已是传递依赖，直接 `import stringWidth from 'string-width'`（ESM）。
- 人民币单价（每百万 token，官方核实）：flash hit ¥0.02 / miss ¥1 / out ¥2；pro hit ¥0.025 / miss ¥3 / out ¥6。
- `costWarnUSD` 旧配置键须向后兼容（`raw?.costWarnCNY ?? raw?.costWarnUSD ?? 15`）。
- 流式 item（done:false）不在 ink Static 区，useRef 跨 delta 持久（已核实）。
- 不加 scope、ESM `.js` 后缀。纯逻辑免冒烟；碰 TUI（#1 组件、#4 展示）合 main 前用户真机冒烟。
- 每任务跑该任务测试 + `npm run -s typecheck`；全批完成跑全量 test+typecheck+build。

---

### Task 1: 表格 CJK 列宽修复（#2）

**Files:**
- Modify: `src/tui/markdown.ts`（`table()` + 顶部 import + 删除 :4 限制注释）
- Test: `test/markdown.test.ts`（新建）

**Interfaces:**
- 无对外新接口（`table()` 是模块内私有，经 `renderMarkdown` 暴露）。

- [ ] **Step 1: Write the failing test**

新建 `test/markdown.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import stringWidth from 'string-width'
import { renderMarkdown } from '../src/tui/markdown.js'

describe('renderMarkdown 表格 CJK 列宽', () => {
  it('中文单元格各行到分隔符的显示宽度一致（列对齐）', () => {
    const md = '| 名称 | 说明 |\n| --- | --- |\n| 模型切换 | 改档位 |\n| a | b |'
    const out = renderMarkdown(md)
    // 去 ANSI 转义后按行取第一列内容（到第一个 │ 之前），各行显示宽度应相等
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
    const lines = stripAnsi(out).split('\n').filter(l => l.includes('│'))
    const firstColWidths = lines.map(l => stringWidth(l.slice(0, l.indexOf('│'))))
    expect(new Set(firstColWidths).size).toBe(1) // 所有行第一列等宽
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/markdown.test.ts`
Expected: FAIL —— CJK 行第一列宽度与纯 ASCII 行不等（`.length` 偏差）。

- [ ] **Step 3: Implement**

`src/tui/markdown.ts`：

3a. 顶部 import 后加：

```typescript
import { highlight, supportsLanguage } from 'cli-highlight'
import stringWidth from 'string-width'
```

3b. `table()` 内列宽（现 `.length`）改：

```typescript
  const widths = headerCells.map((_, i) =>
    Math.max(...allRows.map(r => stringWidth(r[i] ?? '')))
  )

  const padToWidth = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - stringWidth(s)))

  const line = (cells: string[], bold = false) =>
    cells
      .map((c, i) => (bold ? B : '') + padToWidth(c ?? '', widths[i]) + R)
      .join(` ${DIM}│${R} `)
```

3c. 删除文件顶部 :4-5 那条「CJK 全角字符在 padEnd 下…v1 接受此偏差」的已知限制注释（已修复）。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/markdown.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/tui/markdown.ts test/markdown.test.ts
git commit -m "fix(#2): markdown 表格用 string-width 修 CJK 列宽对齐"
```

---

### Task 2: 人民币定价核心（#4a pricing.ts）

**Files:**
- Modify: `src/pricing.ts`
- Test: `test/pricing.test.ts`

**Interfaces:**
- Produces: `costCNY(model, promptTokens, cacheHit, output): number`（替 `costUSD`）；`cacheSavingsCNY(model, hitTokens): number`（替 `cacheSavingsUSD`）。PRICES 为 CNY 单价。

- [ ] **Step 1: Update tests（先改测试为 CNY 期望，使其失败）**

把 `test/pricing.test.ts` 的 import 与调用从 `costUSD`/`cacheSavingsUSD` 改为 `costCNY`/`cacheSavingsCNY`，期望值按 CNY 单价重算：

```typescript
import { costCNY, cacheSavingsCNY } from '../src/pricing.js'

describe('costCNY', () => {
  it('flash：命中/未命中/输出 分别计费（CNY）', () => {
    // flash CNY: hit 0.02, miss 1, out 2。prompt=1000(hit 800,miss 200),out 500
    // = (800*0.02 + 200*1 + 500*2)/1e6 = (16 + 200 + 1000)/1e6 = 0.001216
    expect(costCNY('deepseek-v4-flash', 1000, 800, 500)).toBeCloseTo(0.001216, 8)
  })
  it('未知模型返回 0', () => {
    expect(costCNY('gpt-4o', 10000, 5000, 500)).toBe(0)
  })
})

describe('cacheSavingsCNY', () => {
  it('flash：缓存命中省下 = hitTokens × (miss − hit) / 1e6（CNY）', () => {
    // (1 − 0.02) = 0.98；800 × 0.98 / 1e6 = 0.000784
    expect(cacheSavingsCNY('deepseek-v4-flash', 800)).toBeCloseTo(0.000784, 8)
  })
  it('未知模型 0 / hitTokens 0 → 0', () => {
    expect(cacheSavingsCNY('gpt-4o', 10000)).toBe(0)
    expect(cacheSavingsCNY('deepseek-v4-flash', 0)).toBe(0)
  })
})
```

（删除旧 `costUSD`/`cacheSavingsUSD` 的用例。）

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pricing.test.ts`
Expected: FAIL —— `costCNY`/`cacheSavingsCNY` 未导出。

- [ ] **Step 3: Implement pricing.ts**

把 `src/pricing.ts` 改为（CNY 单价 + 函数改名，注释更新）：

```typescript
// src/pricing.ts
// 每百万 token 单价（CNY，人民币），核实自 https://api-docs.deepseek.com/zh-cn/quick_start/pricing
const PRICES: Record<string, { hit: number; miss: number; out: number }> = {
  'deepseek-v4-flash': { hit: 0.02, miss: 1, out: 2 },
  'deepseek-v4-pro': { hit: 0.025, miss: 3, out: 6 },
}

/**
 * 计算一次调用的人民币成本。
 * promptTokens 是总输入；cacheHit 是其中命中前缀缓存的部分；其余按未命中计价。
 * 未知模型返回 0。
 */
export function costCNY(model: string, promptTokens: number, cacheHit: number, output: number): number {
  const p = PRICES[model]
  if (!p) return 0
  const miss = Math.max(0, promptTokens - cacheHit)
  return (cacheHit * p.hit + miss * p.miss + output * p.out) / 1_000_000
}

/**
 * 缓存命中省下的人民币金额：命中的 hitTokens 若按未命中价计本要多花的钱。
 * = hitTokens × (miss − hit) / 1e6。未知模型返回 0。
 */
export function cacheSavingsCNY(model: string, hitTokens: number): number {
  const p = PRICES[model]
  if (!p) return 0
  return (hitTokens * (p.miss - p.hit)) / 1_000_000
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pricing.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/pricing.ts test/pricing.test.ts
git commit -m "feat(#4): pricing 改人民币（costCNY/cacheSavingsCNY + CNY 单价）"
```

> 注：本 commit 后 useChat/stats 等仍 import 旧名，typecheck 会红——Task 3 接线修复。subagent-driven 控制者知悉，Task 2/3 紧邻。

---

### Task 3: 人民币展示接线 + config 向后兼容（#4b）

**Files:**
- Modify: `src/config.ts`、`src/tui/useChat.ts`、`src/stats.ts`、`src/tui/components/StatusFooter.tsx`、`src/tui/renderItem.tsx`、`src/headless.ts`
- Test: `test/stats.test.ts`、`test/config.test.ts`（及任何引用旧名的测试）

**Interfaces:**
- Consumes: `costCNY`/`cacheSavingsCNY`（Task 2）。
- Produces: `Settings.costWarnCNY: number`（替 `costWarnUSD`，读取向后兼容旧键）。

- [ ] **Step 1: 改 config（含向后兼容）**

`src/config.ts`：`Settings` 接口 `costWarnUSD: number` → `costWarnCNY: number`；`loadSettings` 返回：

```typescript
    costWarnCNY: raw?.costWarnCNY ?? raw?.costWarnUSD ?? 15,
```

- [ ] **Step 2: 改所有展示点 + import 名**

2a. `src/tui/useChat.ts`：
- import：`import { costCNY, cacheSavingsCNY } from '../pricing.js'`
- `sessionCost` 内 `costUSD(...)` → `costCNY(...)`
- `cacheSavings` 内 `cacheSavingsUSD(...)` → `cacheSavingsCNY(...)`
- `/cost` 输出 `$${sessionCost()...}` → `¥${sessionCost()...}`
- costWarn 提醒：`settings.costWarnUSD` → `settings.costWarnCNY`，文字 `$` → `¥`，「阈值在 settings.json 的 costWarnUSD」→「costWarnCNY」

2b. `src/stats.ts`：`formatStats` 的 `估算花费：$${cost...}` → `¥${cost...}`。

2c. `src/tui/components/StatusFooter.tsx`：Row 2 两处 `−$${...}` / `· $${...}` → `−¥` / `· ¥`。

2d. `src/tui/renderItem.tsx`：usage 行 `${item.out} tokens · $${item.cost...}` → `· ¥`。

2e. `src/headless.ts`：返回结构字段 `costUSD` → `costCNY`（3 处，:32/:92/:139 附近，按实际定位），值用 `costCNY(...)`。

- [ ] **Step 3: 改受影响测试**

3a. `test/stats.test.ts:118` `expect(out).toContain('$0.001234')` → `'¥0.001234'`（确认 formatStats 入参不变、仅符号变）。
3b. `test/config.test.ts`：构造 Settings 的 fixture `costWarnUSD` → `costWarnCNY`（核实实际字段）；加一条向后兼容用例：旧键 `costWarnUSD` 仍被 `loadSettings` 读取（如可注入 raw 测，或断言 `?? raw?.costWarnUSD`）。
3c. grep 全测试目录 `costUSD\|cacheSavingsUSD\|costWarnUSD`，把残留引用改为新名（headless.skill.test 等 fixture）。

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run -s typecheck`
Expected: 全绿 + typecheck 0（Task 2 引入的红此时消除）。

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/tui/useChat.ts src/stats.ts src/tui/components/StatusFooter.tsx src/tui/renderItem.tsx src/headless.ts test/stats.test.ts test/config.test.ts
git commit -m "feat(#4): 费用展示 \$→¥ + costWarnCNY（向后兼容旧 costWarnUSD 键）"
```

---

### Task 4: splitStablePrefix 纯函数 + 抽出 withBullet（#1a）

**Files:**
- Create: `src/tui/streamingMarkdown.ts`（splitStablePrefix）
- Create: `src/tui/withBullet.tsx`（从 renderItem 抽出，复用）
- Modify: `src/tui/renderItem.tsx`（改 import withBullet）
- Test: `test/streamingMarkdown.test.ts`（新建）

**Interfaces:**
- Produces: `splitStablePrefix(text: string): { stable: string; unstable: string }`；`withBullet(content: string): React.ReactNode`（移到独立模块）。

- [ ] **Step 1: Write the failing test**

新建 `test/streamingMarkdown.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { splitStablePrefix } from '../src/tui/streamingMarkdown.js'

describe('splitStablePrefix', () => {
  it('单段落（仍可能增长）→ 全 unstable', () => {
    expect(splitStablePrefix('hello world')).toEqual({ stable: '', unstable: 'hello world' })
  })
  it('标题 + 段落 → 标题进 stable、末段留 unstable', () => {
    const r = splitStablePrefix('# 标题\n\n正文还在写')
    expect(r.stable).toContain('# 标题')
    expect(r.unstable).toContain('正文还在写')
  })
  it('未闭合代码围栏 → 全 unstable（不误切）', () => {
    const r = splitStablePrefix('```js\nconst a = 1')
    expect(r.stable).toBe('')
    expect(r.unstable).toContain('```js')
  })
  it('空文本', () => {
    expect(splitStablePrefix('')).toEqual({ stable: '', unstable: '' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/streamingMarkdown.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: Implement splitStablePrefix**

新建 `src/tui/streamingMarkdown.ts`：

```typescript
// 流式 markdown 增量渲染：把文本切成「已稳定前缀」（除最后一个块外的所有块）+「不稳定末尾」（正在增长的块）。
import { marked } from 'marked'

/** 用 marked 词法切分：除最后一个 token 外的都算已稳定（其 raw 累加为边界）。异常/单块 → 全 unstable。 */
export function splitStablePrefix(text: string): { stable: string; unstable: string } {
  let tokens
  try { tokens = marked.lexer(text) } catch { return { stable: '', unstable: text } }
  if (tokens.length <= 1) return { stable: '', unstable: text }
  let advance = 0
  for (let i = 0; i < tokens.length - 1; i++) advance += (tokens[i].raw ?? '').length
  return { stable: text.slice(0, advance), unstable: text.slice(advance) }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/streamingMarkdown.test.ts`
Expected: PASS。

- [ ] **Step 5: 抽出 withBullet 到独立模块**

新建 `src/tui/withBullet.tsx`，把 `renderItem.tsx:20` 的 `withBullet` 函数整体移过来（含 `import React from 'react'`、`import { Box, Text } from 'ink'`、`import { T } from './theme.js'`），改 `function withBullet` 为 `export function withBullet`。

`src/tui/renderItem.tsx`：删除本地 `withBullet` 定义，改为 `import { withBullet } from './withBullet.js'`。

- [ ] **Step 6: Run tests + typecheck**

Run: `npm run -s typecheck && npx vitest run test/streamingMarkdown.test.ts`
Expected: typecheck 0 + PASS（renderItem 既有行为不变，withBullet 仅换位置）。

- [ ] **Step 7: Commit**

```bash
git add src/tui/streamingMarkdown.ts src/tui/withBullet.tsx src/tui/renderItem.tsx test/streamingMarkdown.test.ts
git commit -m "feat(#1): splitStablePrefix 纯函数 + 抽出 withBullet 共享模块"
```

---

### Task 5: StreamingMarkdown 组件 + 接线 renderItem（#1b）

**Files:**
- Modify: `src/tui/streamingMarkdown.ts`（加 React 组件）
- Modify: `src/tui/renderItem.tsx`（流式 assistant 分支）
- Test: 组件渲染靠真机冒烟（纯逻辑 splitStablePrefix 已 Task 4 测）

**Interfaces:**
- Consumes: `splitStablePrefix`（Task 4）、`renderMarkdown`（markdown.ts）、`withBullet`（Task 4 抽出）。
- Produces: `StreamingMarkdown({ text }: { text: string }): React.ReactNode`。

- [ ] **Step 1: 实现 StreamingMarkdown 组件**

在 `src/tui/streamingMarkdown.ts` 顶部加 React/ink import 与组件（文件改名语义仍可 `.ts`，但含 JSX 需 `.tsx`——**把文件重命名为 `src/tui/streamingMarkdown.tsx`**，更新 Task 4 的 import 路径 `./streamingMarkdown.js` 不变，仅磁盘扩展名变）：

```tsx
import React, { useRef, useMemo } from 'react'
import { renderMarkdown } from './markdown.js'
import { withBullet } from './withBullet.js'

/** 流式 markdown 增量渲染：稳定前缀缓存不重解析、不稳定末尾每次重算，带 ⏺ 项目符号。 */
export function StreamingMarkdown({ text }: { text: string }): React.ReactNode {
  const boundaryRef = useRef(0)
  const { stable, unstable } = splitStablePrefix(text)
  // 边界单调前进：取已算 stable 与历史最大值的较大者，防 lexer 抖动回退
  if (stable.length > boundaryRef.current) boundaryRef.current = stable.length
  const stablePrefix = text.slice(0, boundaryRef.current)
  const unstableSuffix = text.slice(boundaryRef.current)
  const stableAnsi = useMemo(() => renderMarkdown(stablePrefix), [stablePrefix])
  const unstableAnsi = unstableSuffix ? renderMarkdown(unstableSuffix) : ''
  const joined = stableAnsi && unstableAnsi ? `${stableAnsi}\n\n${unstableAnsi}` : stableAnsi + unstableAnsi
  return withBullet(joined)
}
```

（`splitStablePrefix` 同文件，无需 import。`unstable` 解构未直接用可去掉，用 boundaryRef 驱动切分。）

- [ ] **Step 2: 接线 renderItem 流式分支**

`src/tui/renderItem.tsx`：
- 顶部加 `import { StreamingMarkdown } from './streamingMarkdown.js'`。
- 流式 assistant 分支（现 `return <Box key={index}>{withBullet(item.text)}</Box>`）改为：

```tsx
      // 进行中：流式增量 markdown 渲染（稳定前缀缓存 + 末尾重算）
      return <Box key={index}><StreamingMarkdown text={item.text} /></Box>
```

（done 分支不变。renderItem 若不再直接用 withBullet 则删其 import；若 done 分支仍用则保留。）

- [ ] **Step 3: typecheck + build + 全量测试**

Run: `npm run -s typecheck && npm run -s build && npm test 2>&1 | grep -E "Tests "`
Expected: typecheck 0、build 0、全部测试 PASS。

- [ ] **Step 4: Commit**

```bash
git add src/tui/streamingMarkdown.tsx src/tui/renderItem.tsx
git commit -m "feat(#1): StreamingMarkdown 组件接线流式渐进渲染（对齐 CC）"
```

---

### 收尾：全量验证 + 真机冒烟

- [ ] **全量 test + typecheck + build**

Run: `npm test && npm run -s typecheck && npm run -s build`
Expected: 全绿。

- [ ] **真机冒烟（碰 TUI）**

用户 `npm start`：①流式回复**边流边渲染富文本**（标题/列表/粗体即时生效，不再先显示 markdown 源码）②中文 markdown 表格列对齐 ③状态行 / `/cost` / `/stats` 显示 `¥` 且数值合理。

## Self-Review

- **Spec coverage**：#2→Task 1；#4→Task 2+3；#1→Task 4+5。全覆盖。
- **Placeholder scan**：每步含完整代码；headless `$`/字段定位注明「按实际定位」因行号漂移，代码内容完整。
- **Type consistency**：`costCNY`/`cacheSavingsCNY`（Task 2）↔ useChat/stats/headless 调用（Task 3）一致；`splitStablePrefix`（Task 4）↔ StreamingMarkdown（Task 5）一致；`withBullet` 抽出（Task 4）↔ StreamingMarkdown import（Task 5）一致；`costWarnCNY`（Task 3 config）↔ useChat 读取一致。
- **任务顺序**：Task 2（pricing 改名，故意留 typecheck 红）→ Task 3（接线消红）必须紧邻；Task 4（splitStablePrefix + withBullet 抽出）→ Task 5（组件用二者）。Task 1 独立。注意 Task 2 单独 commit 后 typecheck 红是有意的（计划已注明），Task 3 修复。
