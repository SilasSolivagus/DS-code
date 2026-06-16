# L-042 ①b-2 会话/记录事件 Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 L-042 hooks 系统接入 9 个「会话/记录类」事件的 dispatch（SessionStart / SessionEnd / Setup / TaskCreated / TaskCompleted / Notification / ConfigChange / CwdChanged / InstructionsLoaded），对齐 CC 语义。

**Architecture:** 纯 dispatch 接线，复用 ①a 引擎（`runHooks`）与 ①b-1 枢纽（`ctx.hookDispatch`）。三条既定通道按 ①b-1 规则：loop 层用 `deps.hooks`、工具层用 `ctx.hookDispatch`、useChat/headless 顶层用 `settings.hooks`，每站点 `if (...hooks)` 守卫保零开销。`matchQueryFor` 已支持全部 9 事件的 matcher 字段（hooks.ts 无需改）。本件**不含** `DEEPCODE_ENV_FILE` env-file 机制——拆到独立 ①b-3（含引擎改造 + bash.ts 前缀注入）。SessionStart/CwdChanged 本件只接 context 注入与事件触发，env 写入留 ①b-3。

**Tech Stack:** TypeScript / ESM / vitest。dispatch 点：`src/tui/useChat.ts`、`src/headless.ts`、`src/config.ts`、`src/tools/bash.ts`、`src/tools/agent.ts`、`src/tools/types.ts`、`src/session.ts`。

**前置事实（已读代码确认）：**
- `runHooks(event, payload, config, deps?)` 返回 `HookOutcome`（`hooks.ts:196`）；未配该事件→零开销空 outcome。
- `matchQueryFor`（`hooks.ts:76`）已映射：SessionStart/ConfigChange→`source`、Setup→`trigger`、Notification→`notification_type`、SessionEnd→`reason`、InstructionsLoaded→`load_reason`；TaskCreated/TaskCompleted/CwdChanged→`undefined`（恒匹配）。**本件无需改 hooks.ts。**
- `ToolContext.hookDispatch?`（`tools/types.ts:20`）仅主会话/headless 顶层 ctx 注入；子代理 subCtx 不注入（`agent.ts:78`）。工具层事件经此发，子代理内静默。
- useChat ctx 注入 `hookDispatch`（`useChat.ts:210`）；headless 同（`headless.ts:39`）。useChat 自有事件（UPS/PreCompact/PostCompact）用 `settings.hooks` 直发（`useChat.ts:364`、`327`、`343`）。
- `chatStream(client, { messages, ... })`（`loop.ts:139`）——注入测试可查 `chatStream.mock.calls.at(-1)[1].messages`。
- useChat 测试 harness：`test/useChat.hooks.test.ts` mock `runHooks`（记 `hookCalls`、可设 `hookImpl`）、mock `config.loadSettings` 注入非空 `hooks`、mock `api.chatStream`（脚本化 `script`）。新增 useChat 测试沿用之。

**三处判断点（需 design-review 确认；已选默认并注明理由）：**
1. **Notification 映射**：CC 的 Notification = 用户注意力提醒（权限/空闲）。deepcode 选 useChat `ask()`（权限弹窗浮现时）发 `notification_type='permission'`——真·"deepcode 需要你"时刻，且与 PermissionRequest（①b-1，程序化拦截）语义不同。
2. **Setup 触发点**：`config.ts saveApiKey` 后发 `trigger='init'`——首跑向导写 key 即 Setup 完成（memory 接线图钦定点）。可测。缺点：改 key（维护）也按 init 发，暂不区分。
3. **ConfigChange 触发点**：只在 useChat 两处 `saveSettings` 调用站发（saveRule、/permissions rm），`source='permissions'`。不改 `saveSettings` 本体（memory 警告勿 async 化低层）。`/model`//think`//accept` 走 `appendMeta` 不算 ConfigChange。

---

## Task 1: 地基——`sessionIdFromFile` helper + `ctx.sessionId` getter

会话级事件 payload 的 `session_id`，以及 ①b-3 env-file 目录键。落盘文件 basename 去 `.jsonl`。getter 形式（session 在 ctx 构造后才赋值、且 resume/clear 会换 session）。

**Files:**
- Modify: `src/session.ts`（加 `sessionIdFromFile`）
- Modify: `src/tools/types.ts:6-21`（`ToolContext` 加 `sessionId?`）
- Modify: `src/tui/useChat.ts:203-211`（ctx 加 sessionId getter）
- Modify: `src/headless.ts:33-40`（ctx 加 sessionId getter，生成 id）
- Test: `test/session.test.ts`（已存在则追加；否则新建）

- [ ] **Step 1: 写失败测试**

追加到 `test/session.test.ts`（若无此文件则新建，顶部 `import { describe, it, expect } from 'vitest'`）：

```ts
import { sessionIdFromFile } from '../src/session.js'

describe('sessionIdFromFile', () => {
  it('取 basename 去 .jsonl 后缀', () => {
    expect(sessionIdFromFile('/home/u/.deepcode/sessions/2026-06-16T01-02-03-abc.jsonl')).toBe('2026-06-16T01-02-03-abc')
  })
  it('无目录无扩展名时原样返回 basename', () => {
    expect(sessionIdFromFile('plain')).toBe('plain')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/session.test.ts -t sessionIdFromFile`
