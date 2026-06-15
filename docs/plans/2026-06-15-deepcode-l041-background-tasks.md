# L-041 后台任务 + 完成通知 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 逐任务实现。步骤用 `- [ ]` 跟踪。**权威 spec：`docs/specs/2026-06-15-deepcode-background-tasks-design.md`，每任务先读它。**

**Goal:** 让 Bash/Agent 能 `run_in_background`：启动即返句柄、主循环续跑、完成时 `<task-notification>` 注入下一回合自动唤醒模型。

**Architecture:** 模块级 `TaskRegistry` + 通知队列（`src/tasks.ts`）；工具后台分支脱钩跑、完成回调入队通知；runLoop 终止点 drain 注入 user 消息续跑；useChat 空闲订阅唤醒。默认 `run_in_background=false` → 现有同步语义零破坏。

**Tech Stack:** TypeScript/ESM、vitest、node:child_process（spawn）、node:fs、node:crypto。

**测试命令：** `npm test`（vitest）、`npm run typecheck`、`npm run build`。所有纯函数不调 `new Date()`/`Math.random()`（时间/随机由调用方注入或参数传入；`generateTaskId` 是唯一例外，用 `crypto.randomBytes`，对齐 CC，但要可注入随机源以便测）。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/tasks.ts`（新） | Task 模型、`TaskRegistry`、通知队列、`generateTaskId`、纯函数 `formatNotification`/`formatTaskList` |
| `src/tools/bash.ts`（改） | `run_in_background` 后台分支：spawn 写盘 + exit 回调 |
| `src/tools/agent.ts`（改） | `run_in_background` 后台分支：脱钩 + abortController + 完成回调 |
| `src/tools/taskTools.ts`（新） | `TaskList`/`TaskOutput`/`TaskStop` 三工具 |
| `src/loop.ts`（改） | runLoop 终止点 drain 通知注入 user 消息续跑 |
| `src/tui/useChat.ts`（改） | `onNotification` 空闲唤醒 + 注册三工具 |
| `src/headless.ts`（改） | 注册三工具（headless 也可管理后台任务） |
| `src/config.ts`（改） | tasks 目录常量 |

---

## Task 1：tasks.ts 核心（Task 模型 + 注册表 + 通知队列 + 纯函数）

**Files:** Create `src/tasks.ts`、Test `test/tasks.test.ts`

接口（对齐 spec §1-2）：
```ts
export type TaskType = 'local_bash' | 'local_agent'
export type TaskStatus = 'running' | 'completed' | 'failed' | 'killed'
export interface BackgroundTask {
  id: string; type: TaskType; status: TaskStatus; description: string
  toolUseId?: string; startTime: number; endTime?: number
  outputFile: string; outputOffset: number; notified: boolean
  command?: string; child?: any            // bash
  prompt?: string; abortController?: AbortController; result?: string  // agent
}
export interface TaskNotification { id: string; status: TaskStatus; summary: string; result?: string; outputFile?: string }
```

- `TaskRegistry`：模块级 `const tasks = new Map<string, BackgroundTask>()` + `registerTask(t)`、`getTask(id)`、`listTasks(): BackgroundTask[]`、`updateTask(id, patch)`、`removeTask(id)`、`clearAllTasks()`（测试用）。
- `generateTaskId(type, rand = crypto.randomBytes)`：前缀 `local_bash→'b'`/`local_agent→'a'` + 8 位 `[0-9a-z]`。rand 可注入便于测。
- 通知队列：模块级 `const queue: TaskNotification[] = []`；`enqueueNotification(task)`：**先 check-and-set**——`if (task.notified) return; updateTask(id,{notified:true})`，再 `queue.push(formatNotificationObj(task))` 并触发订阅者；`drainNotifications(): TaskNotification[]`（取出清空）；`onNotification(cb): ()=>void`（订阅，返回退订）。
- 纯函数 `formatNotification(n: TaskNotification): string` → XML：
  ```
  <task-notification>\n<task-id>{id}</task-id>\n<status>{status}</status>\n<summary>{summary}</summary>\n{result? <result>..</result>}{outputFile? <output-file>..</output-file>}\n</task-notification>
  ```
- 纯函数 `formatTaskList(tasks: BackgroundTask[]): string` → 每行 `{id} [{status}] {description}`；空列表 → `（无后台任务）`。

- [ ] **Step 1：写失败测试** `test/tasks.test.ts`：
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { TaskRegistry... } // 按实现导出名
// generateTaskId：bash 前缀 'b'、agent 前缀 'a'、长度 1+8、字符集 [0-9a-z]（注入定长 rand 断言确定输出）
// registry：register→get→list→update→remove；clearAll
// enqueueNotification：首次入队、第二次（notified 已 true）不重复入队；drain 返回并清空；onNotification 回调被触发
// formatNotification：completed/failed/killed 各形态；agent 带 <result>；bash 带 <output-file>
// formatTaskList：多任务每行格式；空列表文案
```
- [ ] **Step 2：跑测试看红** `npm test -- tasks` → FAIL（模块不存在）
- [ ] **Step 3：实现 `src/tasks.ts`**（按上述接口；纯函数无副作用；registry/queue 模块级）
- [ ] **Step 4：跑测试看绿 + typecheck** `npm test -- tasks && npm run typecheck`
- [ ] **Step 5：commit** `feat(L-041): tasks.ts 任务模型+注册表+通知队列+纯函数`

