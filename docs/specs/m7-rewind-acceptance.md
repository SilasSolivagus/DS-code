# M7② 验收报告：`/rewind` —— CC 式 before-image 回退

**日期：** 2026-06-15
**版本：** v0.7.1-m7（本地 annotated）
**验收结论：** DONE ✅

---

## 范围

M7 = 三独立子系统按小→大都做：①AskUserQuestion（`v0.7.0-m7` 已收）②**`/rewind`（本批）**③可写 subagent + git worktree（待）。

`/rewind` = CC 式回退：把对话和/或文件还原到某个历史「用户轮」之前的状态。**机制是 before-image 文件落盘备份（非影子 git）——与 CC 自身一致**。

设计 `docs/specs/2026-06-14-deepcode-m7-rewind-design.md`，计划 `docs/plans/2026-06-14-deepcode-m7-rewind.md`（6 任务）。

---

## 改动

新文件：

| 文件 | 职责 |
|---|---|
| `src/checkpoint.ts` | `Checkpointer`：按 `turnId` 去重落盘 before-image（blob/absent 墓碑）、`restoreFiles`（取「最早 ≥T」快照）、`fileCountAt`、cap 100 FIFO；`index.jsonl` + 内容寻址 blob；resume 重载 |

改动：

- `src/tools/types.ts` — `ToolContext.recordBeforeImage?` 钩子（写盘前捕获；headless/子代理不注入）。
- `src/tools/edit.ts`、`src/tools/write.ts` — 写盘前调钩子捕获 before-image。
- `src/session.ts` — `turnId` 持久化 `{t:'msg',m,turn}` + `appendRewind` 写 `{t:'rewind',toTurnId}` 截断标记；`loadSession` 返回 `messageTurnIds`/`maxTurnId`。
- `src/tui/useChat.ts` — 接 `Checkpointer` + **稳定单调 `turnId`** 锚点（内存 `WeakMap<msgObj,turnId>`，跨 compact 靠 rebuildMessages 用 slice 保引用存活；`nextTurnId=max+1` 不复用作废号）+ `rewindList()` / `rewind(toTurnId,mode)`。
- `src/tui/App.tsx` — `/rewind` 两步 `SelectList`（选还原点 → 选三模式，镜像 `resumeMode`）+ `HELP_TEXT`。

**契约零改动**：loop / permissions / headless / 只读工具不动。

### 三模式

| 模式 | 行为 |
|---|---|
| 仅代码 `code` | `restoreFiles` 还原文件（含新建文件删除）+ 清 `fileState` 防 read-before-edit 误判 |
| 仅对话 `conversation` | 截断 messages + transcript + 落 `{t:'rewind'}` 标记 |
| 两者 `both` | 先截对话再发代码还原通知（防被 transcript.slice 切掉） |

---

## 提交清单

```
8c2c9cf merge: /rewind（M7②）—— CC 式 before-image 回退 + 三模式 + 稳定 turnId
49928ce docs(M7②): rewind 设计补稳定 turnId 机制
885afdf polish(M7②): rewind 还原点预览去掉残留换行
8ee658e feat(M7②): App /rewind 两步 SelectList（选还原点→选三模式）+ HELP_TEXT
cdad0cc feat(M7②): useChat 接 Checkpointer + turnId 锚点 + rewindList/rewind（三模式）
ac8f210 feat(M7②): ToolContext.recordBeforeImage 钩子 + Edit/Write 写盘前捕获
077abed feat(M7②): session turnId 持久化（{t:msg,turn}）+ appendRewind 截断 + loadSession 返回 messageTurnIds/maxTurnId
950308d feat(M7②): Checkpointer 落盘 before-image 存储（capture/restoreFiles/fileCountAt + cap FIFO)
bc2eb30 docs(M7②): /rewind 实现计划（6 任务，bite-sized TDD）
1201de7 docs(M7②): /rewind 设计 spec（CC 式 before-image 文件备份 + 三模式 + 稳定 turnId 锚点）
```

---

## 执行流程

`superpowers:brainstorming`（用户定：三模式全给 / 还原点=user 轮 / 新建文件删除 / 落盘）→ `superpowers:writing-plans` → `superpowers:subagent-driven-development`：每任务 implementer + spec 审 + 质量审双门，**末加 opus 全量终审** → `finishing-a-development-branch` 合回 main。

审查抓修 3 处真问题：

1. both 模式代码还原通知被 `transcript.slice` 切掉 → 改为先截对话再发通知。
2. rewind 到 compact 后已不在内存的 turnId 谎报成功 → 加 `mi<0` warn。
3. preview 残留换行 → split `\n\n` + 折行转空格。

---

## 测试与冒烟

- 合入 main 后全量 **277 测试全绿**，typecheck/build 干净。
- **pty 真终端冒烟（用户 2026-06-15 确认通过）**：让模型跨多轮改文件 → `/rewind` 列还原点 → 三模式各试（仅代码=文件回滚+新建文件删 / 仅对话=截断 / 两者）/ 每步 Esc 取消 / `/exit` 后 `--continue` 回来 `/rewind` **仍列还原点**（落盘验证）。

---

## 已知接受风险（不阻塞）

| 风险 | 说明 |
|---|---|
| before-image cap 100 FIFO | 超长会话最早还原点被挤出，可接受 |
| compact 后 turnId 出内存 | rewind 到已压缩轮会 warn 拒绝（非静默失败） |

---

## 带入

M7 只剩 **③可写 subagent + git worktree**（压轴大件，待 brainstorm）。
