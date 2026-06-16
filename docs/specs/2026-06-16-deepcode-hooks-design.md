# deepcode Hooks 生命周期系统设计（L-042，里程碑①）

**日期：** 2026-06-16
**状态：** 设计待批 → writing-plans
**对齐源：** Claude Code 源码 `/Users/silas/Desktop/src`（4 份实读对齐报告：命令钩子 / prompt·agent·http 类型 / async / 事件·payload·if / UI）
**用户钦定：** 全保真对齐 CC，不做品味性简化；范围**排序做**（本件=里程碑①引擎+现有触发点事件，缺依赖的 6 事件随其子系统落地接）。

---

## 0. 范围

### 本件（里程碑①）交付
- **Hooks 引擎** `src/hooks.ts`：matcher 匹配、if 条件、4 种 hook 类型（command/prompt/agent/http）、**并行执行 + 优先级合并**、async/asyncRewake、超时/容错。
- **配置** `src/config.ts`：`Settings.hooks`，会话启动快照。
- **21 个有真触发点的事件** + 各自 dispatch 点接入。
- **TUI 进度显示**（轻量版 HookProgressMessage）。

### 明确不在本件（随子系统落地时接）
6 个绑定未建子系统的事件，**事件常量先入枚举**（引擎能跑、配置能写、但无 dispatch 调用）：
| 事件 | 等的子系统 |
|---|---|
| WorktreeCreate / WorktreeRemove | L-020 worktree |
| Elicitation / ElicitationResult | L-022 MCP |
| TeammateIdle | L-045 多 agent |
| FileChanged | 文件 watcher |

> 这不是"砍"——常量已就位，引擎/配置/UI 全支持；造对应子系统时加一行 `runHooks(...)` dispatch 即点亮。

### 子阶段拆分（每段独立 plan→实现→双审→合 main；架构段加 opus 终审）
- **①a 引擎地基**：`src/hooks.ts` 纯函数 + command 类型 + 并行 + 合并 + if + 配置 + **PreToolUse/PostToolUse/PostToolUseFailure** 接入 execCall（含 permission 集成）。纯逻辑，免冒烟。
- **①b 其余事件 dispatch**：Stop/StopFailure/SubagentStart/SubagentStop/SessionStart/SessionEnd/Setup/UserPromptSubmit/PreCompact/PostCompact/PermissionRequest/PermissionDenied/TaskCreated/TaskCompleted/Notification/ConfigChange/CwdChanged/InstructionsLoaded。纯逻辑，免冒烟。
- **①c prompt/agent/http 三类型**：复用 deepcode LLM client / Agent 运行器 / fetch。纯逻辑，免冒烟。
- **①d async/asyncRewake**：挂 `src/tasks.ts` 后台任务体系。纯逻辑，免冒烟。
- **①e TUI 进度 UI**：HookProgressMessage 轻量版。**碰 TUI → 需用户真机冒烟。**

---

## 1. 引擎架构（`src/hooks.ts`）

### 1.1 类型

```ts
export const HOOK_EVENTS = [
  // 工具类
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  // 会话类
  'SessionStart', 'SessionEnd', 'Setup', 'UserPromptSubmit',
  // 停止类
  'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop',
  // compact 类
  'PreCompact', 'PostCompact',
  // 权限类
  'PermissionRequest', 'PermissionDenied',
  // 任务类
  'TaskCreated', 'TaskCompleted',
  // 杂项
  'Notification', 'ConfigChange', 'CwdChanged', 'InstructionsLoaded',
  // —— 缺依赖、本件不 dispatch、随子系统点亮 ——
  'WorktreeCreate', 'WorktreeRemove', 'Elicitation', 'ElicitationResult',
  'TeammateIdle', 'FileChanged',
] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

// 公共字段（所有 hook 类型）
interface HookCommon { timeout?: number; if?: string; once?: boolean; statusMessage?: string }
export interface CommandHook extends HookCommon { type: 'command'; command: string; async?: boolean; asyncRewake?: boolean }
export interface PromptHook  extends HookCommon { type: 'prompt';  prompt: string; model?: string }
export interface AgentHook   extends HookCommon { type: 'agent';   prompt: string; model?: string }
export interface HttpHook    extends HookCommon { type: 'http';    url: string; headers?: Record<string, string> }
export type HookCommand = CommandHook | PromptHook | AgentHook | HttpHook

export interface HookMatcher { matcher?: string; hooks: HookCommand[] }
export type HooksConfig = Partial<Record<HookEvent, HookMatcher[]>>
```

