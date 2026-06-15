# deepcode 自对齐 loop — review 队列（QUEUE）

loop 产出的、**待你处理**的分支。每条独立：喜欢 `git merge` 进 main、不喜欢 `git branch -D` 丢、想改就 checkout 改。设计见 `docs/specs/2026-06-15-deepcode-self-alignment-loop-design.md`。

**上限 5**：本表攒到 5 条 loop 自动停手长睡，等你清掉再继续。

处理完一条后：合了把 BACKLOG 对应 id 标 `merged`、删本表条目；丢了把 BACKLOG 标 `todo` 或 `blocked`。

---

## 待你处理（4/5）

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

### auto/slash-stats — `/stats` 本会话统计 · S · await-review:smoke
- **gap：** L-003
- **做了什么：** 新增 `/stats`，打印本会话统计：用户/助手轮数、请求数、工具调用（总数+按名分组）、token（输入/缓存命中/输出）、缓存命中率、估算花费。纯函数 `src/stats.ts`，useChat 接线、suggest/help 同步。
- **怎么验：**
  - `git checkout auto/slash-stats && npm test && npm run typecheck`（应 287 绿 / 干净）
  - 真机冒烟：`npm start` → 聊两句并触发几次工具（如让它读文件/跑命令）→ 打 `/` 看菜单里**有 `/stats`** → 跑 `/stats` → 核对输出的轮数/工具计数/token/花费看着合理（可与 `/cost`、`/context` 对照一致）。
- **合：** `git checkout main && git merge --no-ff auto/slash-stats`（合后 BACKLOG L-003 标 `merged`、删本条）
- **丢：** `git branch -D auto/slash-stats`（BACKLOG L-003 标回 `todo`）

### auto/slash-memory — `/memory` 查看生效的记忆文件 · S · await-review:smoke
- **gap：** L-004
- **做了什么：** 新增 `/memory`（简单版），列出当前生效的记忆文件（复用系统提示词同款 `findMemoryFiles`：项目逐层 DEEPCODE.md/CLAUDE.md/AGENTS.md + 全局 `~/.deepcode/DEEPCODE.md`），空列表给提示，附 /init + 编辑提示。**未做 $EDITOR 唤起**（留作增强）。纯函数 `src/memory.ts`，useChat 接线、suggest/help 同步。
- **怎么验：**
  - `git checkout auto/slash-memory && npm test && npm run typecheck`（应 283 绿 / 干净）
  - 真机冒烟：`npm start` → 打 `/` 看菜单里**有 `/memory`** → 跑 `/memory` → 核对列出的文件路径就是本项目实际生效的记忆文件（有 DEEPCODE.md 就该列出；全局没有应提示可创建）。
- **合：** `git checkout main && git merge --no-ff auto/slash-memory`（合后 BACKLOG L-004 标 `merged`、删本条）
- **丢：** `git branch -D auto/slash-memory`（BACKLOG L-004 标回 `todo`）

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
