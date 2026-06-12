# M3 验收报告（不丢活）

日期：2026-06-12。范围：会话 JSONL 持久化、`--continue`/`/resume`、`/cost`、`finish_reason:length` 自动续写、状态行。tag：`v0.3.0-m3`。

## 背景：中断与核实

M3 执行曾于 2026-06-11 深夜因长会话工具输出串扰中断，叙述与落盘不一致。2026-06-12 新会话逐项核实：Task 1-3（pricing `541b6b2`、session `5ff3ee3`、loop length 续写 `30f281e`）真实落盘且测试通过；Task 4-5 确认未做，按 subagent 双审流程（实现 → 规格审查 → 质量审查）补齐：

- Task 4 REPL 接入：`83ee253`，规格审查与计划逐字节一致
- 质量审查修复一轮：`36ddaa3`（悬空 tool_calls 净化、落盘失败降级仅内存、resume 钳制 permMode 禁止静默恢复 yolo、/model //think //accept 切换持久化 meta、restoreSession 去重、/resume 编号校验）
- 复审回归修复：`1ce531a`（cwd 是会话身份、只取首条 meta——修复模型 `cd` 漂移后切换设置导致会话从 `--continue`/`/resume` 消失；/resume 小数编号崩溃；部分应答 tool_calls 净化排序测试）
- Task 5 `--continue`：`0a50f7b`，与计划逐字节一致

测试基线 78 → 84（17 文件），typecheck 干净。

## 杀进程恢复验收（真机，deepseek-v4-flash，走 127.0.0.1:8118 代理）

**第一程**（新会话，问 src/ 下的 .ts 文件）：

```
[入 1441（缓存命中 0）出 47 | 累计 入 1441 出 47 $0.0002]
`src/` 下共有 **17 个 .ts 文件**：（正确列出全部 17 个）
[入 1593（缓存命中 1408）出 239 | 累计 入 3034 出 286 $0.0003]
[flash $0.0003] › 本会话：输入 3034（缓存命中 1408）出 286 | 估算花费 $0.000312
```

**第二程**（杀进程后 `--continue`，问"刚才那些文件里哪个最长？"）：

```
已恢复会话（1 轮对话），继续写入 ~/.deepcode/sessions/2026-06-12T02-47-28-841Z-lcik.jsonl
（模型直接理解"刚才那些文件"，wc -l 后回答 src/repl.ts 208 行最长——正确）
[入 3824（缓存命中 2944）出 242 | 累计 入 12669 出 1714 $0.0009]
```

**第三程**（再次 `--continue`，只查 /cost）：

```
已恢复会话（2 轮对话），继续写入 同一文件
[flash $0.0009] › 本会话：输入 12669（缓存命中 9728）出 1714 | 估算花费 $0.000919
```

判定：✅ 上下文连续（无需重新列举即知所指）；✅ 花费跨进程累加（$0.000312 → $0.000919）；✅ 状态行恢复后即显示累计花费；✅ 续写同一 JSONL 文件。

## 会话文件结构

```
{"t":"meta","cwd":"/Users/silas/loop/deepcode","model":"deepseek-v4-flash","thinking":false,"permMode":"default","createdAt":1781232448841}
{"t":"msg","m":{"role":"system","content":"你是 deepcode，…"}}
{"t":"msg","m":{"role":"user","content":"这个项目的 src/ 下有哪些 .ts 文件？"}}
```

首行 meta 含 cwd/model/thinking/permMode ✓；后续 msg/usage/fs 逐条追加 ✓。

## 验收期间发现并已修（质量审查产出）

- **会话可被悬空 tool_calls 永久污染**：权限路径或事件循环中途抛错时，finally 会把"assistant 带 tool_calls 但无 tool 结果"的尾巴落盘，此后每次 resume 都 400。修复：`loadSession` 加载时净化，为缺失的 tool_call_id 补合成 `{role:'tool', content:'（中断，无结果）'}`，同时覆盖尾部崩溃与 JSONL 截断两种来源
- **落盘失败炸毁 REPL**：磁盘满/目录被删时 appendFileSync 直接抛出，杀掉持有完整内存上下文的进程。修复：句柄级 dead 标记，首次失败 stderr 警告一次后降级为仅内存
- **resume 静默恢复 yolo**：恢复的 permMode 钳制为 default/acceptEdits，yolo 必须每次启动显式 `--yolo`
- **设置切换不持久化**：/model //think //accept 现在追加 meta 行（last-meta-wins），resume 不再回到旧设置
- **cwd 漂移**：meta 重复追加引入的回归——cwd 改为只取首条 meta（会话身份不可变）

## 带入 M4 的权衡

- `appendFileState` 每轮全量快照、`listSessions` 每次全量解析目录下所有 JSONL：长会话/多会话场景 O(turns×files) 增长，M4 长会话时代会有感
- `messages.slice(lenBefore)` 持久化契约假设 runLoop 只追加；M4 `/compact` 会改写历史，需要先设计 `{t:'compact'}` 重置标记或文件轮转
- session 句柄是 startRepl 闭包单例；M4 subagent 共享/分叉消息数组前需明确句柄归属，否则记录交错进同一文件
- `newSession` 启动时的 mkdir/writeFileSync 仍是裸调用（`~/.deepcode` 不可写则启动即崩，dead 标记只保护 append）
- `--continue` 在无历史会话时静默新建（UX 小问题，可加一行提示）
- fileState mtime 失效率：本轮验收三程之间无文件改动，未观察到失效路径触发；留待真实使用观察