### 1.2 Payload（写入 hook stdin 的 JSON / prompt 的 $ARGUMENTS）

公共字段：`{ hook_event_name, cwd, session_id, permission_mode?, agent_id?, agent_type? }`。各事件特有字段见 §3 表。

### 1.3 单 hook 结果 → 聚合结果（对齐 CC 的两层归一）

```ts
// 单个 hook 解析后的标准结果（4 类型都归一到这里）
export interface HookResult {
  outcome: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled' | 'backgrounded'
  permissionDecision?: 'allow' | 'deny' | 'ask'   // PreToolUse / PermissionRequest
  permissionReason?: string
  updatedInput?: unknown                            // PreToolUse 改写入参
  updatedOutput?: string                            // PostToolUse 改写输出（泛化 CC 的 updatedMCPToolOutput）
  additionalContext?: string                        // 注入回模型
  systemMessage?: string
  stopReason?: string                               // continue:false
  preventContinuation?: boolean                     // Stop/SubagentStop block→续跑
  blockingError?: string                            // exit 2 / decision:block 的原因
  // UI 用
  label: string                                     // 命令/url/'prompt'/'agent'
  durationMs: number
}

// 一个事件全部匹配 hook 并行跑完后的聚合
export interface HookOutcome {
  block: boolean              // 任一 deny / blocking → true（PreToolUse 阻断工具；Stop 类→续跑信号）
  blockReason?: string
  permission?: 'allow' | 'deny' | 'ask'   // 合并：deny > ask > allow
  permissionReason?: string
  updatedInput?: unknown      // 最后一个非空（按配置序）
  updatedOutput?: string      // 最后一个非空
  additionalContext?: string  // 各 hook 累加（\n\n）
  systemMessage?: string      // 累加
  preventContinuation: boolean
  stop: boolean               // 任一 continue:false → 硬停
  results: HookResult[]       // 供 UI
}
```

### 1.4 纯函数（无 I/O，单测全覆盖）

- `matchesMatcher(matcher, query): boolean` —— `undefined|''|'*'` → true；`a|b|c` 管道精确或；否则当正则 `new RegExp(m).test(query)`（构造失败 → false）。
- `matchQueryFor(event, payload): string | undefined` —— 工具类→`tool_name`；SessionStart→`source`；Setup/PreCompact/PostCompact→`trigger`；Notification→`notification_type`；SessionEnd→`reason`；SubagentStart/Stop→`agent_type`；ConfigChange→`source`；InstructionsLoaded→`load_reason`。其余（TaskCreated/TaskCompleted 等）返回 `undefined`（matcher 忽略=恒匹配）。
- `evalIfCondition(ifExpr, toolName, desc): boolean` —— 仅工具类事件有 `if`。解析 `Tool(pattern)`，复用 `permissions.matchRule` 语义（精确 / `:*` 前缀；Bash 命令按描述匹配）。`Tool`（无括号）→ 仅比工具名。
- `parseHookStdout(stdout, exitCode, stderr): HookResult` —— `exit 2`→`{outcome:'blocking', blockingError: stderr||stdout}`；`exit 0`→解析 stdout JSON（容错：非 JSON→`{outcome:'success', additionalContext: stdout?}`）；其他码→`{outcome:'non_blocking_error'}`（记录不阻断）。JSON 字段映射：`continue:false`→`stop`；`decision:'block'`+`reason`→`blocking`+`preventContinuation`；`hookSpecificOutput.{permissionDecision,permissionReason,updatedInput,updatedOutput,additionalContext}`、顶层 `systemMessage`。
- `mergeResults(results, event): HookOutcome` —— 见 §1.3 合并规则。`block = 任一 blocking || permission==='deny'`。
- `isAsyncFirstLine(line): {async:true, asyncTimeout?} | null` —— 检测 stdout 首行 `{"async":true,...}`。

### 1.5 引擎主函数（impure，依赖注入便于测）

