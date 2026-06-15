# L-041 设计：后台任务 + 完成通知（对齐 CC）

**日期：** 2026-06-15
**状态：** 待批（CC 源码实读对齐）
**来源：** 编排层差距分析（`loop/BACKLOG.md` L-041 / G6）+ CC 源码实读 `/Users/silas/Desktop/src`

---

## 目标

让 deepcode 的 Bash / Agent 工具能 `run_in_background`：**立即返回任务句柄、主循环继续干别的、任务在后台跑、完成时把结果作为 `<task-notification>` 注入下一回合自动唤醒模型**。这是从「单线程顺序委派」跨到「边干别的边等长任务」的分水岭（dev server / 长测试 / 并行长调查）。1:1 对齐 CC 的 Task 模型 + 通知机制最小忠实子集。

依赖 L-040（已合）：后台 Agent 携带 `subagent_type`。本件是 L-043（steering）、L-045（多 agent 工作流）的地基。

## 非目标（砍掉 CC 的）

- remote_agent / workflow / dream / monitor 任务类型（云端/实验/feature-gated）。
- TaskCreate / TaskUpdate（CC 的 todo 清单系统，与后台进程任务无关）。
- size watchdog（5GB 上限）/ stall watchdog（交互提示探测）/ UI 面板生命周期（retain/evictAfter）/ SDK 事件流。
- 并发硬上限（CC 也不限；deepcode 沿用，靠用户自律 + Stop）。

---

## 架构

### 1. Task 模型 + 注册表（新文件 `src/tasks.ts`）

```ts
export type TaskType = 'local_bash' | 'local_agent'
export type TaskStatus = 'running' | 'completed' | 'failed' | 'killed'

export interface BackgroundTask {
  id: string                 // 'b'+8随机(bash) / 'a'+8随机(agent)，对齐 CC 前缀
  type: TaskType
  status: TaskStatus
  description: string        // 人类可读（命令 / 子代理任务一句话）
  toolUseId?: string         // 触发的 tool_use id（通知回连）
  startTime: number
  endTime?: number
  outputFile: string         // 落盘路径（~/.deepcode/tasks/<id>.log，对齐 CC 落盘）
  outputOffset: number       // 增量读游标（字节）
  notified: boolean          // 完成通知去重（核心）
  // bash 专有：command, child（ChildProcess 句柄，供 kill）
  // agent 专有：prompt, abortController, result?
}
```

- `TaskRegistry`（模块级单例，对齐 CC）：`Map<id, BackgroundTask>` + `register/get/list/update/remove`。
- `generateTaskId(type)`：前缀 + `crypto.randomBytes` 取 8 位 `[0-9a-z]`（对齐 CC）。
- `notified` 的 check-and-set 原子更新（去重灵魂）。
- **落盘而非内存缓冲**：对齐 CC，且「完成后还能全量取回」最省事。输出目录 `~/.deepcode/tasks/`，会话退出可清。

### 2. 完成通知队列（`src/tasks.ts`）

- 模块级 `pendingNotifications: TaskNotification[]` + `enqueueNotification(task)`（先 check-and-set `notified`，已通知则跳过）。
- `drainNotifications(): TaskNotification[]`：取出全部待发通知。
- `onNotification(cb)`：订阅（useChat 空闲唤醒用）。
- 通知形态（对齐 CC `<task-notification>` XML）：
  ```
  <task-notification>
  <task-id>a3f9...</task-id>
  <status>completed|failed|killed</status>
  <summary>命令退出码 0 / 子代理完成</summary>
  <result>...</result>            ← agent 专有：子代理最终文本
  <output-file>~/.deepcode/tasks/<id>.log</output-file>   ← bash：指示用 Read/TaskOutput 取全量
  </task-notification>
  ```

### 3. 控制流分叉（改 `src/loop.ts` execCall + 工具）

- Bash / Agent 工具 schema 加 `run_in_background?: boolean`。
- `execCall` / 工具 `call` 内：
  - **后台路径**（`run_in_background===true`）：启动任务（spawn 进程 / 脱钩 agent 子循环）→ `TaskRegistry.register` → **立即返回 tool_result**「后台任务已启动，id=xxx，输出写入 yyy。用 TaskOutput/TaskList/TaskStop 管理」→ **不 await 完成**。
  - **前台路径**（默认）：维持现有 `await tool.call()` 阻塞。
- 任务完成回调（在 runLoop 之外）：写完 outputFile → `TaskRegistry.update(status)` → `enqueueNotification`。

### 4. 通知注入进 runLoop（**最关键，改 `src/loop.ts`**）

runLoop 在**会回合边界**注入通知（对齐 CC「turn 结束、下次 API 调用前」）：

- 现状：模型本轮无工具调用 → `return 'done'`（loop.ts:138）。
- 改为：到该终止点时，先 `drainNotifications()`：
  - 有通知 → 把拼好的 `<task-notification>` 作为 **user 消息**追加进 `messages`，**继续循环**（再发一次 API，模型据此决策），不 return。
  - 无通知 → 照常 `return 'done'`。
- 防失控：通知注入也受 `maxTurns` 约束；user 输入优先于通知（见 §5）。

### 5. 空闲唤醒（改 `src/tui/useChat.ts`）

