# deepcode CC UI 1:1 复刻计划（M5.5）

2026-06-13。用户在 M5 验收中途改方向：**不要「CC 风格」，要 1:1 复刻 CC 真实 UI**，仅两处保留 DeepSeek 辨识度：
1. **强调色** = 鲸鱼蓝 `#4D6BFE`（CC 是橙/棕，全部换成鲸鱼蓝）
2. **欢迎页** = deepcode 品牌（🐳）

用户两项明确决策（AskUserQuestion）：
- **UI 语言：中文标签**（CC 的布局/符号 1:1，文字保持中文；spinner 用中文动词）
- **底部指标行：纯 CC**——砍掉常驻的「缓存命中率/tok-s」状态行（`StatusLine` 删除）。花费只在每轮结束的 usage 行显示。底部只留 `? 查看快捷键` 提示。

> 这意味着此前「DeepSeek 辨识度」清单（紫色思考块、缓存命中率状态行、braille spinner）全部让位给 CC 的等价物。辨识度只剩鲸鱼蓝 + 欢迎页。

执行：subagent-driven，每任务规格审查 + 质量审查双门。ink 组件测试用 ink-testing-library。

---

## CC 真实 UI 参照（中文本地化目标）

逐元素对照「CC 实际渲染 → deepcode 当前 → 1:1 目标」。

### A. 欢迎页（Banner.tsx 重写）
CC：圆角框 `✻ Welcome to Claude Code!` + 空行 + `/help` 提示 + `cwd:`。
deepcode 当前：单行 `🐳 deepcode v{ver}` + 一长串 dim 提示。
**目标**（鲸鱼蓝圆角框）：
```
╭──────────────────────────────────────────────╮
│ 🐳 deepcode                                    │
│                                                │
│   DeepSeek 终端编码助手 · 输入 /help 看帮助       │
│                                                │
│   cwd: {cwd}                                    │
│   模型: {model}                                  │
╰──────────────────────────────────────────────╯
```
- 框 `borderStyle="round"` `borderColor=accent`；`🐳 deepcode` 鲸鱼蓝粗体；其余 dim。
- 原 Banner 里那行操作提示（`/命令 @文件 !shell …`）移除（移到输入框下的 `? 查看快捷键`，详见 F）。

### B. 用户消息（Transcript user）
CC：`> {text}`（`>` + 文字）。deepcode 当前：`› {text}` dim。
**目标**：前缀符号 `›` → `>`，`>` 用 accent，文字 dim（保持 CC 观感）。

### C. 助手消息（Transcript assistant）
CC：每段以 `⏺ ` 实心点起头（accent 色），后接正文；折行续行悬挂缩进 2 格。
deepcode 当前：纯 markdown，无前缀。
**目标**：
```
⏺ {markdown 首行}
  {markdown 续行…}
```
- `⏺` 鲸鱼蓝。正文走现有 `renderMarkdown`。
- 悬挂缩进尽力而为（ink `<Box>` 里 bullet 列 + 正文列）；markdown 多行/代码块情况下若难以完美对齐，首行带 `⏺`、正文整体缩进 2 即可，不过度工程。

### D. 工具调用（ToolLine + Transcript tool 重写）
CC：
```
⏺ Read(src/foo.ts)
  ⎿  读取 42 行 (ctrl+o 展开)
⏺ Bash(npm test)
  ⎿  > vitest run
     ✓ 42 passed
     … +10 行
```
deepcode 当前：运行中 braille spinner `⠋ name(desc)`；完成 `  ⎿ preview（0.5s）`。
**目标**：
- 工具行：`⏺ {ToolName}({主参})`，`⏺`+名鲸鱼蓝。**主参格式化**：Read/Edit/Write→`file_path`，Bash→`command`，Grep→`pattern`，Glob→`pattern`，Agent→任务摘要；取不到则原样截断。参数 dim，超长截断 `…`。
- 结果行：`  ⎿  {preview}` dim。preview 多行时首行展示 + `… +{N} 行` 标注（N=剩余行数）。
- **去掉 per-tool 耗时 `（0.5s）`**（CC 不显示，耗时归到底部 spinner 的整轮计时）。
- 运行中不再每工具一个 spinner——工具行出现即 `⏺ Name()`（静态），结果到了填 `⎿`。整体「忙」由底部单 spinner 指示（见 E）。

