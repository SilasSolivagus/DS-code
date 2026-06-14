# M8 全屏可滚 TUI — P1（全屏骨架 + 键盘滚动）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 deepcode 默认进入 alt-screen 全屏、自带键盘滚动（PageUp/PageDown/Ctrl+G）+ auto-follow，不再依赖终端原生回滚（修 Ghostty 滚不动）；`--inline`/`DEEPCODE_INLINE=1`/settings `inline:true` 任一退回现有内联模式。

**Architecture:** 入口按逃生开关路由——内联走现有 `App`，否则走新 `FullscreenApp`（仅 TTY）。`FullscreenApp` 复用现有 `useChat`/输入/页脚/弹窗，只把转录渲染换成新 `ScrollView`（`Box overflowY:'hidden'` 真裁剪 + `measureElement` 量高 + `marginTop=-offset` 滚动）。滚动数学抽到纯函数 `scroll.ts`（可单测）。alt-screen 进/出 + 全路径还原在 `altscreen.ts`。`renderItem` 从 `Transcript.tsx` 抽出共用。useChat 会话核心**零改动**。

**Tech Stack:** TypeScript ESM、ink 5（`overflowY:'hidden'` 裁剪 @ `render-node-to-output.js:60`、导出 `measureElement`、`key.pageUp/pageDown`）、React 18、vitest、ink-testing-library。

**设计依据：** `docs/specs/2026-06-14-deepcode-m8-fullscreen-scroll-p1-design.md`（用户已批）。方案 A1=基于 stock ink 5，不 fork。

**已验证前提（实现前已确认）：** ink 5 导出 `measureElement`（function）；`overflowY:'hidden'` 在 `render-node-to-output.js:60-61` 真裁剪；`Key` 含 `pageUp`/`pageDown`（`\x1b[5~`/`\x1b[6~`）；ink 导出 `DOMElement` 类型；`pbcopy` 在（P3 用，P1 不涉及）。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/tui/scroll.ts` | 建 | 纯滚动数学：clamp/page/applyFollow/nextStuck/scrollInfo（全单测） |
| `src/tui/altscreen.ts` | 建 | 进/出 alt-screen 转义 + 全路径还原（exit/SIGINT/SIGTERM/uncaught + 幂等 leave） |
| `src/tui/renderItem.tsx` | 建（抽取） | 从 Transcript 抽出 `renderItem`/`isDone`/`withBullet`，供内联 Transcript 与全屏 ScrollView 共用 |
| `src/tui/components/Transcript.tsx` | 改 | 改为 import 共享 `renderItem`/`isDone`（行为零变） |
| `src/tui/ScrollView.tsx` | 建 | 固定高度裁剪视口 + measureElement 量高（量 viewportH/totalH 上报） |
| `src/tui/FullscreenApp.tsx` | 建 | 全屏变体：布局 + 滚动状态 + 键位 + alt-screen 生命周期 + 绝对定位 IME 停泊 + 复用输入/页脚/弹窗 |
| `src/tui/index.tsx` | 改 | 逃生开关路由：内联 App vs FullscreenApp |
| `src/config.ts` | 改 | Settings 加 `inline?: boolean` + loadSettings 读取 |
| `src/index.ts` | 改 | 解析 `--inline`/`DEEPCODE_INLINE`/settings.inline，传入 startTui |

**不碰：** `src/tui/useChat.ts`、`src/tui/App.tsx`（内联模式完全保留原样）、`src/tui/caret.ts`（parkCol 复用）、各工具/loop/session。

---

## Task 1: scroll.ts 纯滚动数学

**Files:**
- Create: `src/tui/scroll.ts`, `test/tui.scroll.test.ts`

- [ ] **Step 1: 写失败测试** `test/tui.scroll.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { clamp, page, applyFollow, nextStuck, scrollInfo } from '../src/tui/scroll.js'