```ts
export interface HookEngineDeps {
  spawn?: typeof import('node:child_process').spawn   // command
  llm?: (prompt: string, model: string, signal: AbortSignal) => Promise<string>  // prompt/agent
  runAgent?: (prompt: string, model: string, signal: AbortSignal) => Promise<string> // agent
  fetch?: typeof fetch                                 // http
  registerAsync?: (h: CommandHook, payload, label) => void  // async → tasks.ts
  now?: () => number
}

export async function runHooks(
  event: HookEvent,
  payload: Record<string, unknown>,
  config: HooksConfig | undefined,
  deps?: HookEngineDeps,
): Promise<HookOutcome>
```

流程：
1. `config?.[event]` 无 → 立即返回空 `HookOutcome`（**零开销**：无 spawn/无 LLM）。
2. 选中 `matchesMatcher(m.matcher, matchQueryFor(event, payload))` 的 matcher，flatten `hooks`。
3. 工具类事件按 `evalIfCondition` 过滤。
4. **并行** `Promise.all` 跑每个 hook（按 `type` 分派到 4 个执行器）。
   - command：spawn shell，payload JSON 写 stdin，注入 env（`DEEPCODE_PROJECT_DIR`/cwd/`DEEPCODE_ENV_FILE`），超时（默认 60s）→ `parseHookStdout`。
   - **async/asyncRewake**：检测到 → `registerAsync` 挂后台任务（见 §4），立即返 `{outcome:'backgrounded'}` 不阻塞。
   - prompt：`llm(prompt.replace('$ARGUMENTS', JSON.stringify(payload)), model, signal)` → 解析 `{ok, reason}` → `ok:false`→blocking。
   - agent：`runAgent(...)`（带结构化输出约束，复用 deepcode Agent 运行器，model 默认 flash）→ `{ok, reason}`。
   - http：`fetch(url, {method:'POST', body: JSON, headers(env 插值)})` → 解析响应 JSON（同 parseHookStdout 的 JSON 分支），非 2xx→blocking。环境变量插值带 `allowedEnvVars` 白名单 + header 值消毒（去 `\r\n\x00`）。
5. `mergeResults` → `HookOutcome`。

> 顺序无关性：并行结果合并按**配置序**索引应用 `updatedInput`/`additionalContext`，保证确定性（测试可复现）。

---

## 2. 配置（`src/config.ts`）

`Settings` 加 `hooks?: HooksConfig`。`loadSettings` 用 zod 宽松解析（结构非法的条目丢弃 + 记 warning，不崩）。**会话启动快照**：启动时 `loadSettings().hooks` 读一次，贯穿本会话传递（对齐 CC 的 `hooksConfigSnapshot`，避免运行中改配置导致不一致）。`once:true` 的 hook 触发一次后从快照移除（运行时态，不写盘）。

settings.json 示例：
```jsonc
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write|Edit",
        "hooks": [{ "type": "command", "command": "bash guard.sh", "timeout": 30, "if": "Write(*.env)" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "prompt", "prompt": "子代理输出是否完整？$ARGUMENTS", "model": "flash" }] }
    ],
    "SessionStart": [
      { "matcher": "startup", "hooks": [{ "type": "command", "command": "echo export FOO=bar >> $DEEPCODE_ENV_FILE" }] }
    ]
  }
}
```

---

## 3. 事件触发点（21 个，映射到 deepcode）