---

## Task 2：Bash 后台化

**Files:** Modify `src/tools/bash.ts`、Test `test/bash.test.ts`（若无则新建）

- schema 加 `run_in_background: z.boolean().optional().describe('设为 true 在后台运行；用 TaskOutput 读输出')`。
- `call(input, ctx)`：若 `input.run_in_background`：
  - `const id = generateTaskId('local_bash')`；`const outputFile = taskOutputPath(id)`（`~/.deepcode/tasks/<id>.log`，从 config）。
  - `spawn(shell, ['-c', input.command], { cwd: ctx.cwd })`，`child.stdout/stderr` `.pipe` 到 `fs.createWriteStream(outputFile)`（合并）。
  - `registerTask({ id, type:'local_bash', status:'running', description: input.command, command: input.command, child, outputFile, outputOffset:0, notified:false, startTime: Date.now() })`。
  - `child.once('exit', code => { updateTask(id,{status: code===0?'completed':'failed', endTime: Date.now()}); enqueueNotification(getTask(id)!) })`。
  - **立即 return** `后台任务已启动 id=${id}，输出写入 ${outputFile}。用 TaskList/TaskOutput/TaskStop 管理。`
  - 前台路径（默认）：不变。

- [ ] **Step 1：写失败测试**：mock `node:child_process` 的 spawn 返回带 `once`/`stdout.pipe` 的假 child；断言：后台调用立即返回含 `id=` 的句柄字符串、registry 多一条 running 任务；触发假 child 的 exit(0) → 任务转 completed + 通知入队。前台路径回归（run_in_background 缺省走原 execFile）。
- [ ] **Step 2：跑测试看红**
- [ ] **Step 3：实现**（后台分支；注意 outputFile 目录需 `mkdirSync(recursive)`）
- [ ] **Step 4：跑测试看绿 + typecheck**
- [ ] **Step 5：commit** `feat(L-041): Bash run_in_background（spawn 写盘 + exit 回调入队通知）`

---

## Task 3：Agent 后台化

**Files:** Modify `src/tools/agent.ts`、Test `test/agent.test.ts`

- schema 加 `run_in_background: z.boolean().optional().describe('设为 true 在后台运行子代理；完成时通知你')`。
- `call`：若 `input.run_in_background`：
  - `const id = generateTaskId('local_agent')`；`const ac = new AbortController()`；outputFile 同上。
  - `registerTask({ id, type:'local_agent', status:'running', description: input.description, prompt: input.prompt, abortController: ac, outputFile, outputOffset:0, notified:false, startTime: Date.now() })`。
  - `void (async () => { try { 跑现有子代理 runLoop（signal 用 ac.signal）→ 取最后 assistant 文本 final；fs.writeFileSync(outputFile, final); updateTask(id,{status:'completed', endTime:Date.now(), result:final}); } catch(e){ updateTask(id,{status: ac.signal.aborted?'killed':'failed', endTime:Date.now()}); } finally { enqueueNotification(getTask(id)!) } })()`
  - **立即 return** `后台子代理已启动 id=${id}（类型 ${type}）。完成时会通知你。`
  - 前台路径不变（含 L-040 类型化、信号量）。
  - **注意**：后台 agent 也走信号量 acquire/release，但 release 必须在脱钩的 async 里 finally，而非 call 返回前。

