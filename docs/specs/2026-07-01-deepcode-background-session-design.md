# 7.3 后台会话薄片（background session）设计

**日期**：2026-07-01
**状态**：待用户复核（brainstorm 已过审）
**层级**：阶段 B（CC v2.1.193 gap 第 7 层）剩余件之一
**来源**：`docs/specs/2026-06-26-deepcode-cc-v2193-gap-and-plan.md` §7.3；CC v2.1.197 native binary 实读考据
**方法**：用户拍板「实读 CC 照搬 + 听专家」。派 opus 专家实读 CC v2.1.197 binary（`grep -a` 227M SEA）逐字考据 `/background`/`/stop`/daemon/attach 真实实现，据此收敛最小忠实薄片。

---

## 一、目标与非目标

### 目标
让当前交互会话「送到后台、释放终端」：fork 出会话副本，spawn 一个 detached headless 子进程 resume 续跑，原 TUI 退出把终端还给 shell。**不是挂起，是分叉续跑**——子进程作为普通 headless agent 跑到自然停，transcript 落盘可事后 `/resume` 回看。1:1 对齐 CC `/background` 的**语义内核**（fork+resume+释放终端+状态文件驱动列表），砍掉 daemon/PTY/attach 重型件。

### 非目标（本薄片明确押后）
- **完整 daemon**：控制 socket RPC（`dispatch`/`list`/`attach`/`kill`/`lease`）、on-demand 拉起、lease 心跳、roster adopt/respawn、zombie 检测、spare/prewarm 池、low-mem 调度、binary-takeover 升级续跑。
- **PTY host + attach/reattach**：APC detach 协议（`\x1B_cc-daemon-detach\x1B\\`）、DEC modes 重放、tmux/zellij caps 协商、bridge reattach。
- **远程杀**（daemon `op:"kill"` + SIGKILL 升级）、cross-uid 鉴权（pipe.key/tokens）。
- **macOS launchd / service install**（CC 本版本自己都默认关闭，`daemon install` 需手动）。
- **`/loops`**（cron + stop-hook，CC v2.1.197 里 `isEnabled:()=>!1` 本就隐藏，且与后台会话无关——它属 Kairos 定时域，deepcode 7.2 已另做）。

---

## 二、CC 真实语义考据（照搬依据，verbatim）

实读 CC v2.1.197 binary 关键发现（字节偏移见考据报告）：

- **`/background` 定义**（`Gof`）：`{name:"background", aliases:["bg"], description:"Send this session to the background and free the terminal", argumentHint:"[prompt]", immediate:(e)=>!e.trim()}`。
- **机制**（`qcr`/`vof`/`ZZ`）：spawn 新 `claude` 进程，argv 含 `--resume <sessionId> --fork-session`，带上当前 `--permission-mode / --model / --effort / --add-dir / --allowed-tools / --disallowed-tools / worktree / 会话级权限规则`；mid-turn 场景加 `--reply-on-resume`。原 TUI 走 `prompt_input_exit` 退出。→ **fork 会话副本 + 新进程 resume 续跑**。
- **门控文案**（verbatim）：`"Cannot background — session persistence is disabled, so the forked job would have nothing to resume."`、`"Nothing to background yet — send a message first."`；确认弹窗 `title:"Background this session?"`。
- **`/stop` 定义**（`Jof`/`Xof`）：`description:"Stop this background session; transcript and worktree are kept"`，`isEnabled:_i`（`_i()=$ke()==="bg"`，**仅当自身是后台会话才可用**）。handler `Wcr`：改自身 `state.json` 为 `state:"stopped"` → 打印 `"Session stopped."` → 进程退出。**是自停，不是按 id 停别的**；杀别的走 daemon `op:"kill"`。
- **状态落盘**：`<configDir>/jobs/<short>/state.json`（`short`=sessionId[:8]，mode 0600）。schema（`Mue`）含 `state/detail/tempo/sessionId/resumeSessionId/daemonShort/cwd/name/intent/initialPrompt/createdAt/updatedAt/worktreePath/backend` 等；`state ∈ working|stopped|failed|idle`。
- **daemon**：同 binary 子命令 `claude daemon run`，**本版本 install 默认关闭**、on-demand、最后 client 断开即退；控制 socket 在 `/tmp/cc-daemon-<uid>/<sha256(configDir)[:8]>/control.sock`。env `CLAUDE_JOB_DIR`、`CLAUDE_CODE_SESSION_KIND=bg`、`CLAUDE_BG_BACKEND=daemon`。
- **专家薄片裁决**：detached 子进程（fork+resume）+ `jobs/state.json` 状态机 + `/stop` + list 从 jobs 目录枚举 = 最小忠实。纯进程内做法语义不忠实（排除）；全 daemon 收益主要在 reattach，不做 reattach 时是纯负担。