Expected: FAIL（`sessionIdFromFile` is not a function / 无导出）

- [ ] **Step 3: 实现**

`src/session.ts`（`newSession` 上方，紧跟现有 import 区；文件已 `import path from 'node:path'`）：

```ts
/** 会话文件路径 → 会话 ID（basename 去 .jsonl）。会话级 hook payload 的 session_id；①b-3 env-file 目录键。 */
export function sessionIdFromFile(file: string): string {
  return path.basename(file).replace(/\.jsonl$/, '')
}
```

`src/tools/types.ts`，在 `hookDispatch?` 字段之后（`types.ts:20` 后）加：

```ts
  /** 会话 ID（落盘文件 basename）。会话级事件 payload 的 session_id；①b-3 env-file 目录键。
   *  主会话/headless 顶层 ctx 注入；子代理子 ctx 不注入。getter 形式：resume/clear 换 session 后随之更新。 */
  sessionId?: () => string | undefined
```

`src/tui/useChat.ts`，ctx 对象（`useChat.ts:203-211`）加一行（在 `hookDispatch` 后）。先在文件顶部 import 区把 `session.ts` 的导入补上 `sessionIdFromFile`（`useChat.ts:26` 已 `import { newSession, openSession, listSessions, loadSession, type SessionHandle, type UsageRecord } from '../session.js'` → 加 `sessionIdFromFile`）：

```ts
    hookDispatch: (event, payload) => runHooks(event, payload, settings.hooks),
    sessionId: () => (session ? sessionIdFromFile(session.file) : undefined),
```

`src/headless.ts`，顶部加 `import crypto from 'node:crypto'`；ctx（`headless.ts:33-40`）加 sessionId getter（headless 无落盘会话，生成进程内唯一 id，供 ①b-3 env 目录隔离）：

```ts
  const sessionId = 'headless-' + crypto.randomBytes(4).toString('hex')
  const ctx: ToolContext = {
    cwd: () => cwd,
    setCwd: d => { cwd = d },
    signal: new AbortController().signal,
    fileState: new Map(),
    todos,
    hookDispatch: (event, payload) => runHooks(event, payload, settings.hooks),
    sessionId: () => sessionId,
  }
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run test/session.test.ts && npm run typecheck`
Expected: PASS；typecheck 干净（`crypto` 无 Math.random，符合工作流约束）

- [ ] **Step 5: Commit**

```bash
git add src/session.ts src/tools/types.ts src/tui/useChat.ts src/headless.ts test/session.test.ts
git commit -m "feat(hooks): ctx.sessionId getter + sessionIdFromFile (L-042 ①b-2)"
```

---

## Task 2: SessionStart 事件

会话开始时触发，可注入 `additionalContext`（进首条消息上下文）+ `systemMessage`（notice）。source：新会话=`startup`、`--continue`/resume=`resume`、`/clear`=`clear`。useChat 构造是同步的，故 fire-and-forget + `pendingSessionContext` 缓冲，于下一次 runTurn 起始 flush（保证落在用户消息之前）。headless 是 async，直接 await 注入。

**Files:**
- Modify: `src/tui/useChat.ts`（fireSessionStart + pendingSessionContext flush + 4 个触发点）
- Modify: `src/headless.ts`（await SessionStart 注入）
- Test: `test/useChat.hooks.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `test/useChat.hooks.test.ts`：

```ts
import { chatStream } from '../src/api.js'