describe('scroll 数学', () => {
  it('clamp 钳到 [0, maxScroll]', () => {
    expect(clamp(-5, 10)).toBe(0)
    expect(clamp(5, 10)).toBe(5)
    expect(clamp(20, 10)).toBe(10)
    expect(clamp(3, 0)).toBe(0)
  })

  it('page 翻 ±(viewportH-1) 并钳位', () => {
    expect(page(10, 'up', 5, 100)).toBe(6)      // 10-(5-1)=6
    expect(page(10, 'down', 5, 100)).toBe(14)   // 10+4
    expect(page(2, 'up', 5, 100)).toBe(0)       // 钳到 0
    expect(page(98, 'down', 5, 100)).toBe(100)  // 钳到 max
    expect(page(0, 'up', 1, 100)).toBe(0)       // viewportH=1 → delta=1
  })

  it('applyFollow：stuck 返回 maxScroll，否则钳原值', () => {
    expect(applyFollow(3, 50, true)).toBe(50)
    expect(applyFollow(3, 50, false)).toBe(3)
    expect(applyFollow(99, 50, false)).toBe(50)  // 超界钳回
  })

  it('nextStuck：offset≥maxScroll 即重新跟随', () => {
    expect(nextStuck(50, 50)).toBe(true)
    expect(nextStuck(49, 50)).toBe(false)
    expect(nextStuck(0, 0)).toBe(true)
  })

  it('scrollInfo：上/下有更多 + 可见行区间', () => {
    // totalH=100, viewportH=20, offset=0 → 顶部
    let i = scrollInfo(0, 20, 100)
    expect(i.moreAbove).toBe(false)
    expect(i.moreBelow).toBe(true)
    expect(i.top).toBe(1); expect(i.bottom).toBe(20); expect(i.total).toBe(100)
    // 滚到底 offset=80
    i = scrollInfo(80, 20, 100)
    expect(i.moreAbove).toBe(true)
    expect(i.moreBelow).toBe(false)
    expect(i.top).toBe(81); expect(i.bottom).toBe(100)
    // 内容不足一屏
    i = scrollInfo(0, 20, 5)
    expect(i.moreAbove).toBe(false); expect(i.moreBelow).toBe(false)
    expect(i.top).toBe(1); expect(i.bottom).toBe(5)
    // 空转录
    i = scrollInfo(0, 20, 0)
    expect(i.top).toBe(0); expect(i.bottom).toBe(0); expect(i.total).toBe(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/tui.scroll.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写** `src/tui/scroll.ts`:

```ts
// src/tui/scroll.ts
// 纯滚动数学（无 React/ink 依赖，全单测）：钳位、翻页、auto-follow、位置提示。
// scrollOffset：0=顶，maxScroll=底（maxScroll = max(0, totalH - viewportH)）。

export function clamp(offset: number, maxScroll: number): number {
  return Math.max(0, Math.min(offset, maxScroll))
}

/** 翻页：上/下移 (viewportH-1) 行（保留一行上下文），再钳位。 */
export function page(offset: number, dir: 'up' | 'down', viewportH: number, maxScroll: number): number {
  const delta = Math.max(1, viewportH - 1)
  return clamp(offset + (dir === 'up' ? -delta : delta), maxScroll)
}

/** auto-follow：贴底态返回 maxScroll（跟随新输出），否则把原 offset 钳回界内。 */
export function applyFollow(offset: number, maxScroll: number, stuck: boolean): number {
  return stuck ? maxScroll : clamp(offset, maxScroll)
}

/** 是否应重新贴底跟随：滚到底即重新 stuck。 */
export function nextStuck(offset: number, maxScroll: number): boolean {
  return offset >= maxScroll
}

export interface ScrollInfo {
  moreAbove: boolean
  moreBelow: boolean
  top: number       // 可见首行（1-based；空转录为 0）
  bottom: number    // 可见末行
  total: number     // 总行数
}

/** 视口位置提示：是否上下有更多 + 可见行区间。 */
export function scrollInfo(offset: number, viewportH: number, totalH: number): ScrollInfo {
  const maxScroll = Math.max(0, totalH - viewportH)
  const o = clamp(offset, maxScroll)
  return {
    moreAbove: o > 0,
    moreBelow: o < maxScroll,
    top: totalH === 0 ? 0 : o + 1,
    bottom: Math.min(o + viewportH, totalH),
    total: totalH,
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/tui.scroll.test.ts`
Expected: PASS（5 用例）

- [ ] **Step 5: typecheck + 提交**

Run: `npm run typecheck`
```bash
git add src/tui/scroll.ts test/tui.scroll.test.ts
git commit -m "feat(M8 P1): scroll.ts 纯滚动数学（clamp/page/applyFollow/nextStuck/scrollInfo）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: altscreen.ts 进/出 alt-screen + 全路径还原

**Files:**
- Create: `src/tui/altscreen.ts`, `test/tui.altscreen.test.ts`

- [ ] **Step 1: 写失败测试** `test/tui.altscreen.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { enterAltScreen, installCleanup } from '../src/tui/altscreen.js'

describe('altscreen', () => {
  it('enterAltScreen 写进备用屏 + 清屏归位转义；leave 还原主屏 + 显光标', () => {
    const writes: string[] = []
    const leave = enterAltScreen(s => writes.push(s))
    expect(writes.join('')).toContain('\x1b[?1049h')  // 进备用屏
    expect(writes.join('')).toContain('\x1b[2J')       // 清屏
    leave()
    expect(writes.join('')).toContain('\x1b[?1049l')   // 还原主屏
    expect(writes.join('')).toContain('\x1b[?25h')     // 显光标
  })

  it('leave 幂等：二次调用不再写', () => {
    const writes: string[] = []
    const leave = enterAltScreen(s => writes.push(s))
    const n1 = writes.length
    leave()
    const n2 = writes.length
    leave()  // 第二次
    expect(writes.length).toBe(n2)  // 无新增
    expect(n2).toBeGreaterThan(n1)
  })

  it('installCleanup 注册 4 个进程事件、disposer 全摘除', () => {
    const before = {
      exit: process.listenerCount('exit'),
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
      uncaught: process.listenerCount('uncaughtException'),
    }
    const dispose = installCleanup(() => {})
    expect(process.listenerCount('exit')).toBe(before.exit + 1)
    expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1)
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1)
    expect(process.listenerCount('uncaughtException')).toBe(before.uncaught + 1)
    dispose()
    expect(process.listenerCount('exit')).toBe(before.exit)
    expect(process.listenerCount('SIGINT')).toBe(before.sigint)
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm)
    expect(process.listenerCount('uncaughtException')).toBe(before.uncaught)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/tui.altscreen.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写** `src/tui/altscreen.ts`:

```ts
// src/tui/altscreen.ts
// alt-screen 全屏接管：进备用屏存主屏 + 清屏；leave 还原主屏 + 显光标（幂等）。
// 全路径还原：exit/SIGINT/SIGTERM/uncaughtException 任一都还原终端——这是最高优先正确性。
const ENTER = '\x1b[?1049h\x1b[2J\x1b[H'  // 进备用屏(存主屏) + 清屏 + 归位
const LEAVE = '\x1b[?1049l\x1b[?25h'      // 还原主屏 + 显光标

/** 进 alt-screen，返回幂等 leave()。write 可注入（测试用）。 */
export function enterAltScreen(write: (s: string) => void = s => { process.stdout.write(s) }): () => void {
  write(ENTER)
  let left = false
  return () => {
    if (left) return
    left = true
    write(LEAVE)
  }
}

/** 注册全路径还原；返回 disposer 摘除监听（正常卸载时调，避免泄漏）。 */
export function installCleanup(leave: () => void): () => void {
  const onExit = () => { leave() }
  const onSignal = (sig: NodeJS.Signals) => { leave(); process.exit(sig === 'SIGINT' ? 130 : 143) }
  const onUncaught = (err: unknown) => { leave(); throw err }  // 还原后让进程照常崩（无其他 handler 时即崩）
  process.once('exit', onExit)
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  process.once('uncaughtException', onUncaught)
  return () => {
    process.off('exit', onExit)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    process.off('uncaughtException', onUncaught)
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/tui.altscreen.test.ts`
Expected: PASS（3 用例）

- [ ] **Step 5: typecheck + 提交**

Run: `npm run typecheck`
```bash
git add src/tui/altscreen.ts test/tui.altscreen.test.ts
git commit -m "feat(M8 P1): altscreen.ts 进/出全屏 + 全路径还原（信号/exit/异常 + 幂等 leave）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 抽出 renderItem（Transcript 共享，内联行为零变）

把 `renderItem`/`isDone`/`withBullet` 从 `Transcript.tsx` 抽到 `renderItem.tsx`，Transcript 改为 import。**纯重构，内联行为必须零变**——靠现有 `test/tui.transcript.test.tsx` 回归守住。

**Files:**
- Create: `src/tui/renderItem.tsx`
- Modify: `src/tui/components/Transcript.tsx`
- Test: `test/tui.renderItem.test.tsx`（新增最小直测） + 既有 `test/tui.transcript.test.tsx`（回归）

- [ ] **Step 1: 建** `src/tui/renderItem.tsx` —— 把 Transcript.tsx 现有的 `isDone`/`withBullet`/`renderItem` 三个函数**原样**搬过来（含注释），并 `export` `renderItem` 与 `isDone`：

```tsx
// src/tui/renderItem.tsx
// 单条转录项渲染（从 Transcript 抽出，供内联 Transcript 与全屏 ScrollView 共用）。
// 行为与抽出前完全一致——任何改动都会破坏现有 transcript 回归测试。
import React from 'react'
import { Box, Text } from 'ink'
import { T } from './theme.js'
import { renderMarkdown } from './markdown.js'
import { ToolLine } from './components/ToolLine.js'
import type { TranscriptItem } from './useChat.js'

/** 判断是否为"已完成"项（进入 Static 区）。*/
export function isDone(item: TranscriptItem): boolean {
  if (item.kind === 'assistant' || item.kind === 'reasoning') return item.done
  if (item.kind === 'tool') return !item.running
  return true
}

/** CC 风格 ⏺ 项目符号：首行带 accent 圆点，续行回到 col 0 不缩进。 */
function withBullet(content: string): React.ReactNode {
  const lines = content.split('\n')
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i}>
          {i === 0 ? <Text color={T.accent}>{'⏺ '}</Text> : ''}
          {line}
        </Text>
      ))}
    </Box>
  )
}

export function renderItem(item: TranscriptItem, index: number): React.ReactNode {
  switch (item.kind) {
    case 'user':
      return (
        <Box key={index}>
          <Text color={T.accent}>{'> '}</Text>
          <Text dimColor>{item.text}</Text>
        </Box>
      )

    case 'assistant':
      if (item.done) {
        return <Box key={index}>{withBullet(renderMarkdown(item.text))}</Box>
      }
      return <Box key={index}>{withBullet(item.text)}</Box>

    case 'reasoning':
      if (item.done) {
        const lineCount = item.text.split('\n').length
        return (
          <Box key={index}>
            <Text dimColor>✻ 已思考（{lineCount} 行）</Text>
          </Box>
        )
      }
      {
        const lines = item.text.split('\n')
        const tail = lines.slice(-3)
        return (
          <Box key={index} flexDirection="column">
            <Text dimColor italic>✻ 思考中…</Text>
            {tail.map((l, i) => (
              <Text key={i} dimColor italic>{l}</Text>
            ))}
          </Box>
        )
      }

    case 'tool':
      return (
        <Box key={index}>
          <ToolLine
            name={item.name}
            desc={item.desc}
            running={item.running}
            ok={item.ok}
            preview={item.preview}
            previewExtra={item.previewExtra}
            ms={item.ms}
          />
        </Box>
      )

    case 'usage':
      return (
        <Box key={index}>
          <Text dimColor>{item.out} tokens · ${item.cost.toFixed(4)}</Text>
        </Box>
      )

    case 'notice': {
      const color = item.level === 'error' ? T.err : item.level === 'warn' ? T.warn : undefined
      return (
        <Box key={index}>
          <Text dimColor={!color} color={color}>{item.text}</Text>
        </Box>
      )
    }

    case 'bang':
      return (
        <Box key={index} flexDirection="column">
          <Text dimColor>$ {item.cmd}</Text>
          {item.output.split('\n').map((l, i) => (
            <Text key={i} dimColor>{l}</Text>
          ))}
        </Box>
      )
  }
}
```

注意 import 路径：renderItem.tsx 在 `src/tui/`，故 `./theme.js`、`./markdown.js`、`./components/ToolLine.js`、`./useChat.js`（与 Transcript.tsx 的 `../` 前缀不同——Transcript 在 `components/` 下）。

- [ ] **Step 2: 改** `src/tui/components/Transcript.tsx` —— 删除本地 `isDone`/`withBullet`/`renderItem`，改 import 共享版。

把文件顶部 import 区（第 10-15 行）中对 `T`/`renderMarkdown`/`ToolLine` 的 import 删掉（若 Transcript 其余部分不再直接用它们），新增：
```ts
import { renderItem, isDone } from '../renderItem.js'
```
保留 `import React from 'react'`、`import { Box, Text, Static } from 'ink'`、`import type { TranscriptItem } from '../useChat.js'`。
删除文件中第 17-123 行的 `isDone`/`withBullet`/`renderItem` 三个函数定义。`Transcript` 组件本体（`doneItems`/`liveItems`/`Static` 渲染）保持不变——它已调用 `renderItem`/`isDone`。

改完后 Transcript.tsx 仅剩：import 区 + `type StaticEntry` + `export function Transcript`。

- [ ] **Step 3: 加最小直测** `test/tui.renderItem.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { Box } from 'ink'
import { renderItem, isDone } from '../src/tui/renderItem.js'
import type { TranscriptItem } from '../src/tui/useChat.js'

describe('renderItem 抽取', () => {
  it('isDone：tool running=false 为完成，assistant done 决定', () => {
    expect(isDone({ kind: 'tool', name: 'Read', running: false } as any)).toBe(true)
    expect(isDone({ kind: 'tool', name: 'Read', running: true } as any)).toBe(false)
    expect(isDone({ kind: 'assistant', text: 'x', done: true } as any)).toBe(true)
    expect(isDone({ kind: 'user', text: 'hi' } as any)).toBe(true)
  })

  it('renderItem：user 项渲染文本与 > 提示符', () => {
    const item: TranscriptItem = { kind: 'user', text: '你好世界' } as any
    const f = render(<Box>{renderItem(item, 0)}</Box>).lastFrame()!
    expect(f).toContain('你好世界')
    expect(f).toContain('>')
  })
})
```

- [ ] **Step 4: 全量回归（重点 transcript）+ typecheck**

Run: `npx vitest run test/tui.transcript.test.tsx test/tui.renderItem.test.tsx && npm run typecheck`
Expected: transcript 既有用例全 PASS（行为零变证明），renderItem 直测 PASS，typecheck 干净。
再跑 `npm test` 确认全量绿。

- [ ] **Step 5: 提交**

```bash
git add src/tui/renderItem.tsx src/tui/components/Transcript.tsx test/tui.renderItem.test.tsx
git commit -m "refactor(M8 P1): 抽出 renderItem/isDone 供 Transcript 与 ScrollView 共用（内联行为零变）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: ScrollView 裁剪视口 + measureElement 量高

`Box overflowY:'hidden'` 固定高度外层 + 内层 `marginTop=-offset` 渲染全部 item；`measureElement` 量 viewportH（外层）与 totalH（内层）上报给父。

**Files:**
- Create: `src/tui/ScrollView.tsx`, `test/tui.scrollview.test.tsx`

- [ ] **Step 1: 写失败测试** `test/tui.scrollview.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { ScrollView } from '../src/tui/ScrollView.js'
import type { TranscriptItem } from '../src/tui/useChat.js'

const items: TranscriptItem[] = Array.from({ length: 10 }, (_, i) =>
  ({ kind: 'user', text: `行${i}` } as any))

describe('ScrollView', () => {
  it('挂载不崩；上报 viewportH/totalH（measure 回调被调用）', async () => {
    const onMeasure = vi.fn()
    render(<ScrollView items={items} scrollOffset={0} onMeasure={onMeasure} />)
    await new Promise(r => setTimeout(r, 30))
    expect(onMeasure).toHaveBeenCalled()
    const [vh, th] = onMeasure.mock.calls[onMeasure.mock.calls.length - 1]
    expect(typeof vh).toBe('number')
    expect(typeof th).toBe('number')
  })

  it('offset=0 时顶部项可见', () => {
    const f = render(<ScrollView items={items} scrollOffset={0} onMeasure={() => {}} />).lastFrame()!
    expect(f).toContain('行0')
  })
})
```
（注：ink-testing-library 下 `measureElement` 的高度值可能与真终端不同；本测试只钉「回调被调、不崩、顶部可见」——精确切片由 P1 pty 冒烟人工核对，纯数学已在 scroll.ts 全覆盖。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/tui.scrollview.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写** `src/tui/ScrollView.tsx`:

```tsx
// src/tui/ScrollView.tsx
// 裁剪滚动视口：外层固定高度 + overflowY:'hidden' 真裁剪（ink render-node-to-output.js:60）；
// 内层 flexShrink=0 渲染全部 item（复用 renderItem），marginTop=-offset 实现向上滚。
// 每帧后用 measureElement 量外层高(viewportH)与内层高(totalH)上报父，父据此算 maxScroll/auto-follow。
import React, { useRef, useLayoutEffect } from 'react'
import { Box, measureElement, type DOMElement } from 'ink'
import { renderItem } from './renderItem.js'
import type { TranscriptItem } from './useChat.js'

export function ScrollView(props: {
  items: TranscriptItem[]
  scrollOffset: number
  onMeasure: (viewportH: number, totalH: number) => void
  banner?: React.ReactNode
}) {
  const outerRef = useRef<DOMElement | null>(null)
  const innerRef = useRef<DOMElement | null>(null)

  useLayoutEffect(() => {
    const vh = outerRef.current ? measureElement(outerRef.current).height : 0
    const th = innerRef.current ? measureElement(innerRef.current).height : 0
    props.onMeasure(vh, th)
  })

  return (
    <Box ref={outerRef} flexGrow={1} flexShrink={1} minHeight={0} overflowY="hidden" flexDirection="column">
      <Box ref={innerRef} flexDirection="column" flexShrink={0} marginTop={-props.scrollOffset}>
        {props.banner}
        {props.items.map((it, i) => renderItem(it, i))}
      </Box>
    </Box>
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/tui.scrollview.test.tsx`
Expected: PASS（2 用例）。若 `measureElement` 在测试环境对未布局节点抛错，给 useLayoutEffect 包 try/catch 并在 catch 里 `props.onMeasure(0, 0)`。

- [ ] **Step 5: typecheck + 提交**

Run: `npm run typecheck`
```bash
git add src/tui/ScrollView.tsx test/tui.scrollview.test.tsx
git commit -m "feat(M8 P1): ScrollView 裁剪视口 + measureElement 量高上报

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: FullscreenApp 全屏变体（布局 + 滚动 + alt-screen + IME 停泊）

复用 App 的全部接线（useChat/输入/页脚/弹窗），只把转录换成 ScrollView，并加滚动状态 + 键位 + alt-screen 生命周期 + **绝对定位** IME 停泊。

**Files:**
- Create: `src/tui/FullscreenApp.tsx`, `test/tui.fullscreen.test.tsx`

> **实现说明（重点）：** FullscreenApp 是 App.tsx 的全屏孪生，**输入/补全/历史/Ctrl+C 双击/页脚数据/draft 清除**等接线与 App 完全相同（直接照搬 App.tsx 对应代码段）。差异仅四处：①转录区换 ScrollView + 滚动状态/键位 ②alt-screen 生命周期 ③绝对定位 IME 停泊（替代 App 的相对上移 hack）④根 `Box height={rows}` + 位置提示行。下方给出完整文件，照抄即可。

- [ ] **Step 1: 写** `src/tui/FullscreenApp.tsx`:

```tsx
// src/tui/FullscreenApp.tsx
// 全屏可滚变体（M8 P1）：alt-screen 全屏 + 键盘滚动（PageUp/PageDown/Ctrl+G）+ auto-follow。
// 复用 App 的全部接线，仅把转录渲染换成 ScrollView，并加滚动状态 + alt-screen 生命周期 +
// 绝对定位 IME 光标停泊。useChat 会话核心零改动。内联模式仍走 App。
import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { createChatCore, useChat } from './useChat.js'
import { findMemoryFiles } from '../prompt.js'
import { computeSuggestions } from './suggest.js'
import { parkCol } from './caret.js'
import { Banner } from './components/Banner.js'
import { ScrollView } from './ScrollView.js'
import { InputBox } from './components/InputBox.js'
import { Suggestions } from './components/Suggestions.js'
import { PermissionDialog } from './components/PermissionDialog.js'
import { QuestionDialog } from './components/QuestionDialog.js'
import { SelectList } from './components/SelectList.js'
import { Spinner } from './components/Spinner.js'
import { StatusFooter } from './components/StatusFooter.js'
import { enterAltScreen, installCleanup } from './altscreen.js'
import { page, applyFollow, nextStuck, scrollInfo } from './scroll.js'

const CURSOR_PARK_OFF = process.env.DEEPCODE_NO_CURSOR_PARK === '1'

// CJK/全角按 2 列宽（同 App.tsx）
function dispWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if ((c >= 0x1100 && c <= 0x115F) || (c >= 0x2E80 && c <= 0xA4CF) ||
        (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0xF900 && c <= 0xFAFF) ||
        (c >= 0xFE30 && c <= 0xFE4F) || (c >= 0xFF00 && c <= 0xFF60) ||
        (c >= 0xFFE0 && c <= 0xFFE6) || (c >= 0x20000 && c <= 0x3FFFD)) w += 2
    else w += 1
  }
  return w
}