---

## 三、架构

### 3.1 进程模型
```
交互 TUI ──/background [prompt]──▶ fork 会话 JSONL 副本（新 sessionId）
   │                                        │
   │  spawn(execPath, ['--background-run',   │
   │        '--resume', <forkedFile>,        │
   │        ...(seed?['-p',seed]:[])],       │
   │        {detached:true, stdio:'ignore'}) │
   │                                        ▼
   └─ 打印 finalMessage → process.exit(0)   detached headless 子进程
      （终端还给 shell）                     · DEEPCODE_SESSION_KIND=bg
                                             · DEEPCODE_JOB_DIR=~/.deepcode/jobs/<short>
                                             · resume 副本 → 跑 runLoop 到停
                                             · state.json: working→completed/failed
                                             · SIGTERM → stopped

前台另开 TUI ──/stop <id>──▶ 读 state.json.pid → SIGTERM → 标 stopped
             ──/stop（无 id）─▶ 列出运行中 jobs
             ──/resume────────▶ picker 纳入 bg 会话，回看 transcript
```

无 daemon、无 socket、无 PTY。detached 子进程是唯一后台载体，靠进程自身生命周期 + `jobs/<short>/state.json` 文件驱动列表与状态。

### 3.2 组件与边界

**A. `src/backgroundSession.ts`（新，纯逻辑优先）**
职责：Job 状态模型 + 落盘 + 枚举 + 格式化。对外接口：
- `JOBS_DIR = ~/.deepcode/jobs`（放 config.ts 常量，此处 re-export）
- `shortId(sessionId): string` — 前 8 字符
- `writeJobState(state: JobState): void` / `readJobState(short): JobState | null` / `updateJobState(short, patch): void`（读-改-写，mode 0600）
- `listJobs(): JobState[]` — 枚举 JOBS_DIR，读各 state.json，坏文件跳过
- `formatJobList(jobs: JobState[]): string` — 纯函数，`<id> [state] <name> · <cwd> · <相对时间>`
- `cleanupOldJobs(maxAgeMs): void` — 启动时按 `updatedAt` 龄清理终态 job（复用 tasks.ts 清理模式）

`JobState` 类型（照搬 CC 子集）：
```ts
interface JobState {
  sessionId: string       // forked 会话 id
  short: string           // sessionId[:8]，= 目录名
  state: 'working' | 'completed' | 'failed' | 'stopped'
  cwd: string
  name: string            // 会话标题 / seed 首句
  initialPrompt?: string  // seed prompt（可空=续跑未完回合）
  pid: number             // detached 子进程 pid（供 /stop 杀）
  model: string
  permMode: string
  sessionFile: string     // forked JSONL 绝对路径（供 /resume 回看）
  backend: 'detached'
  createdAt: number
  updatedAt: number
}
```

**B. `src/config.ts`（改）**
新增 `export const JOBS_DIR = path.join(os.homedir(), '.deepcode', 'jobs')`。

**C. `src/index.ts`（改，CLI 入口）**
- 新增 `--resume <file>`：resume 指定会话文件（现仅 `--continue` = 最近会话）。
- 新增 `--background-run`（内部 flag）：走后台运行器分支（非 `-p` 单发、非 TUI）。解析后调 `runBackgroundSession({ client, resumeFile, seed, jobDir, ... })`。
- 新增 `--job <short>`（内部 flag）：告知运行器其 job 目录名（`~/.deepcode/jobs/<short>`），供 state 生命周期更新定位。
- 子进程入口脚本 = 父进程 `process.argv[1]`（当前运行的 `dist/index.js`），保证父子同一构建产物。

