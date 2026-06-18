# 第 2 层收尾批 — 设计

> master roadmap 第 2 层（运行时/推理）剩余件挤干水分后的实做批。状态：设计待批准（2026-06-18）。

## 背景与范围裁定（实读 CC + deepcode 现状后）

派 agent 对第 2 层 6 件逐件实读盘点，挤掉已做/不适用的：

| 件 | 判定 | 处置 |
|---|---|---|
| 2.4 Prompt 缓存 | ✅ 已完成（本会话 `841b264`） | — |
| 2.6 Cost 告警 | ✅ 已完成且领先 CC（`useChat.ts:556` `costWarnUSD` 交互告警，CC 仅退出打印） | 不做 |
| 2.2 Microcompact | ⛔ 对 DeepSeek 不适用：CC 靠 Anthropic cache-editing API + 1h server TTL 省钱；DeepSeek 自动前缀缓存，改写历史会**砸前缀缓存**，得不偿失 | 不做 |
| 2.3 自动 compact | 🟡 已大量实现（`useChat.ts:574-576` 自动触发 + 上下文条），缺熔断器 + 预警色 | **做** |
| 2.1 思考预算 + 2.7 模型切换 | 🟡 实为同一件：把写死的 `reasoning_effort:'medium'`（`api.ts:127`）档位化 | **做（合并）** |
| 2.5 Token 计数 | ⛔ DeepSeek 无 tokenizer，事后精确计数已从 usage 拿到；仅保留一个 char-based tool-result 兜底拦截 | **做（小补丁）** |

本批做三组件。**明确不做**：2.2 Microcompact、2.6（已完成）、CC 的 thinking budgetTokens/adaptive（Anthropic 专属）、`/fast`（Anthropic 付费特性）、token countTokens 多后端（DeepSeek 无）。

---

## 组件 1 — effort 档位系统（2.1 + 2.7 合并，碰 TUI）

把当前写死的 `reasoning_effort: 'medium'` 变成可调档位，并支持关键词自动升档。**最小改动、向后兼容**：保留 `thinking: boolean` 作总开关，新增 `effortLevel` 作「开时用哪档」。

### 状态模型
- 新增会话级状态 `effortLevel: 'low' | 'medium' | 'high'`，默认 `'medium'`（= 现状字节级等价）。
- `thinking: boolean` 语义不变（是否思考）。`thinking=false` → API `thinking:{type:'disabled'}`；`thinking=true` → `reasoning_effort: effortLevel` + `thinking:{type:'enabled'}`。

### 改动点
- `src/api.ts`：`ChatOptions` 加 `effortLevel?: 'low'|'medium'|'high'`；`chatStream` 第 126-128 行 `reasoning_effort: 'medium'` → `reasoning_effort: opts.effortLevel ?? 'medium'`（不传时仍 medium，向后兼容）。
- `src/loop.ts`：`LoopDeps` 加 `effortLevel?`；第 148 行 `thinking: deps.thinking` 旁传 `effortLevel: deps.effortLevel`。
- `src/tui/useChat.ts`：
  - 加 `let effortLevel: 'low'|'medium'|'high' = 'medium'`（init）。
  - `ChatState` 加 `effortLevel`，`snap()` 暴露（状态行显示）。
  - 三处 `runLoop`/runTurn 调用把 `effortLevel` 传进 LoopDeps（与现有 `thinking` 并排）。
  - **`/effort` 命令**（紧邻 `/think`，~:642）：`/effort low|medium|high` → 设 `effortLevel` 且 `thinking=true`；`/effort off` → `thinking=false`；无参或非法值 → 打印当前档 + 用法。改后 `appendMeta`。
  - **`/think` 共存**（现有 :642）：保持切 `thinking` bool（on 时用当前 `effortLevel`，默认 medium）。
  - **关键词自动升档**：`send()` 处理用户输入时，若文本命中 `\bultrathink\b` 或 `think harder`/`think hard`（不区分大小写）→ **本轮临时** `thinking=true` + `effortLevel='high'`（仅本次 send 生效，不改持久状态、不 appendMeta）。用纯函数 `detectEffortKeyword(text): 'high' | null` 实现（可单测）。
  - session meta 持久化：`appendMeta({ cwd, model, thinking, effortLevel, permMode })`（4 处 appendMeta + newSession + resume 恢复）。resume 旧会话无 `effortLevel` 字段 → 默认 `'medium'`。
