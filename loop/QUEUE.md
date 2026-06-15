# deepcode 自对齐 loop — review 队列（QUEUE）

loop 产出的、**待你处理**的分支。每条独立：喜欢 `git merge` 进 main、不喜欢 `git branch -D` 丢、想改就 checkout 改。设计见 `docs/specs/2026-06-15-deepcode-self-alignment-loop-design.md`。

**上限 5**：本表攒到 5 条 loop 自动停手长睡，等你清掉再继续。

处理完一条后：合了把 BACKLOG 对应 id 标 `merged`、删本表条目；丢了把 BACKLOG 标 `todo` 或 `blocked`。

---

## 待你处理（2/5）

### auto/slash-export — `/export` 导出对话到 markdown · S · await-review:smoke
- **gap：** L-001
- **做了什么：** 新增 `/export [路径]` 斜杠命令，把当前对话导出成 markdown 文件（默认 `deepcode-export-<会话名>.md`）。纯函数 `src/export.ts` 渲染、useChat 接线、suggest/help 同步。
- **怎么验：**
  - `git checkout auto/slash-export && npm test && npm run typecheck`（应 285 绿 / 干净）
  - 真机冒烟（碰 TUI，但面很小）：`npm start` → 随便聊两句 → 打 `/` 看补全菜单里**有 `/export`** → 回车跑 `/export` → 看到 `已导出到 <绝对路径>` → `cat` 那个 md 文件确认内容可读（用户/助手分节）→ 再试 `/export out.md` 导到指定路径。
- **合：** `git checkout main && git merge --no-ff auto/slash-export`（合后把 BACKLOG 的 L-001 标 `merged`、删本条）
- **丢：** `git branch -D auto/slash-export`（再把 BACKLOG 的 L-001 标回 `todo`）

### auto/slash-copy — `/copy` 复制上条回复到剪贴板 · S · await-review:smoke
- **gap：** L-002
- **做了什么：** 新增 `/copy`，把最后一条助手文本回复复制到系统剪贴板（pbcopy）。纯函数 `src/clipboard.ts` 提取 + spawn pbcopy，useChat 接线、suggest/help 同步。
- **怎么验：**
  - `git checkout auto/slash-copy && npm test && npm run typecheck`（应 286 绿 / 干净）
  - 真机冒烟：`npm start` → 让模型回一段话 → 打 `/` 看菜单里**有 `/copy`** → 跑 `/copy` → 看到 `已复制上条回复到剪贴板（N 字）` → 在别处 `Cmd+V` 粘贴确认内容是那段回复 → 刚开会话时跑 `/copy` 应提示 `没有可复制的回复`。
- **合：** `git checkout main && git merge --no-ff auto/slash-copy`（合后 BACKLOG L-002 标 `merged`、删本条）
- **丢：** `git branch -D auto/slash-copy`（BACKLOG L-002 标回 `todo`）

<!--
条目模板：

### auto/<slug> — <标题>  ·  <S/M>  ·  await-review[:smoke]
- **gap：** L-0NN
- **做了什么：** 一句话
- **怎么验：**
  - `git checkout auto/<slug> && npm test && npm run typecheck`
  - （碰 TUI 才有）真机冒烟：`npm start` → <具体步骤>
- **合：** `git checkout main && git merge --no-ff auto/<slug>`
- **丢：** `git branch -D auto/<slug>`
-->