| 事件 | deepcode dispatch 点 | payload 特有字段 | 能做什么 |
|---|---|---|---|
| **PreToolUse** | `loop.ts execCall`：schema 解析后、`checkPermission` 前 | tool_name, tool_input, tool_use_id | deny 阻断 / updatedInput 改写（改后重过 schema）/ permissionDecision:allow 跳过交互 |
| **PostToolUse** | `execCall`：`tool.call` 成功后 | tool_name, tool_input, tool_output | updatedOutput 改写结果 / additionalContext 注入 |
| **PostToolUseFailure** | `execCall`：catch 分支 | tool_name, tool_input, error | additionalContext / 记录 |
| **PermissionRequest** | `permissions.ts checkPermission`：交互 ask 前 | tool_name, tool_input | hook 可 allow/deny 替代弹窗 |
| **PermissionDenied** | `checkPermission`：判定拒绝后 | tool_name, tool_input, reason | 记录 / 通知 |
| **Stop** | `loop.ts runLoop`：`return 'done'` 前 | stop_hook_active, last_assistant_message | decision:block→注入 reason 续跑（每轮限一次，stop_hook_active 守卫） |
| **StopFailure** | `runLoop`：API 调用 catch | error, last_assistant_message | 记录 / 通知 |
| **SubagentStart** | `agent.ts`：runSub 前 | agent_id, agent_type | additionalContext 注入子代理 |
| **SubagentStop** | `agent.ts`：runSub 拿 final 后 | agent_id, agent_type, last_assistant_message, stop_hook_active | block→续跑子循环（**L-044 底座**） |
| **SessionStart** | 启动处（index/useChat 初始化） | source(startup/resume/clear) | additionalContext+systemMessage 注入初始上下文 / 写 `DEEPCODE_ENV_FILE` |
| **SessionEnd** | 退出清理（`installTaskCleanup` 旁） | reason | 记录 / 清理脚本 |
| **Setup** | 首跑向导后 | trigger(init/maintenance) | 初始化脚本 |
| **UserPromptSubmit** | useChat：用户消息进 messages 前 | prompt | additionalContext 注入 / block 拦截 |
| **PreCompact** | compact 逻辑前 | trigger(manual/auto), custom_instructions | 改 custom_instructions |
| **PostCompact** | compact 完成后 | trigger, compact_summary | 记录 |
| **TaskCreated** | `tasks.ts registerTask` | task_id, task_description | 记录 / block |
| **TaskCompleted** | `tasks.ts enqueueNotification` | task_id, status | 记录 |
| **Notification** | 通知发出处 | message, title, notification_type | 桌面通知转发等 |
| **ConfigChange** | `config.ts saveSettings` | source, file_path | 记录 |
| **CwdChanged** | `bash.ts` setCwd / `ToolContext.setCwd` | old_cwd, new_cwd | 写 env / 记录 |
| **InstructionsLoaded** | CLAUDE.md/memory 加载处 | file_path, memory_type, load_reason | 记录 |

**matcher 对非工具事件**：匹配 `matchQueryFor` 的值（SessionStart→source、PreCompact→trigger 等）。**if 条件**仅工具类事件（PreToolUse/PostToolUse/PostToolUseFailure/PermissionRequest）。

**FileChanged matcher 字段**：`matchQueryFor('FileChanged', payload)` 返回 `file_basename`（`src/hooks.ts` 已实现，M-3 对齐），但因 watcher 子系统尚未落地暂无 dispatch 调用。待 watcher 落地时加一行 `runHooks('FileChanged', { file_basename, ...})` 即点亮（matcher 字段=file_basename，引擎已支持，待 watcher 落地 dispatch）。

### SessionStart 环境变量写入（对齐 CC CLAUDE_ENV_FILE）
启动执行 SessionStart hook 时，env 注入 `DEEPCODE_ENV_FILE=~/.deepcode/session-env/<sessionId>/sessionstart-hook-<i>.sh`；hook 可 `echo export FOO=bar >> $DEEPCODE_ENV_FILE`。之后 **Bash 工具执行前**读取该目录下所有 `*.sh` 串联注入命令前缀（`bash.ts` 包装）。CwdChanged hook 同理写 `cwdchanged-hook-*.sh` 并失效缓存。按会话隔离、不跨会话持久。

---

## 4. async / asyncRewake（挂 `src/tasks.ts`）

deepcode 已有：后台任务表 + 通知队列 + 主循环 idle drain 注入。映射：
- **async hook**（配置 `async:true` 或 stdout 首行 `{"async":true}`）→ spawn 后台进程，注册为后台任务（新 `type:'hook'` 或复用 local_bash + 标记），`runHooks` 立即返 `backgrounded`，不阻塞。完成时其 stdout JSON 解析后入通知队列（主循环 drain 注入）。
- **asyncRewake**（`asyncRewake:true`，蕴含 async）→ 后台跑，**exit code 2** 时把 `blockingError` 包成 `<task-notification>` 入队唤醒模型；非 2 静默。

复用 §L-041 的 `registerTask`/`enqueueNotification`/`drainNotifications`/`formatNotification`。新增：任务 `type:'hook'`、`asyncRewake` 标记、完成回调里解析 hook stdout JSON 或 exit-2 唤醒分支。

---

## 5. TUI 进度显示（①e，轻量版）

