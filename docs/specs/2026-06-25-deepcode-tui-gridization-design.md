# Design — deepcode TUI 输出栅格化（对齐 CC 垂直节奏）

**日期**：2026-06-25
**背景**：用户指出 deepcode 输出不满足 CC 那种「栅格化」设计——很多块贴在一起、不空行，缺垂直节奏与左右留白。本设计系统化地给 TUI 输出加间距，对齐 CC。
**流程**：brainstorm（本文）→ writing-plans → SDD（fresh subagent + sonnet 双审）→ opus 全分支终审 → 真机冒烟（碰 TUI，双组件）→ 合并。

---

## 用户已拍板的决策

1. **整体节奏 = CC 同款**：块与块之间空 1 行；`⏺` 紧贴它的 `⎿`（块内不空行）；左右各留 **1 列 gutter**。
2. **范围 = 全面**：transcript 输出 + 周边 chrome（banner / 输入区 / 页脚 / suggestions）全梳。
3. **页脚 = 逻辑分组**（非每行都空行）：5 行 status 聚成 2–3 簇，簇间空 1 行 + 页脚整体上方空 1 行，控制在 ~6–8 行，不过度吃小终端竖向空间。

---

## 审查实据（支撑本设计）

**CC 垂直节奏核心规则**（实读 bundle，可靠部分）：块间 `marginTop:1`（空一行）为压倒性默认；工具结果 `⎿` 紧贴 `⏺`；整体 `paddingX:1`；嵌套/续行/思考块 2–3 列左缩进。
（CC 审查里的「99%」是全 bundle 聚合频率，含弹窗/引导，当精确比例失真；只取「块间空一行 + ⎿ 贴附 + paddingX:1」这条主规则。）

**deepcode 现状缺陷**（精确 file:line）：
- 🔴 `src/tui/renderItem.tsx`：每种 kind（user/assistant/reasoning/tool/usage/notice/bang）裹在裸 `<Box>`，**无任何 margin**，块间零间距 —— 根因。
- 🟡 `src/tui/App.tsx:224` / `src/tui/FullscreenApp.tsx` 主容器无 `paddingX`，内容顶满屏边。
- 🟡 `src/tui/components/StatusFooter.tsx:51-103`：5 行 status 行间无距，挤成一坨。
- 🟡 `src/tui/components/ToolLine.tsx`（`⎿` 缩进硬编码 5 列）vs `src/tui/markdown.ts`（列表续行 2 列）缩进不统一；间距全散在各组件硬编码，`theme.ts` 无间距常量。
- 🟢 markdown 块间已有 `\n\n`（不缺，本设计不动 markdown 内部）。

---

## 架构：集中式间距 + theme 间距常量

**选定方案**：间距集中在「容器层 + theme 常量」，不散到各组件、不动 `renderItem` 内部。
- 否决「每组件内联 margin」（散、难一致、要碰的地方多）。
- 否决「插空行文本节点」（与 ink `<Static>` 去重机制打架）。

### 1. 间距常量（`src/tui/theme.ts`）
新增语义化常量（单一事实源）：
```ts
export const GUTTER = 1     // 容器左右 paddingX（左右各留 1 列）
export const BLOCK_GAP = 1  // 块间 marginTop（空一行）
export const INDENT = 2     // 缩进步长基准（⏺ + 空格 = 2 列）
```

### 2. transcript 块节奏（容器层注入，`renderItem` 不改）
两条渲染路径都要应用，统一规则：
- **内联路径** `src/tui/components/Transcript.tsx`：
  - Static 区每项（:31 的 `<Box>`）加 `marginTop={index === 0 ? 0 : BLOCK_GAP}`（首项即 banner 不顶空行；其后每项前空一行）。
  - Live 区每项（:39 map）用 `<Box marginTop={BLOCK_GAP}>` 包裹（live 区上方恒有 banner/done 项，故首项也留分隔）。
- **全屏路径** `src/tui/ScrollView.tsx`（:33 items map）：每项加 `marginTop={index === 0 ? 0 : BLOCK_GAP}`。
- `⎿` 预览仍在 `ToolLine` 内、紧贴 `⏺`，**块内不动**（保持 CC「⎿ 贴附」）。

