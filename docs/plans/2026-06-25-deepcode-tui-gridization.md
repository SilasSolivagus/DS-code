# TUI 输出栅格化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 deepcode TUI 输出加 CC 同款垂直节奏——块间空一行、`⏺` 紧贴 `⎿`、左右各 1 列 gutter、页脚逻辑分组。

**Architecture:** 集中式间距 + theme 常量（`GUTTER`/`BLOCK_GAP`）。块间距在容器层（内联 `Transcript` + 全屏 `ScrollView`）按「每个块 `marginTop`」统一注入，`renderItem` 内部一行不改。gutter 用主容器 `paddingX`。两条渲染路径都改、都冒烟。

**Tech Stack:** TypeScript / ESM / ink5 / vitest / ink-testing-library。

## Global Constraints

- **TUI 双组件铁律**：改任何渲染接线，`src/tui/App.tsx`（内联）与 `src/tui/FullscreenApp.tsx`（默认全屏）**必须双改并都冒烟**。
- **块间距只由「块的 `marginTop`」承担**，banner 不加 `marginBottom`（否则 banner↔首块出现双空行）。`⎿` 预览留在 `ToolLine` 内、紧贴 `⏺`，**块内不动**。
- **间距值固定**：`GUTTER=1`、`BLOCK_GAP=1`（不做响应式）。
- **不改 markdown 内部渲染**；**不重构 ToolLine/markdown 既有缩进常量**（YAGNI，避免动 `⎿  ` 测试断言；缩进统一推迟）。
- 现有回归测试 `test/tui.transcript.test.tsx` 的 `⎿  ` 子串、`UNIQUE-PREVIEW`/`saved-file.ts` 计次断言**不可破**。
- 用本地构建冒烟：`node /Users/silas/loop/deepcode/dist/index.js`（欢迎页确认 v0.8.0）。

---

### Task 1: theme 间距常量

**Files:**
- Modify: `src/tui/theme.ts`（文件末尾追加导出）
- Test: `test/tui.theme.spacing.test.ts`

**Interfaces:**
- Produces: `export const GUTTER = 1`、`export const BLOCK_GAP = 1`（供 Transcript/ScrollView/App/FullscreenApp 引用）。

- [ ] **Step 1: 写失败测试** `test/tui.theme.spacing.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { GUTTER, BLOCK_GAP } from '../src/tui/theme.js'

describe('间距常量', () => {
  it('GUTTER=1 BLOCK_GAP=1', () => {
    expect(GUTTER).toBe(1)
    expect(BLOCK_GAP).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tui.theme.spacing`
Expected: FAIL（`GUTTER` 未导出）

- [ ] **Step 3: 在 `src/tui/theme.ts` 末尾追加**

```ts
// 栅格化间距常量（对齐 CC 垂直节奏）：单一事实源。
export const GUTTER = 1     // 主容器左右 paddingX（左右各留 1 列）
export const BLOCK_GAP = 1  // transcript 块间 marginTop（块与块之间空一行）
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- tui.theme.spacing`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tui/theme.ts test/tui.theme.spacing.test.ts
git commit -m "feat(tui): 间距常量 GUTTER/BLOCK_GAP（栅格化单一事实源）"
```

---

### Task 2: 内联 Transcript 块间距

**Files:**
- Modify: `src/tui/components/Transcript.tsx`
- Test: `test/tui.gridization.test.tsx`

**Interfaces:**
- Consumes: `BLOCK_GAP`（Task 1）。
- Produces: 内联路径下相邻 transcript 块之间有 1 行空行（banner 即 Static 首项不顶空行）。

- [ ] **Step 1: 写失败测试** `test/tui.gridization.test.tsx`

```tsx
import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { Transcript } from '../src/tui/components/Transcript.js'
import type { TranscriptItem } from '../src/tui/useChat.js'

/** frame 中 a、b 两行之间至少夹一行空白 */
function hasBlankBetween(frame: string, a: string, b: string): boolean {
  const lines = frame.split('\n')
  const ia = lines.findIndex(l => l.includes(a))
  const ib = lines.findIndex(l => l.includes(b))
  if (ia < 0 || ib < 0 || ib <= ia) return false
  return lines.slice(ia + 1, ib).some(l => l.trim() === '')
}