describe('useChat SessionStart hook', () => {
  it('新会话 → SessionStart(source=startup) 触发', async () => {
    createChatCore({ client: {} as any, yolo: true, cwd: process.cwd(), sessionDir, onState: () => {} })
    await Promise.resolve() // 等 fire-and-forget 的 .then 微任务落定
    const ss = hookCalls.find(c => c.event === 'SessionStart')
    expect(ss).toBeTruthy()
    expect(ss!.payload.source).toBe('startup')
  })

  it('--continue 恢复 → SessionStart(source=resume) 触发', async () => {
    // 先建一个会话文件落到 sessionDir
    createChatCore({ client: {} as any, yolo: true, cwd: process.cwd(), sessionDir, onState: () => {} })
    hookCalls.length = 0
    createChatCore({ client: {} as any, yolo: true, cwd: process.cwd(), continueSession: true, sessionDir, onState: () => {} })
    await Promise.resolve()
    const ss = hookCalls.find(c => c.event === 'SessionStart')
    expect(ss).toBeTruthy()
    expect(ss!.payload.source).toBe('resume')
  })

  it('additionalContext → 注入到下一轮发送的 messages', async () => {
    hookImpl = (event) => event === 'SessionStart'
      ? { ...emptyOutcome, additionalContext: '项目使用 pnpm' }
      : emptyOutcome
    script.push({ result: { content: '答', toolCalls: [], usage, finishReason: 'stop' } })
    const core = createChatCore({ client: {} as any, yolo: true, cwd: process.cwd(), sessionDir, onState: () => {} })
    await Promise.resolve()
    await core.send('你好')
    const sent = (chatStream as any).mock.calls.at(-1)[1].messages as any[]
    expect(JSON.stringify(sent)).toContain('项目使用 pnpm')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/useChat.hooks.test.ts -t SessionStart`
Expected: FAIL（无 SessionStart 调用 / messages 不含注入文本）

- [ ] **Step 3: 实现 useChat**

在 `createChatCore` 内、`runTurn` 定义之前（`useChat.ts:360` 前）加缓冲与触发器：

```ts
  // —— SessionStart：会话开始事件。构造同步 → fire-and-forget；additionalContext 缓冲到下一轮 runTurn 起始 flush。 ——
  let pendingSessionContext: string | null = null
  const fireSessionStart = (source: 'startup' | 'resume' | 'clear'): void => {
    if (!settings.hooks) return
    void runHooks('SessionStart', {
      hook_event_name: 'SessionStart', cwd, session_id: ctx.sessionId?.(), source,
    }, settings.hooks).then(out => {
      if (out.additionalContext) {
        pendingSessionContext = pendingSessionContext ? `${pendingSessionContext}\n\n${out.additionalContext}` : out.additionalContext
      }
      if (out.systemMessage) notice('info', out.systemMessage)
    }).catch(() => { /* SessionStart hook 失败不影响会话启动 */ })
  }
```

在 `runTurn` 内、UserPromptSubmit 块之后（`useChat.ts:374` 后、`busy = true` 之前）插入 flush：

```ts
    // SessionStart 注入的上下文（若有）于本轮起始一次性并入用户文本（落在用户消息之前）。
    if (pendingSessionContext) {
      userText = `<hook-context>\n${pendingSessionContext}\n</hook-context>\n\n${userText}`
      pendingSessionContext = null
    }
```

在 4 个会话起点接 `fireSessionStart`：
- 新会话 else 分支（`useChat.ts:292-296`），`checkpointer = ...` 后加 `fireSessionStart('startup')`。
- 恢复分支（`useChat.ts:289-291`），`notice('info', ...)` 后加 `fireSessionStart('resume')`。
- `/clear`（`useChat.ts:569-582`），`notice('info', '对话已清空...')` 前（`nextTurnId = 1` 后）加 `fireSessionStart('clear')`。
- `resume(file)` 方法（`useChat.ts:683-688`），`notice('info', \`已恢复会话...\`)` 后加 `fireSessionStart('resume')`。

- [ ] **Step 4: 实现 headless**

`src/headless.ts`，把 messages 构造（`headless.ts:59-62`）改为先收集 system + SessionStart 注入，再 UPS，再 user。替换 `headless.ts:49-62` 段为：

```ts
  // SessionStart：会话开始（headless 恒 startup）。await 注入 additionalContext 到初始上下文。
  const initMsgs: any[] = [{ role: 'system', content: buildSystemPrompt(cwd) }]
  if (settings.hooks) {
    const ss = await runHooks('SessionStart', {
      hook_event_name: 'SessionStart', cwd, session_id: ctx.sessionId?.(), source: 'startup',
    }, settings.hooks)
    if (ss.additionalContext) initMsgs.push({ role: 'user', content: `<hook-context>\n${ss.additionalContext}\n</hook-context>` })
    if (ss.systemMessage) process.stderr.write(ss.systemMessage + '\n')
  }
  let promptText = opts.prompt
  if (settings.hooks) {
    const ups = await runHooks('UserPromptSubmit', {
      hook_event_name: 'UserPromptSubmit', cwd, prompt: opts.prompt,
    }, settings.hooks)
    if (ups.block || ups.preventContinuation) {
      return { text: `输入被 hook 拦截：${ups.blockReason ?? ''}`, status: 'aborted', turns: 0, usage: total, costUSD: 0 }
    }
    if (ups.additionalContext) promptText = `${opts.prompt}\n\n<hook-context>\n${ups.additionalContext}\n</hook-context>`
  }
  const messages: any[] = [...initMsgs, { role: 'user', content: promptText }]
```

（删掉原 `headless.ts:59-62` 的旧 `const messages` 定义——已并入上面。）

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/useChat.hooks.test.ts -t SessionStart`
Expected: PASS（3 例）

- [ ] **Step 6: Commit**

```bash
git add src/tui/useChat.ts src/headless.ts test/useChat.hooks.test.ts
git commit -m "feat(hooks): SessionStart dispatch + context injection (L-042 ①b-2)"
```

---

## Task 3: SessionEnd 事件

会话结束时触发（记录/清理脚本用）。可靠且免 TUI 冒烟的触发点：`/clear`（旧会话结束，reason=`clear`）与 `dispose()`（reason=`exit`）。硬退出（process.exit）的 SessionEnd 因 async hook 无法 flush，对齐 CC 亦为尽力而为——本件不接 process 信号（留 ①e TUI 接 App unmount→dispose）。

**Files:**
- Modify: `src/tui/useChat.ts`（/clear 与 dispose 接 SessionEnd）
- Test: `test/useChat.hooks.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
describe('useChat SessionEnd hook', () => {
  it('/clear → SessionEnd(reason=clear) 在新会话 SessionStart 之前触发', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: process.cwd(), sessionDir, onState: () => {} })
    await Promise.resolve()
    hookCalls.length = 0
    await core.send('/clear')
    await Promise.resolve()
    const end = hookCalls.find(c => c.event === 'SessionEnd')
    const start = hookCalls.find(c => c.event === 'SessionStart')
    expect(end).toBeTruthy()
    expect(end!.payload.reason).toBe('clear')
    expect(start!.payload.source).toBe('clear')
  })

  it('dispose() → SessionEnd(reason=exit) 触发', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: process.cwd(), sessionDir, onState: () => {} })
    await Promise.resolve()
    hookCalls.length = 0
    core.dispose()
    await Promise.resolve()
    const end = hookCalls.find(c => c.event === 'SessionEnd')
    expect(end).toBeTruthy()
    expect(end!.payload.reason).toBe('exit')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/useChat.hooks.test.ts -t SessionEnd`
Expected: FAIL

- [ ] **Step 3: 实现**

在 `fireSessionStart` 下方加 `fireSessionEnd`（`useChat.ts`，Task 2 加的代码块附近）：

```ts
  const fireSessionEnd = (reason: 'clear' | 'exit'): void => {
    if (!settings.hooks) return
    void runHooks('SessionEnd', {
      hook_event_name: 'SessionEnd', cwd, session_id: ctx.sessionId?.(), reason,
    }, settings.hooks).catch(() => { /* SessionEnd hook 失败不阻断退出/清空 */ })
  }
```

`/clear`（`useChat.ts:569`）分支最前面（`messages.length = 1` 之前）加 `fireSessionEnd('clear')`——旧会话先结束，再清空、再（Task 2 的）`fireSessionStart('clear')`。

`dispose()`（`useChat.ts:734`）改为：

```ts
    dispose: () => { fireSessionEnd('exit'); unsubNotification() },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/useChat.hooks.test.ts -t SessionEnd`
Expected: PASS（2 例）

- [ ] **Step 5: Commit**

```bash
git add src/tui/useChat.ts test/useChat.hooks.test.ts
git commit -m "feat(hooks): SessionEnd on /clear and dispose (L-042 ①b-2)"
```

---

## Task 4: Setup 事件

首跑向导写 API key 后触发（`trigger='init'`），用于初始化脚本。dispatch 点 `config.ts saveApiKey`（memory 接线图钦定）。`saveApiKey` 保持同步，`void runHooks(...)` fire-and-forget，hooks 取自 `loadSettings().hooks`。

**Files:**
- Modify: `src/config.ts`（saveApiKey 末尾发 Setup）
- Test: `test/config.test.ts`（已存在则追加；否则新建）

- [ ] **Step 1: 写失败测试**

`test/config.test.ts` 追加（用 vi.mock 拦 `runHooks`，避免真 spawn；用 tmp HOME 隔离落盘）：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const hookCalls: Array<{ event: string; payload: any }> = []
vi.mock('../src/hooks.js', async orig => ({
  ...(await orig() as any),
  runHooks: vi.fn(async (event: string, payload: any) => { hookCalls.push({ event, payload }); return { block: false, preventContinuation: false, stop: false, results: [] } }),
}))

describe('saveApiKey Setup hook', () => {
  beforeEach(() => { hookCalls.length = 0; process.env.HOME = mkdtempSync(path.join(tmpdir(), 'deepcode-cfg-')) })
  it('写 key → Setup(trigger=init) 触发', async () => {
    const { saveApiKey, saveSettings } = await import('../src/config.js')
    // 预置带 hooks 的 settings，使 saveApiKey 读到非空 hooks 快照
    saveSettings({ permissions: { allow: [] }, compactTokens: 200000, costWarnUSD: 2, hooks: { Setup: [{ hooks: [{ type: 'command', command: 'true' }] }] } } as any)
    saveApiKey('sk-test')
    await Promise.resolve()
    const setup = hookCalls.find(c => c.event === 'Setup')
    expect(setup).toBeTruthy()
    expect(setup!.payload.trigger).toBe('init')
  })
})
```

> 注：`config.ts` 用 `os.homedir()` 算路径——若该实现不读 `process.env.HOME`，测试改为构造时注入或跳过落盘断言，仅断言 hookCalls。实现者据 `config.ts` 实际 HOME 解析方式定（`DIR = path.join(os.homedir(), '.deepcode')`，`os.homedir()` 在多数平台读 `$HOME`，macOS/linux 成立）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/config.test.ts -t Setup`
Expected: FAIL（无 Setup 调用）

- [ ] **Step 3: 实现**

`src/config.ts` 顶部 import 补 `runHooks`（`config.ts:5` 已 `import { HOOK_EVENTS, type HooksConfig, type HookEvent } from './hooks.js'` → 加 `runHooks`）。`saveApiKey`（`config.ts:81-86`）末尾加：

```ts
export function saveApiKey(key: string): void {
  const s = loadSettings()
  s.apiKey = key || undefined
  saveSettings(s)
  try { fs.chmodSync(FILE, 0o600) } catch { /* 尽力而为 */ }
  // Setup hook：首跑向导写 key 即初始化完成。fire-and-forget，hook 故障不阻断。
  if (s.hooks) void runHooks('Setup', { hook_event_name: 'Setup', cwd: process.cwd(), trigger: 'init' }, s.hooks).catch(() => {})
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(hooks): Setup on saveApiKey (L-042 ①b-2)"
```

---

## Task 5: TaskCreated + TaskCompleted 事件

后台任务注册/完成时经 `ctx.hookDispatch` 发（工具层事件）。注册点：`bash.ts` 与 `agent.ts` 的 `registerTask` 后（TaskCreated，payload `task_id`/`task_description`）。完成点：`bash.ts` 的 `child.once('exit')` 与 `agent.ts` 后台 `void async` 的 `updateTask(...completed/failed/killed)` 后（TaskCompleted，payload `task_id`/`status`）。子代理 subCtx 无 hookDispatch→静默（守卫 `if (ctx.hookDispatch)`）。fire-and-forget（记录类，不阻塞任务流）。

**Files:**
- Modify: `src/tools/bash.ts`（registerTask 后 + exit 回调内）
- Modify: `src/tools/agent.ts`（registerTask 后 + async 完成内）
- Test: `test/tools.bash.test.ts`（已存在则追加）、`test/agent.test.ts`

- [ ] **Step 1: 写失败测试（bash）**

`test/tools.bash.test.ts` 追加（构造带 `hookDispatch` spy 的假 ctx，调 `bashTool.call` run_in_background）：

```ts
import { vi } from 'vitest'
import { bashTool } from '../src/tools/bash.js'

function fakeCtx(dispatch: any) {
  return { cwd: () => process.cwd(), setCwd: () => {}, signal: new AbortController().signal, fileState: new Map(), hookDispatch: dispatch }
}

describe('bash TaskCreated/TaskCompleted hooks', () => {
  it('run_in_background → TaskCreated 立即发，命令结束后 TaskCompleted', async () => {
    const events: Array<{ event: string; payload: any }> = []
    const dispatch = vi.fn(async (event: string, payload: any) => { events.push({ event, payload }); return { block: false, preventContinuation: false, stop: false, results: [] } })
    await bashTool.call({ command: 'true' } as any, fakeCtx(dispatch) as any) // run_in_background 缺省下不发 task 事件
    const created = await bashTool.call({ command: 'echo hi', run_in_background: true } as any, fakeCtx(dispatch) as any)
    expect(created).toContain('后台任务已启动')
    expect(events.find(e => e.event === 'TaskCreated')).toBeTruthy()
    // 等后台 exit 回调
    await vi.waitFor(() => expect(events.find(e => e.event === 'TaskCompleted')).toBeTruthy())
    const done = events.find(e => e.event === 'TaskCompleted')!
    expect(done.payload.status).toBe('completed')
  })

  it('子代理 ctx（无 hookDispatch）→ 不发 task 事件、不崩', async () => {
    const ctx = { cwd: () => process.cwd(), setCwd: () => {}, signal: new AbortController().signal, fileState: new Map(), isSubagent: true }
    // 子代理 run_in_background 降级前台同步执行；不应抛
    await expect(bashTool.call({ command: 'echo x', run_in_background: true } as any, ctx as any)).resolves.toBeTruthy()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/tools.bash.test.ts -t TaskCreated`
Expected: FAIL（无 TaskCreated/TaskCompleted）

- [ ] **Step 3: 实现 bash.ts**

`src/tools/bash.ts` 后台分支：`registerTask({...})`（`bash.ts:43-54`）之后、`child.once('exit', ...)` 之前加 TaskCreated：

```ts
      ctx.hookDispatch?.('TaskCreated', { hook_event_name: 'TaskCreated', task_id: id, task_description: input.command }).catch(() => {})
```

`child.once('exit', code => {...})` 回调内（`bash.ts:55-62`），`enqueueNotification(getTask(id)!)` 之后加 TaskCompleted：

```ts
      child.once('exit', code => {
        ws.end()
        const t = getTask(id)
        if (t && t.status === 'killed') {
          ctx.hookDispatch?.('TaskCompleted', { hook_event_name: 'TaskCompleted', task_id: id, status: 'killed' }).catch(() => {})
          return
        }
        updateTask(id, { status: code === 0 ? 'completed' : 'failed', endTime: Date.now() })
        enqueueNotification(getTask(id)!)
        ctx.hookDispatch?.('TaskCompleted', { hook_event_name: 'TaskCompleted', task_id: id, status: getTask(id)!.status }).catch(() => {})
      })
```

- [ ] **Step 4: 写失败测试 + 实现 agent.ts**

`test/agent.test.ts` 追加一例（后台 Agent，注入带 hookDispatch 的 ctx，断言 TaskCreated/TaskCompleted；沿用该文件既有 makeAgentTool mock 套路）：

```ts
describe('agent TaskCreated/TaskCompleted hooks', () => {
  it('后台子代理 → TaskCreated 发，完成后 TaskCompleted(status)', async () => {
    const events: Array<{ event: string; payload: any }> = []
    const dispatch = vi.fn(async (event: string, payload: any) => { events.push({ event, payload }); return { block: false, preventContinuation: false, stop: false, results: [] } })
    // makeAgentTool 用既有测试 client/onUsage mock（见本文件顶部 helper）；ctx 注入 hookDispatch + sessionId
    const ctx = { cwd: () => process.cwd(), setCwd: () => {}, get signal() { return new AbortController().signal }, fileState: new Map(), hookDispatch: dispatch, sessionId: () => 's1' }
    const tool = makeAgentTool({ client: fakeClient as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const r = await tool.call({ description: 'd', prompt: 'p', run_in_background: true } as any, ctx as any)
    expect(r).toContain('后台子代理已启动')
    expect(events.find(e => e.event === 'TaskCreated')).toBeTruthy()
    await vi.waitFor(() => expect(events.find(e => e.event === 'TaskCompleted')).toBeTruthy())
  })
})
```

> 实现者：`fakeClient` 复用 `test/agent.test.ts` 既有的 OpenAI mock（让子代理子循环单轮即结束）。若该文件无现成 client mock，参照 `test/useChat.hooks.test.ts` 的 `api.chatStream` mock 方式注入单轮 `finishReason:'stop'`。

`src/tools/agent.ts` 后台分支：`registerTask({...})`（`agent.ts:126-131`）之后加 TaskCreated：

```ts
        ctx.hookDispatch?.('TaskCreated', { hook_event_name: 'TaskCreated', task_id: id, task_description: input.description }).catch(() => {})
```

后台 `void (async () => {...})` 的 `finally`（`agent.ts:146-149`）内，`enqueueNotification(getTask(id)!)` 后加 TaskCompleted（读最终 status）：

```ts
          } finally {
            enqueueNotification(getTask(id)!)
            ctx.hookDispatch?.('TaskCompleted', { hook_event_name: 'TaskCompleted', task_id: id, status: getTask(id)!.status }).catch(() => {})
            release()
          }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/tools.bash.test.ts test/agent.test.ts -t Task`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/bash.ts src/tools/agent.ts test/tools.bash.test.ts test/agent.test.ts
git commit -m "feat(hooks): TaskCreated/TaskCompleted via ctx.hookDispatch (L-042 ①b-2)"
```

---

## Task 6: Notification 事件

用户注意力提醒。映射：useChat `ask()`（权限弹窗浮现给用户时）发 `notification_type='permission'`、`message`=工具+操作描述。经 `settings.hooks` 直发（useChat 顶层事件），fire-and-forget。

**Files:**
- Modify: `src/tui/useChat.ts`（`ask` 内发 Notification）
- Test: `test/useChat.hooks.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
describe('useChat Notification hook', () => {
  it('权限弹窗浮现 → Notification(notification_type=permission) 触发', async () => {
    // 非 yolo：危险/未放行命令触发 ask；脚本让模型调一次 Bash
    script.push({ result: { content: '', toolCalls: [{ id: 't1', name: 'Bash', args: JSON.stringify({ command: 'echo hi' }) }], usage, finishReason: 'tool_calls' } })
    const core = createChatCore({ client: {} as any, yolo: false, cwd: process.cwd(), sessionDir, onState: () => {} })
    await Promise.resolve()
    hookCalls.length = 0
    const p = core.send('跑个命令')
    // ask 挂起后 pendingAsk 出现；这里直接断言 Notification 已发，再放行解锁
    await vi.waitFor(() => expect(hookCalls.find(c => c.event === 'Notification')).toBeTruthy())
    const n = hookCalls.find(c => c.event === 'Notification')!
    expect(n.payload.notification_type).toBe('permission')
    core.resolveAsk('no')
    await p
  })
})
```

> 实现者：若该 Bash 在 default 模式被既有规则自动放行而不弹 ask，测试改用确定触发 ask 的命令（无放行规则的任意命令在 default 模式下应弹 ask）。断言核心是 Notification 发出 + type=permission。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/useChat.hooks.test.ts -t Notification`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/tui/useChat.ts` 的 `ask`（`useChat.ts:354-358`）改为发 Notification：

```ts
  const ask = (toolName: string, desc: string): Promise<Decision> =>
    new Promise<Decision>(res => {
      // Notification hook：权限弹窗浮现给用户时通知（桌面通知转发等）。fire-and-forget。
      if (settings.hooks) {
        void runHooks('Notification', {
          hook_event_name: 'Notification', cwd, session_id: ctx.sessionId?.(),
          notification_type: 'permission', title: 'deepcode 需要确认', message: `${toolName}: ${desc}`,
        }, settings.hooks).catch(() => {})
      }
      pendingAsk = { toolName, desc, dangerous: isDangerous(desc), resolve: res }
      setState()
    })
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/useChat.hooks.test.ts -t Notification`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/useChat.ts test/useChat.hooks.test.ts
git commit -m "feat(hooks): Notification on permission prompt (L-042 ①b-2)"
```

---

## Task 7: ConfigChange 事件

会话内改配置时记录。dispatch 点：useChat 两处 `saveSettings`——saveRule 回调（`useChat.ts:418`）与 `/permissions rm`（`useChat.ts:628`），`source='permissions'`、`file_path` 为 settings.json 路径。经 `settings.hooks` 直发，fire-and-forget。不改 `saveSettings` 本体。

**Files:**
- Modify: `src/tui/useChat.ts`（两处 saveSettings 后发 ConfigChange）
- Modify: `src/config.ts`（导出 settings 文件路径常量供 payload；或 useChat 内联同路径）
- Test: `test/useChat.hooks.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
describe('useChat ConfigChange hook', () => {
  it('/permissions rm → ConfigChange(source=permissions) 触发', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: process.cwd(), sessionDir, onState: () => {} })
    await Promise.resolve()
    hookCalls.length = 0
    await core.send('/permissions rm 1') // 即便编号无效也只是不删；有效则触发。下方用 saveRule 路径更稳。
    // saveRule 路径：权限确认选 always 会 push+saveSettings。这里直接断言：至少在删成功路径触发。
    // 若 allow 为空导致未触发，改测 saveRule（见实现备注）。
    expect(hookCalls.filter(c => c.event === 'ConfigChange').length >= 0).toBe(true)
  })
})
```

> 实现者：更稳的断言走 saveRule——构造一次权限确认返回 `'always'`，触发 `saveRule`→`saveSettings`→ConfigChange。按 `test/permissions.test.ts`/既有 ask 解析方式驱动。核心断言：`ConfigChange` 事件发出且 `payload.source==='permissions'`。把上面占位断言替换为真实触发后的 `expect(hookCalls.find(c=>c.event==='ConfigChange')!.payload.source).toBe('permissions')`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/useChat.hooks.test.ts -t ConfigChange`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/config.ts` 导出 settings 文件路径（`config.ts:26` 的 `FILE` 当前未导出）：

```ts
export const SETTINGS_FILE = FILE
```

`src/tui/useChat.ts` import 区（`useChat.ts:22`）加 `SETTINGS_FILE`：`import { loadSettings, saveSettings, SETTINGS_FILE } from '../config.js'`。

加一个本地 helper（在 fireSessionStart 附近）：

```ts
  const fireConfigChange = (): void => {
    if (!settings.hooks) return
    void runHooks('ConfigChange', {
      hook_event_name: 'ConfigChange', cwd, session_id: ctx.sessionId?.(),
      source: 'permissions', file_path: SETTINGS_FILE,
    }, settings.hooks).catch(() => {})
  }
```

两处 saveSettings 后接 `fireConfigChange()`：
- saveRule 回调（`useChat.ts:418`）：`saveRule: r => { settings.permissions.allow.push(r); saveSettings(settings); fireConfigChange() },`
- `/permissions rm` 成功分支（`useChat.ts:627`）：`saveSettings(settings)` 后加 `fireConfigChange()`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/useChat.hooks.test.ts -t ConfigChange`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/tui/useChat.ts test/useChat.hooks.test.ts
git commit -m "feat(hooks): ConfigChange on permission saves (L-042 ①b-2)"
```

---

## Task 8: CwdChanged 事件

工作目录变更时经 `ctx.hookDispatch` 发（工具层）。dispatch 点：`bash.ts` 前台路径解析出 newCwd 且与旧 cwd 不同时（`bash.ts:84` `ctx.setCwd(newCwd)` 处）。payload `old_cwd`/`new_cwd`。子代理 subCtx 无 hookDispatch→静默。await（cwd 变更后续命令依赖，但本件不写 env；①b-3 在此失效 env 缓存）。

**Files:**
- Modify: `src/tools/bash.ts`（setCwd 处发 CwdChanged）
- Test: `test/tools.bash.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
describe('bash CwdChanged hook', () => {
  it('cd 改变 cwd → CwdChanged(old/new) 触发', async () => {
    const events: Array<{ event: string; payload: any }> = []
    const dispatch = vi.fn(async (event: string, payload: any) => { events.push({ event, payload }); return { block: false, preventContinuation: false, stop: false, results: [] } })
    let cwd = process.cwd()
    const ctx = { cwd: () => cwd, setCwd: (d: string) => { cwd = d }, signal: new AbortController().signal, fileState: new Map(), hookDispatch: dispatch }
    await bashTool.call({ command: 'cd /tmp' } as any, ctx as any)
    const cc = events.find(e => e.event === 'CwdChanged')
    expect(cc).toBeTruthy()
    expect(cc!.payload.new_cwd).toContain('tmp')
    expect(cc!.payload.old_cwd).not.toBe(cc!.payload.new_cwd)
  })
  it('cwd 未变 → 不发 CwdChanged', async () => {
    const events: string[] = []
    const dispatch = vi.fn(async (event: string) => { events.push(event); return { block: false, preventContinuation: false, stop: false, results: [] } })
    let cwd = process.cwd()
    const ctx = { cwd: () => cwd, setCwd: (d: string) => { cwd = d }, signal: new AbortController().signal, fileState: new Map(), hookDispatch: dispatch }
    await bashTool.call({ command: 'echo hi' } as any, ctx as any)
    expect(events.includes('CwdChanged')).toBe(false)
  })
})
```

> 真跑 `/bin/bash`（与既有 bash 测试一致）。`/tmp` 在 macOS 是 symlink 到 `/private/tmp`，故断言用 `toContain('tmp')` 而非精确等值。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/tools.bash.test.ts -t CwdChanged`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/tools/bash.ts` 前台 execFile 回调（`bash.ts:84`）的 `if (newCwd) ctx.setCwd(newCwd)` 改为先捕获旧值、变更后发事件。该回调当前非 async——把 `(err, stdout, stderr) => {...}` 改为 `async (err, stdout, stderr) => {...}` 不可行（execFile 回调签名固定但允许返回 Promise 被忽略；hook 发射 fire-and-forget 即可，无需 await 回调）。最小改法：

```ts
            if (newCwd && newCwd !== ctx.cwd()) {
              const oldCwd = ctx.cwd()
              ctx.setCwd(newCwd)
              ctx.hookDispatch?.('CwdChanged', { hook_event_name: 'CwdChanged', old_cwd: oldCwd, new_cwd: newCwd }).catch(() => {})
            } else if (newCwd) {
              ctx.setCwd(newCwd)
            }
```

（替换 `bash.ts:84` 单行 `if (newCwd) ctx.setCwd(newCwd)`。fire-and-forget——CwdChanged 本件纯记录；①b-3 会改为在此 await 写 env + 失效缓存。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/tools.bash.test.ts -t CwdChanged`
Expected: PASS（2 例）

- [ ] **Step 5: Commit**

```bash
git add src/tools/bash.ts test/tools.bash.test.ts
git commit -m "feat(hooks): CwdChanged on bash cd (L-042 ①b-2)"
```

---

## Task 9: InstructionsLoaded 事件

记忆文件（DEEPCODE.md/CLAUDE.md/AGENTS.md/全局）加载后记录。不 async 化 `buildSystemPrompt`（memory 警告）——改在 useChat/headless 构造系统提示后，用 `findMemoryFiles(cwd)` 列表逐文件发 InstructionsLoaded。payload `file_path`/`memory_type`/`load_reason='startup'`。`memory_type`：全局 `~/.deepcode/DEEPCODE.md`→`user`，其余→`project`。经 `settings.hooks`，fire-and-forget。

**Files:**
- Modify: `src/tui/useChat.ts`（构造后发 InstructionsLoaded）
- Modify: `src/headless.ts`（同）
- Test: `test/useChat.hooks.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
describe('useChat InstructionsLoaded hook', () => {
  it('启动加载记忆文件 → 每文件发 InstructionsLoaded(load_reason=startup)', async () => {
    // 在 cwd 放一个 DEEPCODE.md，确保 findMemoryFiles 命中
    const dir = mkdtempSync(path.join(tmpdir(), 'deepcode-mem-'))
    require('node:fs').writeFileSync(path.join(dir, 'DEEPCODE.md'), '# 测试记忆')
    createChatCore({ client: {} as any, yolo: true, cwd: dir, sessionDir, onState: () => {} })
    await Promise.resolve()
    const il = hookCalls.find(c => c.event === 'InstructionsLoaded')
    expect(il).toBeTruthy()
    expect(il!.payload.load_reason).toBe('startup')
    expect(il!.payload.memory_type).toBe('project')
    expect(il!.payload.file_path).toContain('DEEPCODE.md')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/useChat.hooks.test.ts -t InstructionsLoaded`
Expected: FAIL

- [ ] **Step 3: 实现 useChat**

`src/tui/useChat.ts`，`findMemoryFiles` 已 import（`useChat.ts:20`）。在会话起点设置完成后（新会话/恢复分支之后，`useChat.ts:296` 之后）加：

```ts
  // InstructionsLoaded：记忆文件加载记录（DEEPCODE.md/CLAUDE.md/全局）。fire-and-forget。
  if (settings.hooks) {
    const home = os.homedir()
    const globalMem = path.join(home, '.deepcode', 'DEEPCODE.md')
    for (const f of findMemoryFiles(cwd)) {
      void runHooks('InstructionsLoaded', {
        hook_event_name: 'InstructionsLoaded', cwd, session_id: ctx.sessionId?.(),
        file_path: f, memory_type: f === globalMem ? 'user' : 'project', load_reason: 'startup',
      }, settings.hooks).catch(() => {})
    }
  }
```

- [ ] **Step 4: 实现 headless**

`src/headless.ts` import 区加 `import { buildSystemPrompt } from './prompt.js'` 已有（`headless.ts:10`）→ 改为 `import { buildSystemPrompt, findMemoryFiles } from './prompt.js'`；加 `import os from 'node:os'`、`import path from 'node:path'`。在 SessionStart 块之前（initMsgs 构造后）加同款 InstructionsLoaded 循环（`session_id: ctx.sessionId?.()`，`load_reason:'startup'`）。

- [ ] **Step 5: 跑测试确认通过 + 全量回归**

Run: `npx vitest run test/useChat.hooks.test.ts -t InstructionsLoaded && npm test && npm run typecheck && npm run build`
Expected: 全 PASS、typecheck/build 干净

- [ ] **Step 6: Commit**

```bash
git add src/tui/useChat.ts src/headless.ts test/useChat.hooks.test.ts
git commit -m "feat(hooks): InstructionsLoaded on memory load (L-042 ①b-2)"
```

---

## 完成后

- 全量 `npm test` + `npm run typecheck` + `npm run build` 全绿（纯逻辑，免真机冒烟）。
- 走 `superpowers:subagent-driven-development` 每任务 implementer + 规格审 + 质量审双门；末尾 opus 全量终审（9 事件接线虽简，但跨 useChat/headless/bash/agent/config 多文件，终审查 dispatch 一致性与守卫齐全）。
- 终审过后 `finishing-a-development-branch` 合 main、push origin。
- 更新 memory：①b-2 完成、下一步 ①b-3（env-file 机制）。

## 后续 ①b-3（不在本件，env-file 机制）
SessionStart/CwdChanged 写 `DEEPCODE_ENV_FILE` + bash.ts 命令前缀注入：
- 新模块 `src/sessionEnv.ts`：路径 `~/.deepcode/session-env/{sessionId}/{event}-hook-{i}.sh`；读目录下全部 `.sh` 按优先级 `Setup<SessionStart<CwdChanged<FileChanged` 拼成命令前缀。
- 引擎改造：`HookEngineDeps` 加 `sessionEnvDir?`；`execCommandHook` 注入 `DEEPCODE_ENV_FILE`（per-event/per-index 路径）。
- `bash.ts` 前台/后台执行前读前缀注入；CwdChanged 在 Task 8 的 dispatch 处改 await + 失效缓存。
- 复用本件 `ctx.sessionId`。
```
