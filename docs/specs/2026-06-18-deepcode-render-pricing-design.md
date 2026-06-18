# 显示层批（A 批）— 设计

> 真机冒烟发现的 3 个显示层问题。状态：设计待批准（2026-06-18）。

## 背景

第 2 层批真机冒烟时发现 3 个 deepcode 显示层缺陷，用户拍板全做：
- **#2** markdown 表格 CJK 列宽错位（真 bug，已知有文档）
- **#1** 流式输出先显示 markdown 源码、turn 结束才渲染富文本（对齐 CC 边流边渲染）
- **#4** 费用展示用美元，应为人民币（DeepSeek 实际人民币计费）

实读核实：CC 有 `StreamingMarkdown`（stablePrefix 增量渲染）；`string-width@7.2.0` 已是传递依赖；DeepSeek 官方人民币单价与现有模型名吻合。

---

## 组件 1 — 表格 CJK 列宽修复（#2，纯逻辑）

`src/tui/markdown.ts` 的 `table()`（:31）用 `.length` 算列宽，CJK 全角字符在终端占 2 格但 JS `.length=1`，导致中文表格列右漂。

修法：
- 顶部 `import stringWidth from 'string-width'`（已是传递依赖，ESM）。
- 列宽计算（:38-39）`.length` → `stringWidth(...)`。
- `padEnd`（:46）无法用（按 JS 字符数补），改手写 `padToWidth(s, w) = s + ' '.repeat(Math.max(0, w - stringWidth(s)))`。
- 删除 :4 那条"CJK 全角偏差"的已知限制注释（已修复）。

测试（`test/markdown.test.ts`，若无则建）：含 CJK 的表格各列右边界对齐（用 `stringWidth` 验证每行渲染后到分隔符 `│` 的显示宽度一致）。

---

## 组件 2 — 流式渐进 markdown 渲染（#1，碰 TUI）

现状（`renderItem.tsx:44-50`）：assistant 块 `item.done` 才 `renderMarkdown`，流式中显示原文。改为流式期间也增量渲染（方案 A，移植 CC stablePrefix）。

### 新组件 `src/tui/StreamingMarkdown.tsx`
React 组件 `StreamingMarkdown({ text }: { text: string })`，返回 `<Text>{ansi}</Text>`：
- `boundaryRef = useRef(0)`：已稳定前缀的结束位置（text 索引）。
- 每次渲染：`marked.lexer(text.slice(boundaryRef.current))` 得 tokens；找最后一个非空白 token（正在增长的块），其前所有 token 的 `raw` 长度累加 → 推进 `boundaryRef.current`。
- `stablePrefix = text.slice(0, boundary)`，`unstableSuffix = text.slice(boundary)`。
- `stableAnsi = useMemo(() => renderMarkdown(stablePrefix), [stablePrefix])`（前缀不变不重解析）。
- `unstableAnsi = renderMarkdown(unstableSuffix)`（每次重算，通常仅末段，<1ms）。
- 返回两段拼接（`stableAnsi + unstableAnsi`，注意衔接换行）。
- 未闭合代码围栏：`marked.lexer` 降级为单 `code` token 留在 unstableSuffix，逐字显示无高亮、闭合后切入，可接受。

### 接线
`renderItem.tsx` 流式 assistant 分支（:49-50）：把 `withBullet(item.text)` 改为 `withBullet` 包裹 `<StreamingMarkdown text={item.text} />`。
- 注意 `withBullet` 现接 ANSI 字符串；StreamingMarkdown 是组件。需让流式分支返回 `<Box>{bullet}<StreamingMarkdown .../></Box>` 结构（参照 done 分支的 withBullet 布局，把 bullet + 组件并排）。具体在计划里定。
- done 分支不变（仍 `renderMarkdown` 一次性）。
- 前提确认：流式 item（done:false）不在 ink `Static` 区，每 delta 重渲染，useRef 跨 delta 持久——已核实（仅 done 项进 Static）。

测试：StreamingMarkdown 纯逻辑部分（boundary 推进、stablePrefix 切分）抽成可测纯函数 `splitStablePrefix(text): { stable: string; unstable: string }`，单测：完整段落全进 stable、未闭合代码块留 unstable、空文本、单行未完。组件渲染靠真机冒烟。

---

## 组件 3 — 人民币定价（#4，碰 TUI）

方案 A：直接换人民币数值 + 符号 $→¥。官方核实单价（每百万 token）：

| 模型 | hit | miss | out |
|---|---|---|---|
| deepseek-v4-flash | ¥0.02 | ¥1 | ¥2 |
| deepseek-v4-pro | ¥0.025 | ¥3 | ¥6 |

改动（7 处展示 + 定价 + 配置）：
- `src/pricing.ts`：PRICES 换 CNY 数值；`costUSD`→`costCNY`、`cacheSavingsUSD`→`cacheSavingsCNY`（注释更新「人民币」+ 核实来源中文定价页）。
- `src/config.ts`：`Settings.costWarnUSD`→`costWarnCNY`，默认 `2`→`15`。**向后兼容**：`loadSettings` 读 `raw?.costWarnCNY ?? raw?.costWarnUSD ?? 15`（旧配置 costWarnUSD 仍生效，不破坏现有用户）。
- `src/tui/useChat.ts`：import 名、`cacheSavings()` 内调用名、`/cost` 输出 `$`→`¥`、costWarn 提醒文字 `$`→`¥` + 字段名 `costWarnCNY`、`sessionCost` 内 `costCNY`。
- `src/stats.ts`：`/stats` 输出 `估算花费：$`→`¥`。
- `src/tui/components/StatusFooter.tsx`：2 处 `$`→`¥`（cache savings + 累计花费）。
- `src/tui/renderItem.tsx`：usage 行 `$`→`¥`。
- `src/headless.ts`：返回字段 `costUSD`→`costCNY`（不展示给用户，仅结构一致）。
- 更新所有相关测试（pricing.test/stats.test 等）的函数名 + 期望值（CNY）。

测试：`costCNY`/`cacheSavingsCNY` 用 CNY 单价算对；`costWarnUSD` 旧键向后兼容读取。

---

## 验收

- 全量 `npm test` + typecheck + build 全绿。
- 纯逻辑（#2 表格宽度、#1 splitStablePrefix、#4 定价）TDD 免冒烟；**碰 TUI（#1 流式组件、#4 状态行/usage 行 ¥）→ 合 main 前用户真机冒烟**：①流式输出边流边渲染富文本（不再先显示源码）②中文表格列对齐 ③状态行/`/cost`/`/stats` 显示 ¥ 且数值合理。

## 既定流程

brainstorm（本 spec）→ writing-plans → subagent-driven（每任务双审，#1 流式组件架构件末加 opus 终审）→ 用户真机冒烟 → 合 main → push。B 批（安全加固 #3）单独走。
