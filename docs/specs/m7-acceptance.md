# M7① 验收报告：AskUserQuestion + QuestionDialog v2

**日期：** 2026-06-14
**版本：** v0.7.0-m7（本地 annotated）
**验收结论：** DONE ✅

---

## 范围

M7① = **让模型在歧义/需选择时弹结构化多选题问用户，而不是自作主张**。分两步落地：

- **AskUserQuestion 工具 + 桥**（早前会话，已合入 main）：工厂工具 `makeAskUserQuestionTool({ask})`、useChat `pendingQuestion/resolveQuestion` 桥、App 挂载、headless 不注册、结果编码为 JSON（键=question）。
- **QuestionDialog v2 对齐 CC 重写**（本批）：用户试用后反馈两条 → 完整对齐 CC 交互模型。

**推迟：** M7② `/rewind`、M7③ 可写 subagent + git worktree。

---

## QuestionDialog v2 改动

用户两项决策：①完整对齐 CC（含 tab 条 + 提交复核页）②**去掉 note 备注**完全对齐 CC。

参照 CC 源码 `~/Desktop/src/components/permissions/AskUserQuestionPermissionRequest/{QuestionNavigationBar,QuestionView,SubmitQuestionsView}.tsx`（编译混淆，只读交互语义）。

- 顶部 **tab 导航条** `← [H1][H2][✓提交] →`，active 高亮、已答标 `✓`。
- `qi` 0..N（==N 为提交复核页）；每题草稿 `draftsRef[{picks:Set, freeText}]`，**tab 间切换保留选择**。
- `Tab`/`→` 下一题、`Shift+Tab`/`←` 上一题，**可回上一题重选、覆盖**（`goTo` 回题时光标恢复到首个已选项）。
- **单选**：数字/Enter 选中即进下一题。
- **多选**：空格勾选 + 动作行「下一步/提交」（末题=「提交」，否则「下一步」），**移到动作行 Enter 才确认本题，选项行 Enter 不提交**。
- **提交复核页**：列全部答案 + ↑↓ 在「提交答案/取消」间选，取消 = `onDone(null)`。
- `hideSubmitTab`（单个单选题）：省略复核页、选完即结束。
- `Esc` 取消；preview 并排（width 42）；**全程无 note**。

**契约零改动**：`onDone(Answer[]|null)`、useChat `pendingQuestion/resolveQuestion`、App 挂载、headless 不注册——spec 审确认 5 个 forbidden 文件未碰。

`src/tools/askUserQuestion.ts`：`Answer` 去 `note`；`formatAnswers` 去 note 分支（`other` 键取 `freeText`）。

---

## 提交清单

```
890f23f merge: QuestionDialog v2 对齐 CC 重写（M7①）
37f5f11 feat(M7①): QuestionDialog v2 对齐 CC 重写（tab 导航/回改/多选确认按钮/提交复核页/去 note）
```

（AskUserQuestion 工具/桥早前会话 `475e0d9..a7e151d` 已合入。）

---

## 执行流程

`superpowers:writing-plans`（计划 `docs/plans/2026-06-14-deepcode-questiondialog-v2.md`）→ `superpowers:subagent-driven-development`：implementer + **spec 合规审** + **质量审** 双门，独立 feature 分支 `qdialog-v2` → `finishing-a-development-branch` 合回 main。

- 质量审：ref-safety 全程到位、`buildAnswers`/`chooseSingle`/`goTo`/`advance` 边界正确，**Approved**（仅 4 个 Minor cosmetic，已清理未用 `UP` 常量）。

---

## 测试与冒烟

- 组件测试 `test/tui.questionDialog.test.tsx`：11 用例（渲染/单选数字/单选 Enter/多题复核/回改覆盖/多选动作行/选项行不提交/其他自由输入/复核取消/Esc/preview）全绿。
- 工具测试 `test/tools.askUserQuestion.test.ts`：4 用例全绿。
- 合入 main 后全量 **257 测试全绿**，typecheck/build 干净。
- **pty 真终端冒烟（用户 2026-06-14 确认通过）**：tab 导航 / `←→`·`Shift+Tab` 回改保留 / 多选确认按钮 / 末题文案 / 复核页提交·取消 / 其他自由输入 / preview / 无 note。全部默认即对。

---

## 带入

| 事项 | 说明 |
|------|------|
| M7② `/rewind` | Edit/Write 前 before-image 文件备份回退（非影子 git，CC 同款） |
| M7③ 可写 subagent + worktree | 可写子 agent 在独立 git worktree 执行，隔离主分支 |