export function FullscreenApp(props: {
  client: any
  yolo: boolean
  cwd: string
  continueSession?: boolean
  sessionDir?: string
}) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const core = useMemo(() => createChatCore({
    client: props.client,
    yolo: props.yolo,
    cwd: props.cwd,
    continueSession: props.continueSession,
    sessionDir: props.sessionDir,
    onState: () => {},
  }), [])  // eslint-disable-line react-hooks/exhaustive-deps
  const state = useChat(core)
  const [draft, setDraft] = useState('')
  const [resumeMode, setResumeMode] = useState(false)
  const [lastSigint, setLastSigint] = useState(0)
  const justPickedRef = useRef<string | null>(null)
  const [valueOverride, setValueOverride] = useState<{ text: string; nonce: number } | undefined>(undefined)

  // —— 滚动状态 ——
  const [scrollOffset, setScrollOffset] = useState(0)
  const scrollRef = useRef(0)
  const stuckRef = useRef(true)
  const [, setTick] = useState(0)               // stuck 变化驱动提示行重渲
  const viewportRef = useRef(10)
  const totalRef = useRef(0)
  const [info, setInfo] = useState(() => scrollInfo(0, 10, 0))
  const setOffset = (n: number) => { scrollRef.current = n; setScrollOffset(n) }
  const recomputeInfo = () => setInfo(scrollInfo(scrollRef.current, viewportRef.current, totalRef.current))

  const onMeasure = useCallback((vh: number, th: number) => {
    let changed = false
    if (vh !== viewportRef.current) { viewportRef.current = vh; changed = true }
    if (th !== totalRef.current) { totalRef.current = th; changed = true }
    if (changed) {
      const ms = Math.max(0, totalRef.current - viewportRef.current)
      const next = applyFollow(scrollRef.current, ms, stuckRef.current)
      if (next !== scrollRef.current) setOffset(next)
      recomputeInfo()
    }
  }, [])

  // pendingAsk/pendingQuestion/resumeMode 激活时清 draft（同 App）
  useEffect(() => {
    if (state.pendingAsk || state.pendingQuestion || resumeMode) {
      setDraft(''); setValueOverride(undefined); justPickedRef.current = null
    }
  }, [!!state.pendingAsk, !!state.pendingQuestion, resumeMode])  // eslint-disable-line react-hooks/exhaustive-deps

  // —— 滚动键位 + Ctrl+C 双击退出 ——
  useInput((input, key) => {
    // 滚动
    const ms = Math.max(0, totalRef.current - viewportRef.current)
    if (key.pageUp) { stuckRef.current = false; setOffset(page(scrollRef.current, 'up', viewportRef.current, ms)); recomputeInfo(); setTick(x => x + 1); return }
    if (key.pageDown) { const n = page(scrollRef.current, 'down', viewportRef.current, ms); stuckRef.current = nextStuck(n, ms); setOffset(n); recomputeInfo(); setTick(x => x + 1); return }
    if (key.ctrl && input === 'g') { stuckRef.current = true; setOffset(ms); recomputeInfo(); setTick(x => x + 1); return }
    // Ctrl+C 两次退出
    if (key.ctrl && input === 'c') {
      const now = Date.now()
      if (now - lastSigint < 2000) exit()
      else setLastSigint(now)
    }
  })

  // —— alt-screen 生命周期 ——
  useEffect(() => {
    if (!stdout?.isTTY) return
    const leave = enterAltScreen(s => { stdout.write(s) })
    const dispose = installCleanup(leave)
    return () => { dispose(); leave() }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const handleDraftChange = (v: string) => {
    setDraft(v)
    if (justPickedRef.current !== null && v !== justPickedRef.current) justPickedRef.current = null
  }

  const suggestions = useMemo(() => {
    if (justPickedRef.current !== null && draft === justPickedRef.current) return []
    return computeSuggestions(draft, { cwd: props.cwd, customCommands: core.customCommands })
  }, [draft])  // eslint-disable-line react-hooks/exhaustive-deps

  const handlePick = (v: string) => {
    let newDraft: string
    if (v.startsWith('@')) newDraft = draft.replace(/@[\w./-]*$/, v)
    else newDraft = v
    justPickedRef.current = newDraft
    setDraft(newDraft)
    setValueOverride(prev => ({ text: newDraft, nonce: (prev?.nonce ?? 0) + 1 }))
  }

  const submit = (text: string) => {
    if (text === '/exit') { exit(); return }
    if (text === '/resume') { setResumeMode(true); return }
    setDraft(''); setValueOverride(undefined); justPickedRef.current = null
    void core.send(text)
  }

  const historyItems = state.transcript
    .filter(i => i.kind === 'user')
    .map(i => (i as { kind: 'user'; text: string }).text)

  const suggestionsActive = suggestions.length > 0

  const cwdBase = useMemo(() => path.basename(props.cwd), [])  // eslint-disable-line react-hooks/exhaustive-deps
  const branch = useMemo(() => {
    try {
      return execSync('git branch --show-current', { cwd: props.cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null
    } catch { return null }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  const memoryCount = useMemo(() => findMemoryFiles(props.cwd).length, [])  // eslint-disable-line react-hooks/exhaustive-deps
  const modeLabel = (state.permMode === 'acceptEdits' ? 'accept' : state.permMode === 'yolo' ? 'yolo' : 'default')
    + (state.thinking ? '·think' : '')
  const toolCounts = useMemo(() => {
    const order: string[] = []
    const counts = new Map<string, number>()
    for (const it of state.transcript) {
      if (it.kind === 'tool') {
        if (!counts.has(it.name)) order.push(it.name)
        counts.set(it.name, (counts.get(it.name) ?? 0) + 1)
      }
    }
    return order.map(name => ({ name, n: counts.get(name)! }))
  }, [state.transcript])

  // —— 绝对定位 IME 光标停泊 ——
  // 仍需「写帧前把光标移回底部」：ink log-update 用 eraseLines(上帧行数) 重绘，假设光标在上帧底部。
  // 与内联不同处：移回用绝对 CUP `\x1b[{rows};1H`（全屏高度恒=rows），停泊用绝对 `\x1b[{caretRow};{col}H`。
  const inputActive = !state.pendingAsk && !state.pendingQuestion && !resumeMode && !state.busy
  const parkRef = useRef<{ active: boolean }>({ active: false })

  useEffect(() => {
    if (!stdout?.isTTY || CURSOR_PARK_OFF) return
    const out = stdout as NodeJS.WriteStream & { __origWrite?: typeof stdout.write }
    const orig = out.write.bind(out)
    out.__origWrite = orig
    out.write = ((chunk: any, ...rest: any[]) => {
      if (parkRef.current.active) {
        parkRef.current.active = false
        const rows = stdout.rows ?? 24
        orig(`\x1b[${rows};1H`)  // 绝对移回底行，让 eraseLines 从正确处起
      }
      return (orig as any)(chunk, ...rest)
    }) as typeof out.write
    return () => { out.write = orig; delete out.__origWrite }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // caretRow = rows - linesBelowCaret（输入框底边线 + 页脚行；±1 由 pty 冒烟微调）。
  const linesBelowCaret = 4 + (memoryCount > 0 ? 1 : 0) + (toolCounts.length > 0 ? 1 : 0)
  useEffect(() => {
    if (!inputActive || !stdout?.isTTY || CURSOR_PARK_OFF) return
    const out = stdout as NodeJS.WriteStream & { __origWrite?: typeof stdout.write }
    const orig = out.__origWrite ?? out.write.bind(out)
    const rows = stdout.rows ?? 24
    const caretRow = Math.max(1, rows - linesBelowCaret)
    const col = parkCol(draft, stdout.columns ?? 80, dispWidth)
    const id = setTimeout(() => {
      try {
        ;(orig as any)(`\x1b[?25h\x1b[${caretRow};${col}H`)
        parkRef.current.active = true
      } catch { /* 忽略写入失败 */ }
    }, 0)
    return () => clearTimeout(id)
  })

  const rows = stdout?.rows ?? 24

  return (
    <Box flexDirection="column" height={rows}>
      <ScrollView
        items={state.transcript}
        scrollOffset={scrollOffset}
        onMeasure={onMeasure}
        banner={<Banner cwd={props.cwd} model={state.model} />}
      />
      {/* 滚动位置提示（固定 1 行，恒占位防布局抖动） */}
      <Text dimColor>
        {(info.moreAbove || info.moreBelow)
          ? `${info.moreAbove ? '▲ 上有更多' : '▲ 已到顶'} · ${info.moreBelow ? '▼ 下有更多' : '▼ 已到底'} · 行 ${info.top}–${info.bottom}/${info.total}${stuckRef.current ? ' · 跟随' : ''}`
          : ' '}
      </Text>
      {state.pendingQuestion
        ? <QuestionDialog questions={state.pendingQuestion.questions} onDone={a => core.resolveQuestion(a)} />
        : state.pendingAsk
        ? <PermissionDialog ask={state.pendingAsk} onDecide={d => core.resolveAsk(d)} />
        : resumeMode
          ? <SelectList
              items={core.resumeList().map(s => s.preview)}
              onPick={i => { core.resume(core.resumeList()[i].file); setResumeMode(false) }}
              onCancel={() => setResumeMode(false)}
            />
          : <>
              {state.busy && <Spinner turnStartAt={state.turnStartAt} turnOutTokens={state.turnOutTokens} />}
              {suggestionsActive && <Suggestions items={suggestions} onPick={handlePick} />}
              <InputBox
                onSubmit={submit}
                onInterrupt={() => core.interrupt()}
                onChange={handleDraftChange}
                suggestionsActive={suggestionsActive}
                history={historyItems}
                busy={state.busy}
                valueOverride={valueOverride}
              />
            </>
      }
      <StatusFooter
        model={state.model}
        mode={modeLabel}
        cwdBase={cwdBase}
        branch={branch}
        memoryCount={memoryCount}
        contextPct={state.contextPct()}
        cost={state.sessionCost()}
        toolCounts={toolCounts}
      />
    </Box>
  )
}
```

- [ ] **Step 2: 写测试** `test/tui.fullscreen.test.tsx`（轻量——非 TTY 下 alt-screen/停泊自动跳过，只验证装配与不崩）:

```tsx
import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { FullscreenApp } from '../src/tui/FullscreenApp.js'

const tmp = () => '/tmp/dc-fs-' + Math.random().toString(36).slice(2)

describe('FullscreenApp 装配', () => {
  it('挂载渲染输入框 + 页脚，不崩', async () => {
    const { lastFrame, unmount } = render(
      <FullscreenApp client={{} as any} yolo={false} cwd="/tmp" sessionDir={tmp()} />
    )
    await new Promise(r => setTimeout(r, 40))
    const f = lastFrame()!
    expect(f).toContain('❯')        // InputBox 提示符
    expect(f).toContain('Context')   // StatusFooter
    unmount()
  })

  it('PageUp/PageDown/Ctrl+G 不抛错', async () => {
    const { stdin, unmount } = render(
      <FullscreenApp client={{} as any} yolo={false} cwd="/tmp" sessionDir={tmp()} />
    )
    await new Promise(r => setTimeout(r, 20))
    stdin.write('\x1B[5~')  // PageUp
    stdin.write('\x1B[6~')  // PageDown
    stdin.write('\x07')     // Ctrl+G
    await new Promise(r => setTimeout(r, 20))
    unmount()
    expect(true).toBe(true)  // 无异常即过
  })
})
```

- [ ] **Step 3: 跑测试 + typecheck**

Run: `npx vitest run test/tui.fullscreen.test.tsx && npm run typecheck`
Expected: PASS（2 用例），typecheck 干净。若 `useStdout` 在测试下 `stdout` 为 undefined 导致访问报错，已用 `stdout?.` 守护；`isTTY` 在测试下 falsy → alt-screen/停泊 effect 自动跳过。

- [ ] **Step 4: 提交**

```bash
git add src/tui/FullscreenApp.tsx test/tui.fullscreen.test.tsx
git commit -m "feat(M8 P1): FullscreenApp 全屏变体（ScrollView + 键盘滚动 + alt-screen + 绝对定位 IME 停泊）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 逃生开关路由（index.tsx + config + CLI）

`--inline`/`DEEPCODE_INLINE=1`/settings `inline:true` 任一 → 内联 App；否则（且 TTY）→ FullscreenApp。

**Files:**
- Modify: `src/config.ts`, `src/tui/index.tsx`, `src/index.ts`
- Test: `test/config.test.ts`（若存在则加用例，否则跳过该断言）

- [ ] **Step 1: 改** `src/config.ts` —— Settings 加 `inline?` 字段 + loadSettings 读取。

`Settings` 接口（约 6-18 行）末尾加：
```ts
  /** 启动用内联模式（退回非全屏 TUI；env DEEPCODE_INLINE=1 / CLI --inline 优先） */
  inline?: boolean
```
`loadSettings` 返回对象（约 30-37 行）加：
```ts
    inline: raw?.inline,
```

- [ ] **Step 2: 改** `src/tui/index.tsx` —— 按 `inline` 路由。整文件改为：

```tsx
// src/tui/index.tsx
// TUI 入口：按逃生开关路由——内联 App vs 全屏 FullscreenApp（仅 TTY）。
// exitOnCtrlC: false 让根组件自管双击退出语义。
import React from 'react'
import { render } from 'ink'
import { App } from './App.js'
import { FullscreenApp } from './FullscreenApp.js'
import type OpenAI from 'openai'

export async function startTui(opts: {
  client: OpenAI
  yolo: boolean
  continueSession?: boolean
  inline?: boolean
}): Promise<void> {
  // 全屏：默认开；inline 逃生开关 或 非 TTY 时退回内联 App。
  const fullscreen = !opts.inline && !!process.stdout.isTTY
  const Root = fullscreen ? FullscreenApp : App
  const { waitUntilExit } = render(
    <Root
      client={opts.client as any}
      yolo={opts.yolo}
      cwd={process.cwd()}
      continueSession={opts.continueSession}
    />,
    { exitOnCtrlC: false },
  )
  await waitUntilExit()
}
```

- [ ] **Step 3: 改** `src/index.ts` —— 解析 inline 并传入。

在顶部 flag 解析区（约 7-9 行 `const yolo = ...` 附近）加：
```ts
const inlineFlag = argv.includes('--inline') || process.env.DEEPCODE_INLINE === '1'
```
把 `startTui` 调用（约 43 行）改为：
```ts
    await startTui({ client, yolo, continueSession, inline: inlineFlag || loadSettings().inline === true })
```
并在文件顶部 import 区加（与现有 `import { hasApiKey } from './config.js'` 合并）：
```ts
import { hasApiKey, loadSettings } from './config.js'
```

- [ ] **Step 4: typecheck + 全量回归 + build**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck 干净、全量绿、build 成功。

- [ ] **Step 5: 提交**

```bash
git add src/config.ts src/tui/index.tsx src/index.ts
git commit -m "feat(M8 P1): 逃生开关路由（--inline / DEEPCODE_INLINE / settings.inline → 内联 App，否则全屏）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 集成验收（全量回归 + pty 人工冒烟）

**Files:** 无改动（验证 + 文档）。

- [ ] **Step 1: 全量回归 + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: 全量绿（240 + 新增约 14 = ~254）、typecheck 干净、build 成功。内联 `App` 行为与改动前一致（Transcript 抽取后回归证明）。

- [ ] **Step 2: pty 人工冒烟（真终端，验收必跑）** —— 在 Ghostty + Terminal.app 各跑一遍：

1. 默认 `deepcode` 进**全屏**（alt-screen，进入即清屏、退出还原原终端内容）。
2. 生成一长会话（≥2 屏），`PageUp`/`PageDown` 能上下翻看历史；`Ctrl+G` 跳到底并恢复跟随。
3. **auto-follow**：贴底时新输出自动跟随；向上滚后冻结、不被新输出拽下；滚回底自动重新跟随。
4. 位置提示行显示「▲上有更多/▼下有更多 · 行 N–M/T · 跟随」。
5. `resize` 终端窗口：视口重算不崩、贴底仍贴底。
6. **退出还原**：正常 `/exit`、`Ctrl+C` 双击、外部 `kill -INT`/`kill -TERM` 后终端干净还原主屏 + 光标可见。
7. **中文 IME** 组字在输入框内（绝对定位停泊）；若行偏，调 `linesBelowCaret` ±1 重测（FullscreenApp.tsx 内常量）。
8. `deepcode --inline`（及 `DEEPCODE_INLINE=1`、settings `inline:true`）退回内联模式，行为同改动前。

记录每项结果。**重点盯已知风险**（见下）。

- [ ] **Step 3: 更新文档与记忆**

- 写验收报告 `docs/specs/m8-p1-acceptance.md`（仿 m7 风格：决策、测试数、冒烟清单结果、踩坑）。
- README roadmap 标注 M8 P1 完成、P2（滚轮）/P3（选中复制）待做。
- 更新 `deepcode-project.md` 与 MEMORY.md：M8 P1 已实现合入，下一步 P2。

---

## 已知风险（实现/冒烟期重点盯）

1. **alt-screen 多写一行/尾换行顶得备用屏滚乱**（CC 专门有 use-terminal-viewport）。缓解：根 `Box height={rows}` 令 ink 每帧恰好渲染 rows 行；位置提示行固定 1 行恒占位。冒烟 Step 2.1/2.6 验证无错位。若仍滚乱：检查整体渲染高度是否 > rows（缩减页脚/提示行），或给根 Box 加 `overflow="hidden"`。
2. **绝对定位 IME 停泊与 ink log-update 的协同**：本实现保留「写帧前移回底部」机制（用绝对 `\x1b[{rows};1H`），停泊用绝对 CUP。这是 P1 最大不确定点，**以冒烟 Step 2.7 为准**；若组字仍跑框外或页脚串行，先试 `DEEPCODE_NO_CURSOR_PARK=1` 隔离确认是停泊所致，再调 `linesBelowCaret` 或回退到 App 的相对上移写法。逃生开关 `--inline` 保证产品始终可用。
3. **measureElement 一帧延迟**致 auto-follow 偶发一帧未贴底——可接受；若闪动明显，可在 onMeasure 内对 stuck 态再同步 setOffset 一次。
4. **长会话渲染全部 item 再 clip 的性能**——P1 可接受，超长留 P-later 虚拟化。
5. **renderItem 抽取改了内联行为**——Task 3 回归（既有 transcript 测试）守住，勿在抽取时顺手改样式。

---

## 自查

- **Spec 覆盖**：默认全屏 alt-screen(T5/T6)、键盘 PageUp/PageDown/Ctrl+G(T5 useInput + T1 page)、auto-follow stuckToBottom(T1 applyFollow/nextStuck + T5 onMeasure/键位)、位置提示(T1 scrollInfo + T5 提示行)、逃生开关 --inline/env/settings(T6)、alt-screen 全路径还原(T2 + T5 生命周期)、全屏绝对定位 IME 停泊(T5)、ScrollView overflowY 裁剪 + marginTop + measureElement(T4)、renderItem 抽取共用(T3)、index 路由(T6)、终端安全(T2/T5)、极小终端 viewportH≥1(T1 clamp + height 守护)、resize(ink 自带 useStdout rows 变化触发重渲 + onMeasure 重算)。全覆盖。
- **类型一致**：`clamp/page/applyFollow/nextStuck/scrollInfo/ScrollInfo`（T1 定义，T5 用）；`enterAltScreen/installCleanup`（T2 定义，T5 用）；`renderItem/isDone`（T3 定义，T3 Transcript + T4 ScrollView 用）；`ScrollView` props `{items,scrollOffset,onMeasure,banner}`（T4 定义，T5 用）；`FullscreenApp` props 同 App（T5 定义，T6 用）；`Settings.inline`（T6 定义/用）。前后一致。
- **顺序依赖**：T1（数学）→ T2（altscreen）→ T3（renderItem 抽取）→ T4（ScrollView，依赖 T3）→ T5（FullscreenApp，依赖 T1/T2/T4）→ T6（路由，依赖 T5）→ T7（验收）。严格串行。
- **无占位**：每步含真实代码/命令/期望。IME `linesBelowCaret` 与停泊行号是唯一标注「pty 微调」处——因终端真实行为无法在单测确定，按 spec 既定接受人工调参。
- **不碰**：useChat/App.tsx/caret.ts/各工具/loop/session 零改动；内联模式完全保留。