**D. `src/headless.ts`（改 or 新 `runBackgroundSession`）**
现 `runHeadless` 是 newSession 单发。后台运行器变体：
- 入参加 `resumeFile`（resume 而非 newSession）、`jobDir`、`seed?`。
- 设 `process.env.DEEPCODE_SESSION_KIND='bg'`、`DEEPCODE_JOB_DIR=jobDir`。
- restore 会话 → 有 seed 喂 seed，否则续跑未完回合（reply-on-resume：若最后一条是未回应的 user/tool，直接续 runLoop）→ 跑 runLoop 到自然停。
- 边界更新 state：进入 `working`（启动时已由父进程写）→ 结束 `completed`/`failed`（catch）。
- 装 `process.on('SIGTERM')` → `updateJobState(short,{state:'stopped'})` → 退出。
- 复用现有 headless 工具集（含 bgTask/agent/workflow 等），权限 mode 沿用父进程传入。

**E. `src/tui/useChat.ts`（改，命令面）**
`send()` 加三分支（沿用现有 `if (line === '/x' ...)` 命令式模式）：
- `/background` / `/bg [prompt]`：见 §3.3 流程。
- `/stop [id]`：无 id → `notice(formatJobList(listJobs().filter(running)))`；有 id → 读 state.pid，`process.kill(pid,'SIGTERM')` + `updateJobState(short,{state:'stopped'})` + notice。找不到/已终态 → 提示。
- `/resume`：现有 picker 数据源并入 `listJobs()` 的 `sessionFile`（去重，bg 会话标注 `[bg <state>]`）。

**F. 双 TUI 组件（App.tsx + FullscreenApp.tsx，按需）**
页脚可选加「后台会话 N 个运行中」指示（读 `listJobs()` running 计数）。**双组件必双改**（项目铁律 [[deepcode-tui-dual-component]]）。若冒烟觉得噪音大可砍，非核心。

### 3.3 `/background` 前台流程（useChat.ts）
1. **门控**：
   - 会话持久化关闭（deepcode 恒持久化 JSONL，此项实测恒真，但仍保留守卫对齐 CC）→ `"Cannot background — 会话持久化已关闭，后台作业无从恢复。"`
   - 当前无任何消息 / 空会话 → `"Nothing to background yet — 先发一条消息。"`
2. **确认弹窗**「Background this session?」（复用现有 dialog 基建，如 pendingQuestion/pendingPlanApproval 同款）。取消 → 留在前台。
3. **确认**：
   - fork 当前会话 JSONL → 新 sessionId 副本（复用 session.ts fork：`getUniqueForkName` + 拷贝 messages/meta，标题带 `(Branch)` 或 `(bg)`）。原会话文件冻结。
   - 写初始 `state.json`（state:`working`，pid 待填）到 `~/.deepcode/jobs/<short>/`。
   - `spawn(process.execPath, [process.argv[1], '--background-run', '--resume', forkedFile, '--job', short, ...(seed?['-p',seed]:[]), ...(permMode?['--permission-mode',permMode]:[]), ...(model?['--model',model]:[])], {detached:true, stdio:'ignore'})`；`child.unref()`；把 `child.pid` 回填进 state.json。
   - 打印 finalMessage：`已送到后台（<short>）。终端已释放。用 /resume 回看，/stop <short> 停止。`
   - 干净退出 TUI：ink unmount + altscreen 还原（复用现有退出清理路径）→ `process.exit(0)`。

---

## 四、必要偏离（用户已知会并接受）