### E. 工作 spinner（新组件 Spinner.tsx，App live 区，仅 busy 时）
CC：`✻ Cogitating… (8s · ↑ 2.1k tokens · esc to interrupt)`，符号动画 + 随机动词 + 秒数 + 输出 token 数 + esc 提示。
**目标**（中文）：
```
✻ 琢磨中… (12s · ↑ 1.2k tokens · esc 中断)
```
- 符号每 ~120ms 在 `✻ ✳ ✶ ✺ ✹ ✷` 间轮换（鲸鱼蓝）。
- 动词从中文趣味动词表轮换（每轮随机选一个，整轮不变）：`琢磨中 盘算中 捣鼓中 思索中 合计中 拾掇中 盘点中 鼓捣中 推敲中 寻思中`。
- 秒数 = 自本轮 `send` 起的经过秒（每秒刷新）。
- token = 本轮累计输出 token（≥1000 显示 `1.2k`）。
- esc 提示固定 `esc 中断`。
- 位置：transcript 之下、输入框之上；`busy && !pendingAsk && !resumeMode` 才渲染。

**useChat 增量**（支撑 spinner）：
- `send` 时记 `turnStartAt = Date.now()`、`turnOutTokens = 0`。
- 每个 content delta 累加 `turnOutTokens`（用分片 token 估算或在 turn_end 用 usage 修正；spinner 实时值用增量估算即可，无需精确）。
- 轮结束 `turnStartAt = null`。
- ChatState 暴露 `turnStartAt: number | null`、`turnOutTokens: number`。
- 注：spinner 的「秒数」用组件内 `useEffect` 定时器读 `turnStartAt` 算，避免每秒触发全局 rerender。

### F. 输入框（InputBox）
CC：
```
╭──────────────────────────────────────────────╮
│ > {placeholder}                                │
╰──────────────────────────────────────────────╯
  ? for shortcuts
```
deepcode 当前：`› ` 提示符 + 一长串中文 placeholder，无下方提示行。
**目标**：
- 提示符 `›` → `> `（accent）。
- placeholder 改简洁 `随便问点什么…`（busy 时 `生成中… esc 中断`）。
- 框下加一行 dim：`? 查看快捷键`（`?` 面板本身可延后，先只显示提示文字；实际敲 `?` 展开快捷键面板列入 M6）。
- 续行/历史/Esc 语义不变。

### G. 思考块（Transcript reasoning）
CC：思考内容 dim 灰斜体流式，完成后折叠。deepcode 当前：紫色 `✻ 思考中…` + 折叠 `✻ 已思考（N行）`。
**目标**：紫色 → dim 灰斜体（对齐 CC，放弃紫色辨识度）。进行中 `✻ 思考中…`（dim 斜体）+ 最近 3 行 dim 斜体；完成折叠 `✻ 已思考 {n}s`（dim）。`✻` 符号保留但用 dim（非 accent）。

### H. 状态行（StatusLine.tsx）→ 删除
- 从 App 移除 `<StatusLine>`。
- 文件可删除（或保留但不挂载——倾向删除 + 删对应测试）。
- 花费/usage：保留每轮结束的 `usage` transcript 行（已存在），轻度对齐 CC（dim）。

### I. 权限弹窗（PermissionDialog）→ 贴近 CC 编号菜单
CC：
```
要执行这个操作吗？
❯ 1. 允许
  2. 总是允许（本会话不再询问）
  3. 拒绝
```
deepcode 当前（P1 已是 ↑↓ 菜单 `❯ 允许/总是允许/拒绝`）。
**目标**：选项加编号 `❯ 1. 允许 / 2. 总是允许 / 3. 拒绝`，加问句行 `要执行这个操作吗？`；其余（diff 预览、高危警告、↑↓+Enter、y/n/a 快捷键、idx 随 ask 重置）不变。数字键 1/2/3 也可直接选（顺手加）。

### J. 补全菜单（Suggestions）
CC：命令补全列表在输入框下，选中行高亮 + 命令描述。deepcode 当前已接近。
**目标**：选中行用 accent 背景/前缀对齐 CC；命令描述 dim。低优先，微调即可。

---