describe('Transcript 块间距', () => {
  it('相邻两块之间有空行', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', text: 'AAA-PROMPT' } as TranscriptItem,
      { kind: 'notice', level: 'info', text: 'BBB-NOTICE' } as TranscriptItem,
    ]
    const { lastFrame } = render(<Transcript items={items} />)
    expect(hasBlankBetween(lastFrame()!, 'AAA-PROMPT', 'BBB-NOTICE')).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tui.gridization`
Expected: FAIL（两块紧贴，无空行）

- [ ] **Step 3: 改 `src/tui/components/Transcript.tsx`**

import 行加 `BLOCK_GAP`：
```ts
import { useTheme, BLOCK_GAP } from '../theme.js'
```
Static 区每项 Box 加 `marginTop`（首项 banner 不顶空行）：
```tsx
      <Static items={staticItems}>
        {(item, index) => (
          <Box key={index} marginTop={index === 0 ? 0 : BLOCK_GAP}>
            {'__banner' in item ? banner : renderItem(item, index, theme)}
          </Box>
        )}
      </Static>
```
Live 区每项包一层 marginTop（live 区上方恒有 banner/done 项，故首项也留分隔）：
```tsx
      <Box flexDirection="column">
        {liveItems.map((item, i) => (
          <Box key={i} marginTop={BLOCK_GAP}>{renderItem(item, items.indexOf(item), theme)}</Box>
        ))}
      </Box>
```

- [ ] **Step 4: 跑测试 + transcript 回归**

Run: `npm test -- tui.gridization tui.transcript`
Expected: PASS（含既有 transcript 回归：`⎿  `、`UNIQUE-PREVIEW`/`saved-file.ts` 计次仍各为 1，Static 去重不重复输出空行）

- [ ] **Step 5: 提交**

```bash
git add src/tui/components/Transcript.tsx test/tui.gridization.test.tsx
git commit -m "feat(tui): 内联 Transcript 块间空行（块 marginTop）"
```

---

### Task 3: 全屏 ScrollView 块间距

**Files:**
- Modify: `src/tui/ScrollView.tsx`
- Test: `test/tui.gridization.test.tsx`（追加）

**Interfaces:**
- Consumes: `BLOCK_GAP`（Task 1）。
- Produces: 全屏路径下相邻 transcript 块之间有 1 行空行；banner 与首块之间也空一行（banner 无 margin，首块 marginTop 提供间隔）。

- [ ] **Step 1: 追加失败测试**（到 `test/tui.gridization.test.tsx`）

```tsx
import { ScrollView } from '../src/tui/ScrollView.js'

describe('ScrollView 块间距', () => {
  it('相邻两块之间有空行', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', text: 'CCC-PROMPT' } as TranscriptItem,
      { kind: 'notice', level: 'info', text: 'DDD-NOTICE' } as TranscriptItem,
    ]
    const { lastFrame } = render(
      <ScrollView items={items} scrollOffset={0} height={20} onMeasureTotal={() => {}} />,
    )
    expect(hasBlankBetween(lastFrame()!, 'CCC-PROMPT', 'DDD-NOTICE')).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tui.gridization`
Expected: FAIL（ScrollView 两块紧贴）

- [ ] **Step 3: 改 `src/tui/ScrollView.tsx`**

import 行加 `BLOCK_GAP`：
```ts
import { useTheme, BLOCK_GAP } from './theme.js'
```
items map 每项包 marginTop（每项都加，使 banner↔首块也空一行）：
```tsx
      <Box ref={innerRef} flexDirection="column" flexShrink={0} marginTop={-props.scrollOffset}>
        {props.banner}
        {props.items.map((it, i) => (
          <Box key={i} marginTop={BLOCK_GAP}>{renderItem(it, i, theme)}</Box>
        ))}
      </Box>
```

- [ ] **Step 4: 跑测试 + scrollview 回归**

Run: `npm test -- tui.gridization tui.scrollview`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tui/ScrollView.tsx test/tui.gridization.test.tsx
git commit -m "feat(tui): 全屏 ScrollView 块间空行（块 marginTop）"
```

---

### Task 4: chrome — 输入区分隔 + Suggestions 对齐

**Files:**
- Modify: `src/tui/App.tsx`（包裹中部输入区 ternary，marginTop）
- Modify: `src/tui/FullscreenApp.tsx`（bottomRef Box marginTop）
- Modify: `src/tui/components/Suggestions.tsx`（paddingX）
- Test: 真机冒烟（纯布局，免单测；下方仅做构建校验）

**Interfaces:**
- Consumes: `BLOCK_GAP`、`GUTTER`（Task 1）。
- Produces: transcript ↔ 输入区空一行；Suggestions 左右各 1 列 padding。

- [ ] **Step 1: App.tsx 包裹中部输入区**

在 `<Transcript .../>`（:226）之后、`{state.pendingQuestion`（:227）之前插入开标签，并在该 ternary 闭合 `}`（:303，`<StatusFooter` 之前）后插入闭标签。即把 227–303 整段 ternary 包进：
```tsx
      <Box flexDirection="column" marginTop={BLOCK_GAP}>
        {state.pendingQuestion
          ? <QuestionDialog … />
          : … /* 原 ternary 完整保留 */ }
      </Box>
```
import 行加 `BLOCK_GAP`（App.tsx 顶部从 `'./theme.js'` 或对应路径引入；若已 import useTheme 同源则并入）。

- [ ] **Step 2: FullscreenApp.tsx bottomRef 加 marginTop**

`src/tui/FullscreenApp.tsx:272`：
```tsx
      <Box ref={bottomRef} flexDirection="column" flexShrink={0} marginTop={BLOCK_GAP}>
```
import 行加 `BLOCK_GAP`。

- [ ] **Step 3: Suggestions paddingX** — `src/tui/components/Suggestions.tsx:40`

import 行加 `GUTTER`：
```ts
import { useTheme, GUTTER } from '../theme.js'
```
外层 Box 加 `paddingX`：
```tsx
    <Box flexDirection="column" borderStyle="round" borderColor={T.accent} paddingX={GUTTER}>
```

- [ ] **Step 4: 构建校验**

Run: `npm run build`
Expected: tsc 无错。

- [ ] **Step 5: 提交**

```bash
git add src/tui/App.tsx src/tui/FullscreenApp.tsx src/tui/components/Suggestions.tsx
git commit -m "feat(tui): transcript↔输入区空行 + Suggestions 左右 padding（双 App）"
```

---

### Task 5: StatusFooter 逻辑分组

**Files:**
- Modify: `src/tui/components/StatusFooter.tsx`
- Test: `test/tui.statusfooter.grouping.test.tsx`

**Interfaces:**
- Consumes: `BLOCK_GAP`（Task 1）。
- Produces: 页脚 3 簇（簇间空 1 行）+ 页脚整体上方空 1 行；可选行缺失时不产生空簇。

簇定义：
- **簇 1**：Row 1（模型/模式/git）
- **簇 2**：Row 2（context/缓存/budget/花费）+ Row 2.5（statusLineOutput，若有）
- **簇 3**：Row 3（记忆，若有）+ Row 4（工具计数，若有）+ Row 5（命令提示，恒有）

- [ ] **Step 1: 写失败测试** `test/tui.statusfooter.grouping.test.tsx`

```tsx
import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { StatusFooter } from '../src/tui/components/StatusFooter.js'

const base = {
  model: 'deepseek', mode: 'default', cwdBase: 'proj', branch: 'main',
  memoryCount: 2, contextUsed: 1000, contextWindow: 100000, cost: 0.12,
  hitRate: 0, cacheSavings: 0, thinking: false, effortLevel: 'medium' as const,
  toolCounts: [{ name: 'Bash', n: 2 }], statusLineOutput: null,
}

function blanksBetween(frame: string, a: string, b: string): number {
  const lines = frame.split('\n')
  const ia = lines.findIndex(l => l.includes(a))
  const ib = lines.findIndex(l => l.includes(b))
  return lines.slice(ia + 1, ib).filter(l => l.trim() === '').length
}

describe('StatusFooter 分组', () => {
  it('簇 1↔簇 2、簇 2↔簇 3 之间各有空行', () => {
    const { lastFrame } = render(<StatusFooter {...base} />)
    const f = lastFrame()!
    expect(blanksBetween(f, 'deepseek', 'Context')).toBeGreaterThanOrEqual(1) // 簇1↔簇2
    expect(blanksBetween(f, 'Context', 'DEEPCODE.md')).toBeGreaterThanOrEqual(1) // 簇2↔簇3
  })

  it('无记忆/无工具时簇 3 不留空簇（簇2↔命令提示仍恰一空行）', () => {
    const { lastFrame } = render(<StatusFooter {...base} memoryCount={0} toolCounts={[]} />)
    const f = lastFrame()!
    expect(blanksBetween(f, 'Context', '看命令')).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tui.statusfooter.grouping`
Expected: FAIL（当前各行紧贴，无簇间空行）

- [ ] **Step 3: 改 `src/tui/components/StatusFooter.tsx`**

import 行加 `BLOCK_GAP`：
```ts
import { useTheme, DEFAULT_THEME, BLOCK_GAP } from '../theme.js'
```
把外层 `<Box flexDirection="column">`（:51）改为带上方留白，并将三簇各包一个 Box、簇间用 marginTop。结构改为：
```tsx
  return (
    <Box flexDirection="column" marginTop={BLOCK_GAP}>
      {/* 簇 1 */}
      <Box flexDirection="column">
        <Text>{/* …原 Row 1 整段… */}</Text>
      </Box>

      {/* 簇 2 */}
      <Box flexDirection="column" marginTop={BLOCK_GAP}>
        <Text>{/* …原 Row 2 整段… */}</Text>
        {props.statusLineOutput && <Text dimColor>{props.statusLineOutput}</Text>}
      </Box>

      {/* 簇 3 */}
      <Box flexDirection="column" marginTop={BLOCK_GAP}>
        {props.memoryCount > 0 && <Text dimColor>{`${props.memoryCount} DEEPCODE.md`}</Text>}
        {props.toolCounts.length > 0 && (
          <Text>{/* …原 Row 4 工具计数整段… */}</Text>
        )}
        <Text dimColor>/ 看命令 · @ 引用文件 · ! 跑 shell</Text>
      </Box>
    </Box>
  )
```
（各 Row 的内部 `<Text>…</Text>` 内容**原样搬入**对应簇 Box，不改文案/着色。簇 3 永远含命令提示行，故不会空簇；簇 1/2 恒有内容。）

- [ ] **Step 4: 跑测试 + 既有 footer 回归**

Run: `npm test -- tui.statusfooter`
Expected: PASS（含既有 StatusFooter 测试，contextBar/contextBarColor 等不受影响）

- [ ] **Step 5: 提交**

```bash
git add src/tui/components/StatusFooter.tsx test/tui.statusfooter.grouping.test.tsx
git commit -m "feat(tui): 页脚 3 簇分组 + 上方留白（逻辑分组非每行空行）"
```

---

### Task 6: 左右 gutter（paddingX）— 高风险，最后

**Files:**
- Modify: `src/tui/App.tsx:224`（主列 paddingX，低风险）
- Modify: `src/tui/FullscreenApp.tsx:264`（容器 paddingX）+ 光标列调整（:250/:253/:256 + :200 caretRow 宽度）
- Test: 真机 IME 冒烟为主（下方构建校验）

**Interfaces:**
- Consumes: `GUTTER`（Task 1）。
- Produces: 两条路径内容左右各留 1 列；FullscreenApp 光标停泊列对齐 gutter。

**⚠️ 风险**：FullscreenApp 加 `paddingX={GUTTER}` 后，输入框右移 GUTTER 列、内宽减 `2*GUTTER`。IME 光标停泊的绝对列 `col`（:256）与换行宽度（parkCol/parkRowOffset 的 `columns`）都要同步修，否则光标错位。这是 deepcode 已知脆弱点，必须 IME 专项冒烟。

- [ ] **Step 1: App.tsx 主列 paddingX**（低风险，inline 用 ink 原生光标）

`src/tui/App.tsx:224`：
```tsx
    <Box flexDirection="column" paddingX={GUTTER}>
```
import 加 `GUTTER`。

- [ ] **Step 2: FullscreenApp 容器 paddingX + 光标列调整**

`src/tui/FullscreenApp.tsx:264`：
```tsx
    <Box flexDirection="column" height={rows} paddingX={GUTTER}>
```
import 加 `GUTTER`。

换行宽度按内宽（减 `2*GUTTER`）。`:200` caretRow 计算里的 `stdout?.columns ?? 80` 改为 `(stdout?.columns ?? 80) - 2 * GUTTER`；`:250` 的 `parkCol(draft, stdout.columns ?? 80, dispWidth)` 改为 `parkCol(draft, (stdout.columns ?? 80) - 2 * GUTTER, dispWidth)`。

绝对列加 GUTTER 偏移。`:253` `parkRef.current.col = col` → `parkRef.current.col = col + GUTTER`；`:256` `\x1b[${caretRow};${col}H` → `\x1b[${caretRow};${col + GUTTER}H`。（注：parkRef.current.col 已含偏移，:237 用的是 parkRef.current.col，无需再改。）

- [ ] **Step 3: 构建校验**

Run: `npm run build && npm test`
Expected: tsc 无错；全测试 PASS。

- [ ] **Step 4: 提交**

```bash
git add src/tui/App.tsx src/tui/FullscreenApp.tsx
git commit -m "feat(tui): 左右 gutter（paddingX=1）+ FullscreenApp 光标列对齐"
```

- [ ] **Fallback（若 IME 冒烟光标错位严重且短时难修）**：撤销 FullscreenApp 容器 paddingX（恢复 :264/:200/:250/:253/:256），改为只给 `ScrollView` 内层内容 Box 加 `paddingX={GUTTER}`（transcript 有 gutter、输入框暂留左边缘），并在 memory 记 follow-up。inline App 的 gutter 保留（无此问题）。

---

## 真机冒烟（合并前，双组件）

> `node /Users/silas/loop/deepcode/dist/index.js`，欢迎页确认 v0.8.0。默认跑全屏 FullscreenApp；另用 `--inline` 跑 App 各验一遍。

1. **块间节奏**：发几条消息含工具调用 → 确认 user/assistant/工具块之间各空一行，`⎿` 紧贴 `⏺`（块内不空）。
2. **banner↔首块**：开机 banner 与第一条内容之间空一行（不双空行）。
3. **transcript↔输入区**：最后一块与输入框之间空一行。
4. **页脚分组**：页脚 3 簇、簇间空行、上方空行；切到无工具/无记忆会话确认簇 3 不留空簇。
5. **gutter**：内容左右各缩进 1 列，banner/transcript/输入框/页脚左边缘统一。
6. **🔴 IME 光标（FullscreenApp 重点）**：输入中英文混排长文本触发换行 → 光标始终停在字符正确位置（gutter 后不偏 1 列）；中断/补充消息后光标不漂。
7. 截图回传：块节奏、页脚分组、gutter 对齐、IME 长输入光标。

---

## Self-Review

- **Spec 覆盖**：节奏 CC 同款（T2/T3 块间距 + T6 gutter）✅；全面范围含 chrome（T4 输入区+Suggestions、T5 页脚）✅；页脚逻辑分组 3 簇（T5）✅；集中式 + theme 常量（T1）✅；双路径都改（T2 内联 + T3 全屏，T4/T6 双 App）✅；测试更新（T2/T3 块间空行 + T5 分组 + 既有回归）✅；风险（ink Static×marginTop / gutter 光标 / 双组件）落到 T6 风险段 + 冒烟清单✅。
- **对 spec 的两处刻意偏离（已在本计划显式说明）**：① **banner 不加 marginBottom**——spec §5 原列 Banner marginBottom，但与「块 marginTop」叠加会致 banner↔首块双空行；改为间距全由块 marginTop 承担，banner 不动。② **缩进统一（INDENT）推迟**——spec §4 列出，但重路由 ToolLine/markdown 既有缩进风险动 `⎿  ` 断言、视觉零收益，按 YAGNI 移出本批（仅定义 GUTTER/BLOCK_GAP，不定义 INDENT）。
- **占位符**：无 TODO/「类似上文」；每步含真实代码或精确行号 + 改法（T4 包裹 ternary、T6 光标列均给出确切位置与替换）。
- **类型一致性**：`GUTTER`/`BLOCK_GAP`（T1 导出）全程引用一致；各组件 import 同源 `theme.js`。
- **风险兜底**：T6 给出主路径 + fallback（撤容器 paddingX、仅 ScrollView 内容加），最后任务可独立回退不损前 5 个块间距/分组成果。