后台任务**在 runLoop 已结束、用户没打字时**完成 → 需把模型唤醒：

- useChat `onNotification` 订阅：通知到达且**当前 idle（busy=false）且无待处理用户输入**时，自动以「（系统）后台任务完成」触发一次 `send`（把通知作为输入跑一轮）。
- 优先级：用户正在输入 / busy 时不抢；用户输入永远优先（对齐 CC `next > later`）。
- headless：单发模式无空闲循环，后台任务在主任务结束前完成的通过 §4 注入；未完成的随进程退出清理（headless 不挂起等后台）。

### 6. Bash 后台化（改 `src/tools/bash.ts`）

- 现用 `execFile`（已异步）。后台时：`spawn` 命令、stdout/stderr 重定向写入 `task.outputFile`（fd 直连文件，对齐 CC file 模式）、保存 `child` 句柄、`child.once('exit', code => 完成回调)`。
- 前台路径不变。

### 7. Agent 后台化（改 `src/tools/agent.ts`）

- 现状：`await` 子代理 `runLoop` generator 到完成。后台时：`void (async()=>{ 跑完子循环 → 写 result 到 outputFile → 完成回调 })()` 脱钩，立即返回句柄。
- `abortController` 入 task，供 TaskStop abort。
- 复用 L-040 的类型化（后台 agent 也按 subagent_type 解析）。

### 8. 任务管理工具（新，对齐 CC 的 TaskOutput/Stop + List）

| 工具 | 入参 | 语义 |
|---|---|---|
| `TaskList` | 无 | 列所有后台任务：`id [status] description`（含 running/终态） |
| `TaskOutput` | `task_id`，`offset?` | 读任务输出：默认从 `outputOffset` 增量返回并推进游标；给 offset 则从该处；返回 `<status><output>`。读完终态任务置 `notified` |
| `TaskStop` | `task_id` | 停止：bash→`child.kill()`（SIGTERM/SIGKILL 进程树）；agent→`abortController.abort()`。置 `status:'killed'` + `notified:true` |

这三个工具注册进主会话工具集（headless 也可注册）；**子代理工具池不含**（L-040 全局 deny 之外，避免子代理管理任务，保持子代理纯执行）。

### 9. 并发 / 清理 / 取消

- 无硬并发上限（对齐 CC）。
- 清理：进程退出钩子（`process.on('exit'|'SIGINT'|'SIGTERM')）kill 所有 running 任务（复用既有 altscreen 的清理注册模式）；`~/.deepcode/tasks/` 旧日志可在启动时按龄清理。
- 取消：bash kill 进程树、agent abort signal；都置 `killed` + `notified`。

---

## 改动文件

| 文件 | 改动 |
|---|---|
| `src/tasks.ts`（新） | Task 模型 + `TaskRegistry` + 通知队列 + `generateTaskId` + 纯函数 `formatNotification`/`formatTaskList`（可测） |
| `src/tools/bash.ts` | 加 `run_in_background`；后台 spawn 写盘 + 完成回调 |
| `src/tools/agent.ts` | 加 `run_in_background`；后台脱钩 + abortController 入 task + 完成回调 |
| `src/tools/taskTools.ts`（新） | `TaskList` / `TaskOutput` / `TaskStop` 三工具 |
| `src/loop.ts` | execCall 后台分叉；runLoop 终止点 drain 通知注入 user 消息续跑 |
| `src/tui/useChat.ts` | `onNotification` 空闲唤醒；注册三任务工具 |
| `src/tools/index.ts` 或注册处 | 三任务工具注册 |
| `src/config.ts` | tasks 目录 |

**契约尽量兼容**：前台路径行为不变；`run_in_background` 默认 false → 现有同步语义完全保留。

## 测试策略

- `tasks.ts` 纯函数：`generateTaskId` 前缀/格式、`formatNotification`（各状态 + agent result / bash outputFile）、`formatTaskList`、`notified` check-and-set 去重、registry CRUD。
- Bash 后台：mock spawn，验证立即返回句柄、完成回调写盘 + enqueue 通知、kill。
- Agent 后台：脱钩跑、完成 enqueue、abort。
- **runLoop 通知注入**：构造 pendingNotifications，验证终止点把 `<task-notification>` 作 user 消息续跑（而非 return done）；无通知则正常 return；maxTurns 约束。
- TaskList/Output/Stop：增量 offset、停止置 killed+notified。
- 回归：`run_in_background` 缺省 = 现有同步行为，全部既有测试绿。

## 已知接受风险

| 风险 | 说明 |
|---|---|
| runLoop 自动续跑可能多耗 token | maxTurns 约束 + 通知去重；用户可 Esc |
| 空闲唤醒与 IME/输入竞态 | 仅 idle 且无待输入才唤醒；busy/输入中不抢 |
| 后台 bash 无权限二次确认 | 启动时已过权限门；后台执行中不再问（对齐 CC） |
| 落盘日志累积 | 启动时按龄清理 `~/.deepcode/tasks/` |
| 无并发上限 | 对齐 CC；靠 TaskStop + 用户自律 |

## 带入

L-041 落地后：L-043（子代理 steering：给后台 agent 注入 pendingMessages）、L-045（多 agent 工作流：fan-out 后台 agent + 依赖图）依次挂载。