## 文件结构（增量）

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/tui/theme.ts` | 改 | accent 不变；新增 spinner 符号帧 `SPINNER_SYMBOLS`、动词表 `THINKING_VERBS`；`reasoning` 改 dim 语义（或弃用） |
| `src/tui/components/Banner.tsx` | 重写 | 欢迎框（A）；接 `cwd` prop |
| `src/tui/components/Spinner.tsx` | 新建 | 工作 spinner（E） |
| `src/tui/components/ToolLine.tsx` | 重写 | `⏺ Name(主参)` + `⎿` 结果（D）；移除 spinner/耗时 |
| `src/tui/toolArg.ts` | 新建 | 工具主参提取/格式化（D），纯函数好测 |
| `src/tui/components/Transcript.tsx` | 改 | user `>`、assistant `⏺`、reasoning dim、usage dim（B/C/G/H） |
| `src/tui/components/InputBox.tsx` | 改 | `> ` 提示符、placeholder、下方 `? 查看快捷键`（F） |
| `src/tui/components/PermissionDialog.tsx` | 改 | 编号 + 问句行 + 数字键（I） |
| `src/tui/components/Suggestions.tsx` | 改 | 选中态对齐 CC（J，低优先） |
| `src/tui/components/StatusLine.tsx` | 删 | 纯 CC 无常驻指标行（H） |
| `src/tui/useChat.ts` | 改 | `turnStartAt`/`turnOutTokens` 暴露（E） |
| `src/tui/App.tsx` | 改 | 挂 Spinner、去 StatusLine、Banner 传 cwd |
| `test/tui.*.test.{ts,tsx}` | 改/增 | 各组件 |

---

## 任务拆分

- **Task 1：theme + useChat 计时/计数 + Spinner 组件**
  theme 增 `SPINNER_SYMBOLS`/`THINKING_VERBS`；useChat 暴露 `turnStartAt`/`turnOutTokens`（send 置位、delta 累加、turn_end 清零）；新建 `Spinner.tsx`（符号动画 + 动词 + 秒 + token + esc 中断）。测试：Spinner 渲染含 `esc 中断`、token 格式化（1234→1.2k）；useChat turn 字段单测。

- **Task 2：欢迎框 + 删 StatusLine + 输入框**
  重写 Banner 为欢迎框（A，传 cwd/model）；删 StatusLine.tsx 及其测试与 App 引用；InputBox 改 `> ` + placeholder + `? 查看快捷键`（F）。测试：Banner 含 `🐳 deepcode`/`cwd:`/`模型:`；InputBox 含 `>` 与 `? 查看快捷键`。

- **Task 3：工具行 + 主参格式化**
  新建 `toolArg.ts`（D 主参规则，纯函数全覆盖单测）；重写 ToolLine（`⏺ Name(主参)` + `⎿ preview` + `… +N 行`，去耗时/spinner）。测试：toolArg 各工具；ToolLine 完成态渲染。

- **Task 4：Transcript 对齐（user/assistant/reasoning/usage）**
  user `>`、assistant `⏺` 鲸鱼蓝 bullet + 悬挂缩进、reasoning dim 斜体 + 折叠 `✻ 已思考 {n}s`、usage dim。接 Task 3 的 ToolLine。测试：assistant 含 `⏺`、user 含 `>`、reasoning done 折叠文案。

- **Task 5：权限弹窗编号 + 补全菜单微调**
  PermissionDialog 加编号/问句行/数字键（I）；Suggestions 选中态（J）。测试：弹窗含 `1. 允许`、数字键 2 触发 always；既有 P1 用例更新。

- **Task 6：App 装配 + 集成 + 验收**
  App 挂 Spinner（busy live 区）、去 StatusLine、Banner 传 cwd/model。npm test + typecheck 全绿；pty 冒烟复跑（banner 欢迎框/输入框/spinner/工具行/`/exit` 退出）；ansitoimg 截图欢迎页 + 一轮问答给用户看。

---

## 自查

- **需求覆盖**：1:1 CC = A-J 全部对齐；保留项 = 鲸鱼蓝（theme accent 不动）+ 欢迎页 deepcode 品牌（A）；砍掉 = StatusLine 指标行（H）、紫色思考（G→dim）、braille/per-tool spinner（D/E→CC 单 spinner）。语言中文（用户定）。
- **顺序依赖**：T1→T6（Spinner 依赖 useChat 字段）；T3→T4（Transcript 用 ToolLine）；T2/T5 相对独立；T6 最后集成。
- **已知权衡**：assistant 悬挂缩进对 markdown 代码块尽力而为；`?` 快捷键面板只显示提示文字、面板本身延后 M6；spinner token 用增量估算（非精确，turn_end 由 usage 修正不影响显示）。
- **不碰**：loop/api/headless/session 等核心零改动（纯 TUI 表现层）；headless 路径不受影响。
- **破坏性**：无新增（仍 TTY→TUI）；视觉大改但行为语义不变。