- `src/tui/components/StatusFooter.tsx` + `App.tsx`/`FullscreenApp.tsx`：状态行 Row 1 模式段后显示当前 effort（仅 `thinking` 开时显示，如 `| think:high]`；关时不显示，避免噪音）。
- HELP_TEXT 加 `/effort low/medium/high/off  思考强度档位`。

### 不做
CC 的 budgetTokens/adaptive thinking（Anthropic 专属）、`/fast`。

---

## 组件 2 — 自动 compact 健壮性（2.3，纯逻辑 + TUI）

deepcode 已有自动 compact（`useChat.ts:574-576`：`lastPromptTokens > compactTokens` 触发，失败下轮重试）。补两块：

### 2a. 失败熔断器（纯逻辑）
- `useChat.ts` 加 `let consecutiveCompactFailures = 0`。
- 自动 compact（`doCompact('auto')`）失败 → `consecutiveCompactFailures++`；成功 → 归零。
- 连续达上限 `MAX_AUTO_COMPACT_FAILURES = 3` → 停止自动触发（`if (failures < 3 && lastPromptTokens > compactTokens)`）+ 一次性 notice「自动压缩连续失败 3 次，已暂停（可 /compact 手动重试）」。
- **绝不落盘、bind/resume 时归零**（对齐 2.4 走神计数器教训：防 resume 刷屏）。
- 手动 `/compact` 成功后也归零（给自动一次重新开始的机会）。

### 2b. 上下文条预警色（TUI）
- `StatusFooter.tsx` 上下文条按 `contextPct` 分段着色：`<80` → accent（现状）；`80–94` → warn（黄）；`≥95` → err（红）。
- 接近阈值一次性 notice：`contextPct` 首次 ≥90 时 warn notice「上下文已用 N%，接近自动压缩阈值」（用一次性标志 `compactWarned`，compact 成功后重置）。

---

## 组件 3 — char-based tool-result 兜底拦截（2.5，纯逻辑）

DeepSeek 无 tokenizer，但超大工具结果（如 Read 巨型 minified 文件、Bash 海量输出）会塞爆上下文。加一个保守的字符级兜底截断。

- 新纯函数 `capToolResult(content: string, maxChars: number): string`（放 `src/text.ts`）：`content.length <= maxChars` → 原样返回；否则保留头 `maxChars*0.7` + 尾 `maxChars*0.2` 字符，中间替换为 `\n…[工具结果过大，已截断 N 字符]…\n`。
- 阈值 `maxChars` 默认 `100_000`（≈25k token，只拦病态超大；可经 `settings.maxToolResultChars` 覆盖，`config.ts` 加解析）。
- 落点 `src/loop.ts` `execCall`：成功返回 content 前 `content = capToolResult(content, deps.maxToolResultChars ?? 100_000)`（PostToolUse hook 之后、return 之前，确保 hook 看到完整输出、注入 messages 的是截断后）。`LoopDeps` 加 `maxToolResultChars?`，useChat/headless 接线传 `settings.maxToolResultChars`。
- 单测：超阈截断保留头尾 + 标注、欠阈原样、边界等于阈值。

### 不做
token 估算抽象、countTokens、多后端（DeepSeek 无 tokenizer，char 兜底已够）。

---

## 验收

- 全量 `npm test` + typecheck + build 全绿。
- 纯逻辑（熔断器/char-guard/关键词检测）TDD 免冒烟；**碰 TUI（effort 状态行 + /effort 命令 + 预警色）→ 合 main 前用户真机 `npm start` 冒烟**：①`/effort high` 后状态行显示 `think:high`、reasoning_effort 生效；②`/think` 与 `/effort` 共存正常；③输入含 `ultrathink` 本轮自动升档；④上下文条接近阈值变黄/红。

## 既定流程

brainstorm（本 spec，已含盘点 + 用户 3 决策：范围含 char-guard / `/think` 与 `/effort` 共存 / 连 TUI 一起做）→ `writing-plans` 出 bite-sized TDD 计划 → `subagent-driven-development` 每任务 implementer + 独立审查双门、effort 系统（架构件）末加 opus 全分支终审 → 用户真机冒烟 → 合 main → push。