- [ ] **Step 1：写失败测试**：用现有 chatStream mock 脚本；后台调用立即返回含 `id=` 句柄、registry 多一条 running；脱钩 async 跑完（await 微任务）→ 任务 completed + result 写入 + 通知入队；abort 路径 → killed。
- [ ] **Step 2：跑测试看红**
- [ ] **Step 3：实现**（脱钩 async + 信号量在 async 内 finally release）
- [ ] **Step 4：跑测试看绿 + typecheck**
- [ ] **Step 5：commit** `feat(L-041): Agent run_in_background（脱钩 + abortController + 完成回调）`

---

## Task 4：任务管理工具 TaskList / TaskOutput / TaskStop

**Files:** Create `src/tools/taskTools.ts`、Test `test/taskTools.test.ts`

- `taskListTool`：无参（`z.object({})`）；`isReadOnly:true`、`needsPermission:()=>false`；`call` → `formatTaskList(listTasks())`。
- `taskOutputTool`：`{ task_id: z.string(), offset: z.number().optional() }`；只读；`call`：取 task，从 `offset ?? task.outputOffset` 读 outputFile（`fs.readFileSync` slice），更新 `outputOffset = 文件长度`；返回 `<status>{status}</status>\n{输出增量}`；读完终态任务置 `notified:true`；任务不存在 → `任务 {id} 不存在`。
- `taskStopTool`：`{ task_id: z.string() }`；`isReadOnly:false`、`needsPermission:()=>false`（停自己起的后台任务无需额外批准）；`call`：取 task，running 才停——bash `task.child?.kill('SIGTERM')`（或 treeKill 等价：先 SIGTERM）、agent `task.abortController?.abort()`；`updateTask(id,{status:'killed', notified:true, endTime:Date.now()})`；返回 `已停止任务 {id}`；非 running → `任务 {id} 非运行中（{status}）`。

- [ ] **Step 1：写失败测试**：registry 预置任务；TaskList 列出；TaskOutput 增量读（写临时文件，第一次读全量+推进 offset、第二次读新增）；TaskStop 对 running bash 调 child.kill、对 agent 调 abort，置 killed；对不存在/非 running 的友好返回。
- [ ] **Step 2：跑测试看红**
- [ ] **Step 3：实现 `src/tools/taskTools.ts`**
- [ ] **Step 4：跑测试看绿 + typecheck**
- [ ] **Step 5：commit** `feat(L-041): TaskList/TaskOutput/TaskStop 三工具`

---

## Task 5：runLoop 通知注入（核心）

**Files:** Modify `src/loop.ts`、Test `test/loop.test.ts`（或现有 loop 测试文件）

- 在 runLoop 的终止点（现 `return 'done'` 处，loop.ts:138 附近，模型本轮无 toolCalls）改为：
  ```ts
  if (result.toolCalls.length === 0) {
    const notes = drainNotifications()
    if (notes.length > 0) {
      messages.push({ role: 'user', content: notes.map(formatNotification).join('\n') })
      yield { type: 'notification_injected', count: notes.length } // 可选事件，UI 可显示
      continue  // 不 return，进入下一轮 API
    }
    return 'done'
  }
  ```
  （注意：`continue` 要落到 `for turn` 循环；若现有结构是 `return 'done'` 在内层 while/分支，调整为跳出到 turn 循环继续。读懂现有控制流再改。）
- 受 `maxTurns` 自然约束（注入也算一轮）。