### 3. 左右 gutter（统一左边缘）
- `src/tui/App.tsx:224` 主列 `<Box flexDirection="column">` 加 `paddingX={GUTTER}`。
- `src/tui/FullscreenApp.tsx` 顶层容器加 `paddingX={GUTTER}`。
- 效果：banner / transcript / 输入框 / 页脚 左边缘统一右移 1 列，整体栅格留白。**`⎿` 与 `⏺` 的相对对齐不受影响**（同在 paddingX 内坐标系）。

### 4. 缩进统一（以 INDENT=2 为基准）
- `ToolLine` 的 `⎿` 续行缩进、markdown 列表续行缩进，收敛到 `INDENT` 的整数倍，消除「5 列 vs 2 列」错位。
- 保持 `⎿  ` 子串本身不变（现有 transcript 测试断言依赖），仅校准续行对齐常量来源。

### 5. chrome（全梳）
- **Banner**（`Banner.tsx`）：加 `marginBottom={BLOCK_GAP}`（已有 `paddingX={1}`）。
- **transcript ↔ 输入区**：输入区容器加 `marginTop={BLOCK_GAP}`（空一行分隔）。
- **StatusFooter**（`StatusFooter.tsx`）：**逻辑分组**，3 簇——
  1. 模型 · 模式 · git
  2. context · 缓存 · 花费（+ 自定义 statusline 行，若有）
  3. 记忆文件数 · 工具计数 · 命令提示（各为可选行，存在才显示）
  - 簇间空 1 行；页脚整体上方空 1 行。空簇（无可选行）不产生多余空行。
- **Suggestions**（`Suggestions.tsx`）：加 `paddingX={GUTTER}` 对齐左边缘；**列表项保持紧凑**（选择列表项间不插空行）。

---

## 测试影响

- **改**：
  - `test/tui.transcript.test.tsx`：`⎿  ` 子串仍在（缩进不变）；`UNIQUE-PREVIEW` / `saved-file.ts` 是计**出现次数**、不受空行/gutter 影响——预期无需改断言，但需复跑确认 Static 去重在加 marginTop 后仍不重复输出。
  - `test/tui.app.test.tsx`：对行范围/帧高度敏感处随空行增加微调。
- **新增**：`test/tui.gridization.test.tsx`——断言「相邻两个 transcript 块之间存在空行」锁住节奏（渲染 user+assistant 两项，frame 中两者之间有空行）。
- **新增**：StatusFooter 分组断言（3 簇、簇间空行、可选行缺失时不留空簇）。

---

## 风险（真机冒烟重点）

1. **ink `<Static>` + marginTop 去重交互**：done 项迁入 Static 时不能重复输出空行（Static 内部按新增尾部去重，marginTop 是项内属性，理论安全，但必须真机验）。
2. **gutter paddingX 右移后 `⎿`/markdown 对齐**：确认相对缩进保持。
3. **小终端页脚高度**：分组后 ~6–8 行，验证 24 行终端不挤掉输入框。
4. **双组件铁律**：内联 `Transcript`（App）与全屏 `ScrollView`（FullscreenApp）**两条路径都要改并都冒烟**（默认跑全屏 FullscreenApp）。

---

## 范围红线（不做）

- 不改 markdown 内部渲染（段间 `\n\n` 已够；列表/代码块内部样式不动，仅校准续行缩进常量来源）。
- 不动 Sleep+tips 批（那批计划已就绪，本件做完再回去）。
- 不引入响应式断点/终端宽度自适应间距（YAGNI；GUTTER/BLOCK_GAP 固定值）。
- 不重构 theme 为间距 scale 体系（只加 3 个语义常量，够用即止）。

---

## Self-Review

- **占位符**：无 TBD/TODO。
- **一致性**：架构（集中式 + 常量）↔ 各组件改动 ↔ 测试 一致；3 个常量 GUTTER/BLOCK_GAP/INDENT 全程引用一致。
- **范围**：聚焦单一实现计划可承载（间距系统 + 容器接线 + chrome + 测试）。
- **歧义**：页脚定为「逻辑分组 3 簇」（非每行空行），已明确。块首项不顶空行规则已明确（Static index 0）。
