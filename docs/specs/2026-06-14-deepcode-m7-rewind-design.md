# /rewind 设计（M7②）

> M7 三独立子系统之 ②。①AskUserQuestion 已发（v0.7.0-m7）；③可写 subagent+worktree 压轴。

## 背景 / 动机

长任务跑偏后需要"后悔药"：回退到某轮之前的**文件状态**和/或**对话状态**重新来。CC 的 `/rewind` 实读确认其机制 = **Edit/Write 前的 before-image 文件备份（checkpoints，按 message 锚点索引）+ 还原 + 截断对话**，**非影子 git**（Bash 改动不还原，CC 同样局限）。deepcode 照此做，独立小-中件，不绑 worktree。

## 目标

- `/rewind` 列出**还原点**（每个 user 轮次），选中后选**三模式之一**：**仅对话 / 仅代码 / 两者**（对齐 CC）。
- **仅代码**：把被 Edit/Write 改过的文件还原到该轮开始时的内容；该轮起被 Write **新建**的文件**删除**（对齐 CC 语义）。
- **仅对话**：截断对话历史到该轮之前（你发那条消息之前的状态）。
- **两者**：同时做。
- before-image **落盘持久化**，resume 后 /rewind 仍可用。
- 上限 **100 快照/会话**，超出 FIFO 淘汰最旧。

## 非目标（P1，对齐 CC 局限）

- **Bash 改动不快照、不还原**（文档说明；CC 同样局限）。
- 非影子 git、不做整树快照。
- 外部进程并发改同一文件：还原以 before-image 为准直接覆盖。
- 不做"重放/redo"（只回退，不前进）。

## 架构总览

### 还原点与轮号（稳定 turnId）

- **还原点 = user 轮次**，锚点 `turnId` = **本会话内 user 消息的单调序号**（1-based，从不回退）。
- **关键：turnId 跨 compact / resume 稳定**。compact 会清空内存 `messages`，但 turnId 是计数器、不随之重置；落盘时 `turnId` = 会话文件里 user `msg` 记录的累计序号（数记录，不数内存数组），故 `loadSession` 可在重放时为每条 user 消息**重算出同一 turnId**（compact 清空内存数组不影响记录计数）。
- `useChat` 每次 `send(line)`（非斜杠命令的真实提问）把 `userTurn` +1 得到新 turnId，并告诉 Checkpointer 作为"当前轮"。Checkpointer 的 before-image **也以 turnId 为键** → 与还原点列表、截断标记三者锚点一致。
- **compact 与 rewind 的交互**：compact 后内存只剩摘要+其后消息，故 `rewindList()` 只列得出 **compact 边界之后**的 user 轮（更早的消息已不在内存）——即**不能 rewind 到 compact 之前**（可接受局限，文档说明）。但 turnId 仍单调，故 checkpoints / 截断标记不会因 compact 错位。

### before-image 捕获（懒，当轮首次修改）

- `ToolContext` 加可选钩子 `recordBeforeImage?(absPath: string): void`。
- `Edit`/`Write` 在 `fs.writeFileSync` **之前**调一次 `ctx.recordBeforeImage?.(p)`。
- Checkpointer.`capture(absPath, turn)`：若 `(turn, absPath)` 本轮已存过 → 跳过（去重，保证存的是**本轮开始**时的内容）；否则：
  - 文件存在 → 存其当前 bytes 为 blob，index 记 `{turn, path, kind:'content', blob}`。
  - 文件不存在（Write 新建）→ index 记 `{turn, path, kind:'absent'}`（墓碑）。
- **子代理 / headless 不注入** `recordBeforeImage`（不快照；rewind 是交互式功能）。

### 还原语义（"最早 ≥ T"规则）

还原到"第 T 轮之前"= 文件系统恢复到你发第 T 条消息前一刻：

- 对每个出现过快照的 path：取其**轮号 ≥ T 的最早一条** before-image（= 该文件在第 T 轮开始时的内容）。
  - `kind:'content'` → 把 blob 写回该 path。
  - `kind:'absent'` → 删除该 path（若存在）。
- 轮号 ≥ T 无快照的 path = 第 T 轮起没动过 → 不碰。
- 还原后**清除被还原 path 的 `ctx.fileState` 记录** → 强制模型下次编辑前重新 Read（防 read-before-edit 闸门把"已还原"误判为"被外部改动"）。

### 对话截断

- **仅对话/两者**：把内存 `messages` 截断到 turnId==T 的 user 消息**之前**（drop 从该 user 消息起的所有消息），transcript 同步截断；session JSONL 追加 `{t:'rewind', toTurnId:T}`。
- `loadSession` 处理 `{t:'rewind', toTurnId}`：重放时已为每条 user 消息算出稳定 turnId（见上），命中 turnId==T 即丢弃其及之后的 msg（usage/fs 不动）。多条 rewind 标记按序生效。
- **截断后 `userTurn` 计数器不回退**（保持单调最大值）：下次 `send` 取**新的更大 turnId**，绝不复用被截掉的轮号——否则会和那些轮号下已存的 checkpoints 撞键。被截掉的 turnId 就此作废。落盘文件 append-only，原 msg 记录物理仍在，`loadSession` 按 user msg 记录累计序号重算 turnId 时同样得到这些作废号，故重放出的新消息 turnId 与运行时一致。

