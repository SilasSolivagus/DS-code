# M8 全屏可滚 TUI — 设计（P1/3：全屏骨架）

> 子项分期：**P1 全屏骨架 + 键盘滚动（本文）** → P2 鼠标/触控板滚轮 → P3 应用内选中复制。
> 每期各自 spec→plan→实现、独立可交付。

## 背景 / 动机

deepcode 当前是「内联」TUI：已完成消息走 ink `<Static>` 滚进终端**原生回滚**，靠终端自己回看历史。这在 Terminal.app 正常，但在用户的 Ghostty 上原生回滚完全失效（裸 `seq 1 300` 与键盘 `Shift+PageUp` 都滚不动），导致看不了之前的对话。CC 不受影响，因为它用魔改 ink 自带「alt-screen 全屏 + 鼠标捕获 + 自管滚动视口」，绕开终端原生回滚。

结论与决策：让 deepcode 也**自带滚动、不依赖终端原生回滚**。用户选定：全屏接管（像 CC/less/vim）、键盘+鼠标滚轮、应用内选中复制、默认开 + 逃生开关。

## 目标（P1）

- 默认进入 **alt-screen 全屏**：转录区可在 deepcode 内部上下滚动；输入框 + 状态页脚钉在底部。
- **键盘滚动**：`PageUp`/`PageDown` 翻页；`Ctrl+G` 跳到底并恢复跟随。
- **auto-follow**：在底部时新输出自动跟随；向上滚后冻结、不被新输出拽下去；滚回底部自动重新跟随。
- **滚动位置提示**：视口显示「还有更多在上/下」与行区间，便于发现可滚。
- **逃生开关**：`--inline` / `DEEPCODE_INLINE=1` / settings `inline:true` 任一 → 退回现有内联模式。
- **终端安全**：任何退出路径（正常/Esc/信号/异常）都还原主屏与光标。
- **IME 光标停泊**在全屏下改用绝对定位，更稳。

## 非目标（P1 明确不做）

- 鼠标/触控板滚轮（P2）。
- 应用内文本选中复制（P3；P1 期间用户可用终端 `Shift+拖拽` 绕过，文档说明）。
- 转录的虚拟化裁剪（P1 渲染全部 item 再 clip，长会话性能优化留后）。

## 架构总览

- 入口 `src/tui/index.tsx` 按逃生开关路由：内联 → 现有 `App`；否则 → 新 `FullscreenApp`（仅 TTY）。
- `FullscreenApp` 复用现有 `InputBox` / `StatusFooter` / `Suggestions` / `PermissionDialog` / `QuestionDialog` / `SelectList`，**只替换转录渲染**为新的 `ScrollView`，并加全屏布局 + 滚动状态 + alt-screen 生命周期。
- `useChat` 会话核心**零改动**。