**`/stop` 语义偏离**：CC 的 `/stop` 是**自停**——`isEnabled` 仅当 `CLAUDE_CODE_SESSION_KIND==="bg"`，靠 reattach 进后台会话内敲。本薄片**押后 reattach**，headless 子进程无 TUI 可承接输入，自停不可达。故改为**前台 `/stop <id>` 按 pid 杀 + 标 stopped**（≈ CC daemon 的 `op:"kill"` 分支）。语义正确性（停止后台会话、保留 transcript+worktree）不受影响。将来上 reattach 再补 CC 式自停（钩子已预留：子进程认 `DEEPCODE_SESSION_KIND` + state 写 pid）。

---

## 五、改动文件汇总

| 文件 | 改动 |
|---|---|
| `src/backgroundSession.ts`（新） | `JobState` 模型 + 落盘/枚举/格式化/清理纯函数 |
| `src/config.ts` | `JOBS_DIR` 常量 |
| `src/index.ts` | `--resume <file>` + `--background-run` + `--job <short>` CLI 分支 |
| `src/headless.ts`（或新 `runBackgroundSession`） | resume 入口 + session-kind env + state 生命周期 + SIGTERM |
| `src/session.ts` | 若 fork 复用需要，暴露/微调 fork-copy 辅助（尽量不动，复用 `getUniqueForkName`） |
| `src/tui/useChat.ts` | `/background`·`/bg`·`/stop`·`/resume` 扩展 |
| `src/tui/App.tsx` + `FullscreenApp.tsx` | （可选）页脚后台会话计数指示，双改 |

**兼容性**：所有改动加法为主；不传新 flag/不敲新命令时行为完全不变，既有测试应全绿。

---

## 六、测试策略

- **纯函数单测**（`backgroundSession.ts`）：`shortId` 派生、`writeJobState/readJobState/updateJobState` 往返、`listJobs` 枚举（含坏文件跳过）、`formatJobList` 各 state、`cleanupOldJobs` 按龄。
- **CLI 解析**：`--resume`/`--background-run`/`--job` argv 分派。
- **fork copy**：会话副本新 id、原文件不变、messages 一致。
- **门控文案**：持久化关 / 空会话两条拦截。
- **runner 集成**：mock client，resume 副本 → runLoop 跑到停 → state `completed`；抛错 → `failed`；SIGTERM → `stopped`。
- **spawn**：mock `child_process.spawn`，验 argv 构建 + `detached:true` + `unref` + pid 回填。
- **回归**：既有 headless/TUI 测试全绿（缺省路径不变）。
- **🔴 真机冒烟（不可省，项目铁律）**：真敲 `/background "跑个长任务"` → 确认弹窗 → TUI 退出终端释放（回到 shell 提示符）→ `~/.deepcode/jobs/<short>/state.json` 落盘且子进程 `ps` 可见在跑 → `/stop <short>` 前台杀掉、state 变 stopped → `/resume` 选中该 bg 会话看到续跑的 transcript。glm-5.2 或 glm-5-turbo 端到端。

---

## 七、已知接受风险

| 风险 | 说明 / 缓解 |
|---|---|
| detached 子进程无输出可见性 | 本薄片不做 reattach；靠 `/resume` 事后看 transcript + state.json 状态。将来 reattach 补。 |
| `/stop` 偏离 CC 自停 | §四已知会接受；前台按 pid 杀，reattach 落地再补自停。 |
| 子进程孤儿/僵尸 | state 终态 + `cleanupOldJobs` 按龄清；pid 复用极小概率误杀由 `/stop` 前读 state 校验 short↔sessionId 缓解。 |
| 无并发上限 | 对齐 CC（也不限）；靠 `/stop` + 用户自律。 |
| fork 会话与原会话双写 | 不存在——原 TUI 退出后仅子进程单写副本。 |

---

## 八、未来带入（不实现，留钩子）

- **reattach**：引入 daemon + PTY host 作独立增量，接 CC 的控制 socket + APC detach 协议；`/stop` 届时补 CC 式自停。子进程已认 `DEEPCODE_SESSION_KIND` + state 写 pid。
- **daemon 常驻**：service install（CC 本版都默认关，低优先）。
- **FleetView（7.4）**：多后台会话队列 UI，依赖本件的 `listJobs()` 数据源 + 7.1 Workflow。