## 模块与文件

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/checkpoint.ts` | 建 | `Checkpointer`：capture/restoreFiles/listPoints + 落盘 blob/index + cap 100 FIFO；纯逻辑可单测（fs 注入或临时目录） |
| `src/tools/types.ts` | 改 | `ToolContext` 加 `recordBeforeImage?(absPath): void` |
| `src/tools/edit.ts` | 改 | 写盘前 `ctx.recordBeforeImage?.(p)` |
| `src/tools/write.ts` | 改 | 写盘前 `ctx.recordBeforeImage?.(p)` |
| `src/session.ts` | 改 | `loadSession` 处理 `{t:'rewind', toTurn}` 截断；`SessionHandle` 加 `appendRewind(toTurn)` |
| `src/tui/useChat.ts` | 改 | `userTurn` 计数 + 注入 `recordBeforeImage` + `pendingRewind` 状态 + `rewindList()` + `rewind(toTurn, mode)`；建 Checkpointer（按会话名）；resume 时重载 index |
| `src/tui/App.tsx` | 改 | rewind 两步 `SelectList` 分支（镜像 resumeMode）：选还原点 → 选模式 |
| `src/commands.ts` | 改 | `/rewind` 进帮助文案 |

## 持久化布局

```
~/.deepcode/checkpoints/<会话文件名去扩展>/
  index.jsonl          # 每行 {turn, path, kind:'content'|'absent', blob?:string}
  blobs/<sha1>.blob    # content 快照原始 bytes（按内容 hash 去重）
```

- Checkpointer 启动时按会话名加载 `index.jsonl`（resume 后 /rewind 可用）。
- cap 100：index 条目数超 100 时，FIFO 淘汰最旧条目（并删其独占 blob）；被淘汰条目所属还原点在列表中标"（部分快照已过期）"。

## 三模式 UX

1. `/rewind` → `useChat` 置 `pendingRewind`，App 渲染**第一个 SelectList**：还原点列表（每 user 轮一项，预览 = 该轮 user 提问截断 60 字 + "· N 文件改动"，**新→旧**）。Esc 取消。
2. 选中第 k 项（对应轮号 T）→ App 渲染**第二个 SelectList**：`仅对话 / 仅代码 / 两者`。Esc 回退/取消。
3. 选定模式 → `core.rewind(T, mode)` 执行；transcript 追加一条 notice「已回退到第 T 轮之前（模式）」。

App 复用现有 `SelectList`（与 `/resume` 同款），新增 `rewindStep: 'point'|'mode'|null` 局部状态。

## 错误处理 / 边界

- **轮号 ≥ T 无任何快照** → 仅代码模式无文件可还原，仅截断（或提示"无文件改动"）。
- **blob 读取失败 / 被淘汰** → 跳过该文件并在 notice 里列出"未能还原：<path>"，不中断其余还原。
- **还原写盘失败**（权限/只读）→ 记入 notice，继续其余。
- **restore 后 fileState 清除**（见上），保证 read-before-edit 一致。
- **headless / 子代理**：不注入 `recordBeforeImage`，无 checkpoints，`/rewind` 仅交互 TUI 可用。
- **空会话 / 无还原点**：`/rewind` 提示"暂无可回退的轮次"。

## 测试策略

- `checkpoint.ts`（临时目录）：capture 当轮去重、跨轮多快照、`restoreFiles(T)` 的"最早≥T"选取正确、墓碑删除新建文件、content 写回、cap 100 FIFO 淘汰、blob 按 hash 去重、resume 重载 index。
- `session.ts`：`loadSession` 处理单条/多条 `{t:'rewind', toTurn}` 截断到正确 user 轮边界（usage/fs 不受影响）。
- `edit.ts`/`write.ts`：写盘前调用 `recordBeforeImage`（mock ctx 断言被调 + 时机在写之前）；无钩子时（子代理）不崩。
- `useChat`：`userTurn` 计数（跨 resume 续）、`rewind(T, mode)` 三模式各自效果（mock Checkpointer + 断言 messages 截断/文件还原调用）。
- `App`：rewind 两步 SelectList 流程（组件测试：/rewind→点列表→模式列表→执行；Esc 各步取消）。
- 回归：现有 257 测试保持绿；Edit/Write 既有行为不变（钩子可选）。

## 验收标准

- `/rewind` 列还原点；选轮 + 选三模式之一可执行。
- 仅代码：被改文件还原到该轮初始内容、该轮起新建文件被删、未涉及文件不动、fileState 清除。
- 仅对话：messages/transcript 截断到该轮前，session 落 rewind 标记，resume 后仍截断。
- 两者：同时生效。
- before-image 落盘，resume 后 /rewind 仍可用；cap 100 FIFO。
- Bash 改动不还原（文档明示）。Esc 各步可取消。
- 全量单测绿 + 现有行为不回归。
