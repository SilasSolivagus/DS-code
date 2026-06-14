# M8 P1 验收报告：全屏可滚 TUI（全屏骨架 + 键盘滚动）

**日期：** 2026-06-14
**版本：** v0.7.0-m7（本地 annotated；M8 P1 随本 tag 一并收）
**验收结论：** DONE ✅

---

## 范围

M8 = **让 deepcode 自带滚动、不依赖终端原生回滚**（修 Ghostty 原生回滚失效看不了历史）。分三期：

- **P1（本批）**：alt-screen 全屏接管 + 键盘滚动（PageUp/PageDown/Ctrl+G）+ auto-follow + 逃生开关。
- **推迟**：P2 鼠标/触控板滚轮；P3 应用内选中复制。

设计 `docs/specs/2026-06-14-deepcode-m8-fullscreen-scroll-p1-design.md`（方案 A1 = 基于 stock ink 5 不 fork）。

---

## 改动

新文件：

| 文件 | 职责 |
|---|---|
| `src/tui/scroll.ts` | 纯滚动数学：clamp/page/applyFollow/nextStuck/scrollInfo（全单测） |
| `src/tui/altscreen.ts` | 进/出 alt-screen 转义 + 全路径还原（exit/SIGINT/SIGTERM/uncaught + 幂等 leave） |
| `src/tui/renderItem.tsx` | 从 Transcript 抽出 renderItem/isDone（byte-identical，内联行为零变） |
| `src/tui/ScrollView.tsx` | `Box overflowY:'hidden'` 真裁剪 + `marginTop=-offset` + measureElement 量 viewportH/totalH 上报 |
| `src/tui/FullscreenApp.tsx` | 全屏孪生 App：ScrollView + 滚动键位 + alt-screen 生命周期 + **绝对定位** IME 停泊 |

改动：`src/tui/components/Transcript.tsx`（import 共享 renderItem）、`src/tui/index.tsx`（逃生开关路由）、`src/config.ts`（`Settings.inline`）、`src/index.ts`（`--inline`/`DEEPCODE_INLINE` 解析）。

**`src/tui/useChat.ts`、`src/tui/App.tsx` 零改动**（内联模式完全保留；终审确认 diff 不含）。

- 键位：`PageUp`/`PageDown` 翻页、`Ctrl+G` 跳底恢复跟随；auto-follow（stuckToBottom）贴底跟随、向上滚冻结、滚回底重新跟随。
- 位置提示行：`▲ 上有更多 · ▼ 下有更多 · 行 N–M/T · 跟随`。
- 逃生开关：`--inline` / `DEEPCODE_INLINE=1` / settings `inline:true` / 非 TTY → 内联 App。
- 终端安全：mount/unmount/exit/SIGINT/SIGTERM/uncaughtException 全路径还原主屏 + 显光标（幂等 leave）。
- 全屏 IME 停泊：绝对定位 `\x1b[{row};{col}H`（col 复用 `parkCol`）+ 写帧前移回底行（`\x1b[{rows};1H`）协同 ink log-update；`linesBelowCaret = 4 + memory + tools`（比内联 App 的 5 少 1，因全屏无底框）；`DEEPCODE_NO_CURSOR_PARK=1` 可禁用隔离。

---

## 提交清单

```
d6bc3cc merge: M8 P1 全屏可滚 TUI（alt-screen + 键盘滚动 + 逃生开关）
6275c00 feat(M8 P1): 逃生开关路由（--inline / DEEPCODE_INLINE / settings.inline → 内联 App，否则全屏）
d9ce211 feat(M8 P1): FullscreenApp 全屏变体（ScrollView + 键盘滚动 + alt-screen + 绝对定位 IME 停泊）
2b069f4 feat(M8 P1): ScrollView 裁剪视口 + measureElement 量高上报
4af2721 refactor(M8 P1): 抽出 renderItem/isDone 供 Transcript 与 ScrollView 共用（内联行为零变）
103a37b feat(M8 P1): altscreen.ts 进/出全屏 + 全路径还原（信号/exit/异常 + 幂等 leave）
7ecc07b feat(M8 P1): scroll.ts 纯滚动数学（clamp/page/applyFollow/nextStuck/scrollInfo）
```

---

## 执行流程

`superpowers:writing-plans`（计划 `docs/plans/2026-06-14-deepcode-m8-fullscreen-scroll-p1.md`，7 任务）→ `superpowers:subagent-driven-development`：每任务 implementer + spec 审 + 质量审双门，独立 feature 分支 `m8-p1`，**末加 opus 全量终审** → `finishing-a-development-branch` 合回 main。

- 终审（opus）逐条核对：`createChatCore`/`useChat`/`core` 方法/各组件 props **wiring 签名零失配**；退出还原四路径（unmount/exit/signal/uncaught）全安全（含 installCleanup 与 signal-exit 的交互）；`onMeasure` 仅变更时 setState 无死循环；renderItem 抽取 byte-identical。**Ready to merge**，无 Critical/Important。

---

## 测试与冒烟

- 新增单测 14：scroll(5) / altscreen(3) / renderItem(2) / scrollview(2) / fullscreen(2)。
- 现有 `test/tui.transcript.test.tsx` 全绿 = 内联行为零变回归证明。
- 合入 main 后全量 **257 测试全绿**，typecheck/build 干净。
- **pty 真终端冒烟（用户 2026-06-14 确认通过，全部默认即对、无需调参）**：默认全屏进出还原 / PageUp·PageDown 滚历史 / Ctrl+G 贴底 / auto-follow 不被新输出拽下 / 位置提示行 / resize / `kill -INT`·`-TERM` 还原 / **中文 IME 组字在框内**（`linesBelowCaret=4` 正确，无需 ±1 调整）/ `--inline` 退回内联。

---

## 已知接受风险（P1，不阻塞）

| 风险 | 说明 |
|---|---|
| IME 停泊与 ink log-update 协同 | 绝对 CUP + 写帧前移回底行机制；冒烟已验证；`DEEPCODE_NO_CURSOR_PARK=1` 兜底 |
| measureElement 一帧延迟 | auto-follow 偶发一帧未贴底，可接受 |
| 长会话全渲染无虚拟化 | P1 可接受，超长留 P-later |

---

## 带入 M8 后续

| 事项 | 说明 |
|------|------|
| P2 鼠标/触控板滚轮 | SGR 鼠标序列捕获（`render` 自定义 stdin），滚轮翻页 |
| P3 应用内选中复制 | 选区 + `pbcopy`（已在）；虚拟化裁剪一并考虑 |