### 模块与文件

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/tui/index.tsx` | 改 | 逃生开关路由：内联 App vs FullscreenApp |
| `src/tui/altscreen.ts` | 建 | 进/出 alt-screen + 全路径还原（信号/exit/异常） |
| `src/tui/scroll.ts` | 建 | 纯滚动数学：clamp、翻页、auto-follow 状态机（可单测） |
| `src/tui/ScrollView.tsx` | 建 | 固定高度裁剪视口 + measureElement 量高 + 滚动状态 + 位置提示 |
| `src/tui/FullscreenApp.tsx` | 建 | 全屏变体：布局 + 接线（复用输入/页脚/弹窗 + ScrollView） |
| `src/tui/renderItem.tsx` | 建（抽取） | 从 `Transcript.tsx` 抽出 `renderItem`/`isDone`，供内联 Transcript 与全屏 ScrollView 共用 |
| `src/tui/components/Transcript.tsx` | 改 | 改为 import 共享 `renderItem`（行为不变） |
| `src/tui/caret.ts` | 复用 | `parkCol` 复用于全屏停泊列计算 |

## 渲染与滚动机制（核心）

ink 5 的 `<Box overflowY="hidden">` **真裁剪**（`render-node-to-output.js:60-61`），且导出 `measureElement(node)→{width,height}`。据此：

- `ScrollView`：
  - 外层 `<Box height={viewportH} overflowY="hidden">`。
  - 内层 `<Box ref={innerRef} flexDirection="column" marginTop={-scrollOffset}>`，渲染**全部** transcript item（复用 `renderItem`）。
  - 渲染后用 `measureElement(innerRef).height` 得 `totalH`，算 `maxScroll = max(0, totalH - viewportH)`。
  - `viewportH = max(1, rows - footerRows - inputRows)`；`footerRows`/`inputRows` 由现有动态规则得出（页脚 3 固定 + 记忆行 + 工具行；输入框边框/续行）。
- 负 `marginTop` = 向上滚的偏移；外层裁掉溢出。
- 量高有一帧延迟：渲染→量→`setTotalH`→下帧按新 `maxScroll` 钳位（auto-follow 下即贴底）。轻微闪动可接受。

### 滚动状态（`scroll.ts` 纯函数 + ScrollView 状态）

- `stuckToBottom: boolean`（默认 true）。
- `scrollOffset: number`（0 = 顶；`maxScroll` = 底）。
- 纯函数（可单测）：
  - `clamp(offset, maxScroll)`；
  - `page(offset, dir, viewportH, maxScroll)`（翻页 = ±(viewportH-1)）；
  - `applyFollow(offset, maxScroll, stuck)` → stuck 时返回 maxScroll，否则 clamp 原值；
  - `nextStuck(offset, maxScroll)` → offset≥maxScroll 即重新 stuck。
- 交互：`PageUp` → stuck=false + page up；`PageDown` → page down，若到底则 stuck=true；`Ctrl+G` → stuck=true（贴底）。

### 键位（P1）

输入框常驻、`↑↓`/字符键留给输入与历史，故滚动只用非打字键：
- `PageUp` / `PageDown`：翻页。
- `Ctrl+G`：跳到底 + 恢复跟随。

这些在 `FullscreenApp` 顶层 `useInput` 截获（不与 InputBox 冲突；InputBox 不处理 PageUp/PageDown/Ctrl+G）。

## alt-screen 生命周期与安全（`altscreen.ts`）

- `enterAltScreen()`：写 `\x1b[?1049h`（进备用屏存主屏）+ `\x1b[2J\x1b[H`（清屏归位）。返回幂等 `leave()`。
- `leave()`：写 `\x1b[?1049l`（还原主屏）+ `\x1b[?25h`（显示光标）。
- **全路径还原**：注册 `process.once('exit'|'SIGINT'|'SIGTERM'|'uncaughtException', leave)`；`FullscreenApp` 卸载与 `waitUntilExit` 后亦 `leave()`。幂等防重复。
- 仅 `process.stdout.isTTY` 时启用。

## IME 光标停泊（全屏，更稳）

全屏布局固定 → 输入插入点行号已知（`rows - footerRows - 输入光标行内偏移`）。每帧渲染后用**绝对定位** `\x1b[{row};{col}H`（`col = parkCol(draft, columns, dispWidth)`，复用已有 `parkCol`）把硬件光标钉到插入点，并 `\x1b[?25h`。比内联模式的「相对上移 + 包裹 stdout.write」hack 更可靠（无需猜下方行数、无需 erase 协同）。内联模式保留原 hack 不动。

## 数据流

`useChat`（不变）持 transcript/state → `FullscreenApp` 经 `useChat` 订阅 → `ScrollView` 拿全部 item 渲染进裁剪内层 → measureElement 得 totalH → 结合 `scrollOffset/stuck` 决定 `marginTop`。键位事件改 `scrollOffset/stuck`。宽/高变化触发重渲染与重新量高。

## 错误处理 / 边界

- **退出/信号/异常**：必还原终端（见上）。这是最高优先正确性。
- **resize**（`process.stdout.on('resize')`）：重算 `viewportH`/宽度 → 触发重渲染 → 重新量高 → 钳位 `scrollOffset`；stuck 则贴底。
- **极小终端**：`viewportH = max(1, …)`，不崩。
- **measureElement 未就绪**（首帧 ref 为空）：totalH 暂记 0、maxScroll=0，下帧修正。

## 测试策略

- `scroll.ts`：clamp/page/applyFollow/nextStuck 全分支单测（含到顶/到底/超界/viewportH=1）。
- `altscreen.ts`：enter/leave 转义串断言；leave 幂等；cleanup 注册（mock process）。
- `ScrollView`（ink-testing-library）：给定固定高度容器与 item，断言 `scrollOffset` 变化时可见切片正确、位置提示文案正确（measureElement 在测试环境的可用性若受限，则对纯切片/提示逻辑抽函数单测）。
- 回归：现有 240 测试保持绿；内联 `App` 行为不变（Transcript 抽取后快照/交互不变）。
- **pty 人工冒烟**（真终端，验收必跑）：进全屏、PageUp/PageDown/Ctrl+G、生成中 auto-follow、向上滚不被拽下、resize、`--inline` 退回、退出还原主屏、中文 IME 组字在框内。

## 已知风险（实现期重点盯）

1. **ink 在 alt-screen 多写一行/带尾换行会顶得备用屏滚动错乱**（CC 专门有 `use-terminal-viewport`）。须保证整体渲染高度 ≤ `rows`、压掉尾换行；必要时根 Box 显式 `height={rows}`。
2. **measureElement 一帧延迟** 致 auto-follow 贴底时偶发一帧未贴底——可接受；若闪动明显，量高后同步再 setState 一次。
3. **长会话渲染全部 item 再 clip 的性能**——P1 可接受，超长再做虚拟化（P-later）。
4. **renderItem 抽取**勿改内联行为——抽取即回归现有 Transcript 测试。

## 验收标准（P1）

- 默认全屏；`--inline`/env/settings 任一可退回内联。
- Ghostty 等终端下，PageUp/PageDown 能滚看历史、Ctrl+G 贴底；auto-follow 行为正确。
- 退出（含 Esc/Ctrl+C/kill）后终端干净还原。
- 中文 IME 组字在输入框内。
- 全量单测绿 + pty 冒烟清单通过。
- 内联模式行为与改动前一致。