对齐 CC 的**计数渲染**模式，砍掉 defer/collapse（小 TUI 不需要）：
- 维护 `Map<HookEvent, {inProgress, resolved}>`（runHooks 开始 +inProgress、结束 +resolved）。
- 组件 `HookProgressMessage`：`inProgress>resolved` → 渲染 `⧗ Running <event> hook…`；全完成 → 不渲染（避免闪烁）。PreToolUse/PostToolUse 高频可抑制为完成后一行 `N PostToolUse hooks ran`。
- hook 的 `additionalContext`/`systemMessage`/`blockingError` 作为**现有消息类型**进对话流（不新增消息组件，附为 `<hook-context>` 包裹的文本 / system 消息），故只有进度行是新 TUI 组件。
- 保留：状态计数（防闪烁）、事件名分类（高频抑制）。先不做：百分比动画、流式输出预览、transcript 特殊处理。

---

## 6. 集成语义要点（对齐 CC）

- **PreToolUse 权限**（用户钦定"对齐 CC 完整版"）：hook `deny`→阻断；`updatedInput`→改写后**重过 schema**再继续；`permissionDecision:'allow'`→跳过 `checkPermission` 的交互 ask（deepcode 无显式 deny 规则层，故 allow≈自动放行）；`ask`/无→走原 `checkPermission`。
- **PostToolUse**：`updatedOutput`→替换工具结果字符串；`additionalContext`→`\n\n<hook-context>...</hook-context>` 附到结果。
- **Stop/SubagentStop block→续跑**：注入 reason 为 user 消息并 continue；`stop_hook_active` 守卫**每轮限一次**防死循环。
- **优先级合并**：`deny > ask > allow`；任一 blocking 即 block；`updatedInput`/`updatedOutput` 取配置序最后一个非空。
- **容错铁律**：hook 报错/超时/不存在 → 非阻断（除非 exit 2/decision:block）；引擎绝不因 hook 自身故障崩主流程。
- **零开销**：未配置某事件 → `runHooks` 立即返回，无 spawn/无 LLM 调用。
- **block 通道 vs permission 通道（①a 终审 I-1 决策）**：deepcode 把 `decision:'block'`/exit 2 映射为 `HookResult.outcome='blocking'`（独立 block 通道），CC 则映射为 `permissionBehavior='deny'`（并入 permission 优先级合并）。`mergeResults` 里 `block = (blocking || permissionDecision==='deny')`，故工具事件两者阻断结果一致。**①b 落 Stop/SubagentStop「block→续跑」时，dispatch 方须显式读 `preventContinuation`/`stop` 而非 `block`**，避免 `HookOutcome.block` 语义重载（既表"阻断工具"又表"续跑信号"）踩坑。`once:true` 字段已在类型中但引擎暂未消费，①b/①d 接 SessionStart/async 时补"从快照移除"逻辑。

---

## 7. 测试策略

- **纯函数**（matchesMatcher/matchQueryFor/evalIfCondition/parseHookStdout/mergeResults/isAsyncFirstLine）：全单测，含边界（空 matcher、非法正则、exit 2、非 JSON stdout、deny>ask>allow 合并、updatedInput 顺序）。
- **runHooks**：注入假 spawn/llm/fetch（仿 `tools.bash.test.ts` 的 spawnMock），测 4 类型分派、并行、async backgrounded、if 过滤、零开销短路。
- **集成**：execCall 的 Pre/Post（deny 阻断、updatedInput 重校验、allow 跳过 ask、updatedOutput）；runLoop 的 Stop block→续跑 + 守卫；agent.ts 的 SubagentStop；各 dispatch 点 smoke 级 1 例。
- **闸门**：每子阶段入 main 前全量 `npm test`+`typecheck`+`build` 全绿；①a/①b/①c/①d 纯逻辑免冒烟，**①e 碰 TUI → 用户真机冒烟**。架构段（①a）末加 **opus 全量终审**。

---

## 8. YAGNI（对齐 CC 但本件确不做的——非品味，是依赖/价值）

- 6 个缺依赖事件的 dispatch（常量已入枚举，子系统落地接）。
- CC 的 workspace trust 对话框（deepcode 无插件信任模型）。
- HTTP hook 的 SSRF 守卫/沙箱代理（deepcode 单机，保留 env 白名单+header 消毒）。
- defer/collapse UI（小 TUI 不需要，保留计数防闪烁）。
- prompt/agent hook 的 50 回合上限 → 降到 10/agent、prompt 单轮。
