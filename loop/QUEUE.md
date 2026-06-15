# deepcode 自对齐 loop — review 队列（QUEUE）

loop 产出的、**待你处理**的分支。每条独立：喜欢 `git merge` 进 main、不喜欢 `git branch -D` 丢、想改就 checkout 改。设计见 `docs/specs/2026-06-15-deepcode-self-alignment-loop-design.md`。

**上限 5**：本表攒到 5 条 loop 自动停手长睡，等你清掉再继续。

处理完一条后：合了把 BACKLOG 对应 id 标 `merged`、删本表条目；丢了把 BACKLOG 标 `todo` 或 `blocked`。

---

## 待你处理（0/5）

_（空。第一批 5 个小命令 L-001~L-005 已于 2026-06-15 全部合入 main，313 测试全绿。loop 下一步转 L-040 子代理类型化 spec-first。）_

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