- [ ] **Step 1：写失败测试**：mock chatStream 让模型某轮返回无 toolCalls；预置 pendingNotifications 一条 → 断言 runLoop 没有立即结束，而是把 `<task-notification>` 作为 user 消息推入 messages 并再发一轮 API（chatStream 被多调一次）；无通知时正常 `return 'done'`；maxTurns 边界不死循环。
- [ ] **Step 2：跑测试看红**
- [ ] **Step 3：实现**（最小改 loop.ts 终止分支；保持其余 yield 行为不变）
- [ ] **Step 4：跑测试看绿 + typecheck + 全量回归**（现有 loop/agent 测试必须仍绿）
- [ ] **Step 5：commit** `feat(L-041): runLoop 终止点 drain 通知注入 user 消息续跑`

---

## Task 6：useChat 空闲唤醒 + 工具注册

**Files:** Modify `src/tui/useChat.ts`、`src/headless.ts`、Test `test/useChat.*` 或 core 测试

- `tools` 数组加 `taskListTool, taskOutputTool, taskStopTool`（useChat 与 headless 都加）。
- useChat：`onNotification` 订阅——通知到达时，若 `!busy`（idle）且无进行中发送，则自动触发一次 `send`（把通知文本作为输入跑一轮，使后台完成能在空闲时唤醒模型）。**busy 时不抢**（此时 Task 5 的 runLoop 终止点会处理）。订阅在 core 创建时挂、销毁时退订。
- headless：单发模式不挂空闲订阅（主任务结束即退出；运行中完成的后台任务由 Task 5 注入）。

- [ ] **Step 1：写失败测试**（core 层）：构造 core，busy=false 时 enqueueNotification → 断言 core 自动发起一轮（send 被调用 / 模型收到通知 user 消息）；busy=true 时不抢。工具集含三任务工具。
- [ ] **Step 2：跑测试看红**
- [ ] **Step 3：实现**（onNotification 订阅 + idle 守卫 + 工具注册）
- [ ] **Step 4：跑测试看绿 + typecheck**
- [ ] **Step 5：commit** `feat(L-041): useChat 空闲唤醒 + 注册任务工具；headless 注册`

---

## Task 7：配置 + 清理

**Files:** Modify `src/config.ts`、`src/tasks.ts`、Test 补充

- `config.ts`：导出 `TASKS_DIR = ~/.deepcode/tasks`（`taskOutputPath(id)` helper）。
- 进程退出清理：`installTaskCleanup()`（`process.once('exit'|'SIGINT'|'SIGTERM')` → kill 所有 running 任务：bash child.kill、agent abort）。在 TUI/headless 启动处调一次（复用 altscreen 清理注册风格，幂等）。
- 启动时清理旧日志：`~/.deepcode/tasks/` 中超 N 天的 `.log` 删除（可选、简单按 mtime）。

- [ ] **Step 1：写失败测试**：`taskOutputPath` 路径格式；`installTaskCleanup` 注册后触发 exit 钩子 kill running 任务（mock）。
- [ ] **Step 2：跑测试看红**
- [ ] **Step 3：实现**
- [ ] **Step 4：跑测试看绿 + typecheck + build + 全量**
- [ ] **Step 5：commit** `feat(L-041): tasks 目录 + 退出清理 + 旧日志清理`

---

## 末轮：opus 全量终审

7 任务全过后，加一轮 opus 终审（对齐 CC + wiring 零失配 + 通知去重无死循环 + 前台路径零破坏 + 退出清理安全），再 `finishing-a-development-branch` 合 main。

## 自审（本计划 vs spec）

- spec §1-2 Task 模型/注册表/通知队列 → Task 1 ✓
- §3 控制流分叉（bash/agent 后台）→ Task 2/3 ✓
- §4 runLoop 注入 → Task 5 ✓
- §5 空闲唤醒 → Task 6 ✓
- §6/7 bash/agent 后台化 → Task 2/3 ✓
- §8 三工具 → Task 4 ✓
- §9 并发/清理/取消 → Task 7（清理）+ Task 4（取消）✓
- 测试策略 → 各任务 Step 1 ✓
- 无占位符；类型名跨任务一致（BackgroundTask/TaskNotification/generateTaskId/enqueueNotification/drainNotifications/formatNotification/formatTaskList）。
