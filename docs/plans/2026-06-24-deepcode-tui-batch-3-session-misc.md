# TUI 计划3（会话命令 + 任务依赖 + statusline + hooks 进度）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 CC 第 1-5 层「碰 TUI 件」收官批的剩余 4 件：3.6 /fork+/rename、1.6 Task 依赖图薄片、5.7 /statusline 自定义、1.7 Hooks 进度。

**Architecture:** 逻辑件（taskList 依赖图、hooks onProgress、statusLine 执行/解析/调度、session title/fork 助手）先做、各自纯函数单测；TUI 接线件（Spinner 喂 hook 文案、StatusFooter 加 statusline 段、/fork+/rename 命令）后做，全部攒一次真机冒烟。所有可调度/可执行逻辑下沉到纯模块（`src/statusLine.ts` 的 runner），TUI 只接线。

**Tech Stack:** TypeScript/ESM、ink5 React TUI、vitest、zod、node:child_process。

## Global Constraints

- **对齐 CC 别自创**：本批两个设计点已实读 CC 源码拍板（见 spec 2026-06-24 修订史）：① /fork 共享项目 memdir 不隔离（CC `commands/branch/branch.ts`）；② statusline = 事件驱动 + 300ms 去抖 + 在途 abort + 5s 超时 + 缓存（CC `components/StatusLine.tsx`）。
- **deny 红线不可碰**：本批不触碰 `permissions.ts` 任何 deny 段；statusLineCommand 不走权限判定（用户自设命令，CC 直接 spawn）。
- **双组件接线**：凡改 Spinner/StatusFooter 的 props，必须同步改 `src/tui/App.tsx` 与 `src/tui/FullscreenApp.tsx` 两处（默认全屏跑 FullscreenApp，历史教训 [[deepcode-tui-dual-component]]）。/fork、/rename 是 `send()` 内命令（无 picker），App/FullscreenApp 共享，无需双改。
- **IME 光标行数**：StatusFooter 新增可选行须同步 `App.tsx:207` 与 FullscreenApp 对应的 `linesBelowCaret` 动态计算（每多一可见行 +1）。
- **新增写工具同步 deny**：本批不新增写工具（无需动 `GLOBAL_SUBAGENT_DENY`）。
- **测试隔离**：碰 `~/.deepcode/*` 落盘的测试一律注入临时目录（session 用 `sessionDir`、taskList 用 `bind(sid, tmpBaseDir)`），禁止写真实用户目录。
- **每件入库前**：`npm run typecheck`（或 `npx tsc --noEmit`）+ `npm run build` + 相关测试全绿。
- 提交粒度：每 Task 一次提交，subject 用 `feat:`/`test:`/`refactor:` 中文描述。

---

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/taskList.ts` | Task 模型 + store；加 blocks/blockedBy 字段、依赖门控、软删依赖视同已清 | Modify |
| `src/tools/taskListTools.ts` | TaskUpdate schema 加 addBlocks/addBlockedBy + 门控消息 | Modify |
| `src/hooks.ts` | runHooks 慢阶段 onProgress 回调 | Modify |
| `src/hookRuntime.ts` | makeHookRuntime 透传 onProgress | Modify |
| `src/config.ts` | Settings.statusLineCommand + loadRawUserSettings | Modify |
| `src/settingsLayers.ts` | DANGEROUS_TOP_KEYS + parsePresent 注册 statusLineCommand | Modify |
| `src/statusLine.ts` | **新建**：parseStatusLineStdout（纯）+ execStatusLineCommand（spawn）+ createStatusLineRunner（去抖/abort/缓存调度） | Create |
| `src/session.ts` | SessionMeta.title + appendTitle 记录 + loadSession/listSessions 读 title + nextBranchTitle/stripBranchSuffix 纯助手 | Modify |
| `src/tui/components/Spinner.tsx` | 接收 hookLabel，忙碌时优先显示「正在运行 X 钩子…」 | Modify |
| `src/tui/components/StatusFooter.tsx` | 加 statusLineOutput 段（单行渲染） | Modify |
| `src/tui/useChat.ts` | hookProgress 状态 + statusLine runner 接线 + /fork + /rename 命令 + HELP_TEXT | Modify |
| `src/tui/App.tsx` | Spinner/StatusFooter 双接线 + linesBelowCaret | Modify |
| `src/tui/FullscreenApp.tsx` | 同 App.tsx | Modify |
| `src/tui/suggest.ts` | BUILTIN_COMMANDS 加 /fork /rename | Modify |
| 对应 `test/*.test.ts` | 各件单测 | Create/Modify |

**Task 顺序**：逻辑件 1→6（无 TUI，免冒烟），TUI 接线件 7→9（攒一次真机冒烟）。

---

## Task 1: 1.6 — taskList 依赖图字段 + 门控 + 软删视同已清

**Files:**
- Modify: `src/taskList.ts:6-13`（Task 类型）、`:48-72`（update）、`:30-41`（create 不变但确认）
- Test: `test/taskList.test.ts`

**Interfaces:**
- Produces:
  - `Task` 加 `blocks?: string[]`、`blockedBy?: string[]`
  - `TaskListStore.update(id, patch)`：patch 加 `addBlocks?: string[]`、`addBlockedBy?: string[]`；返回类型改为 `{ ok: boolean; updatedFields: string[]; blockedByOpen?: string[] }`（`blockedByOpen` = 当 status→in_progress 被未完成依赖拦下时，返回未清依赖 id 列表）
  - 新方法 `TaskListStore.openBlockers(id: string): string[]`（返回该任务 blockedBy 中既未 completed 也未软删的 id；供门控与工具复用）

- [ ] **Step 1: 写失败测试**

在 `test/taskList.test.ts` 末尾追加：

```ts
import { describe, it, expect } from 'vitest'
import { TaskListStore } from '../src/taskList.js'

describe('1.6 任务依赖图', () => {
  it('addBlockedBy 加依赖，未完成依赖时拦截 in_progress', () => {
    const s = new TaskListStore()
    const a = s.create({ subject: 'A', description: 'dep' })
    const b = s.create({ subject: 'B', description: 'main' })
    s.update(b.id, { addBlockedBy: [a.id] })
    const blocked = s.update(b.id, { status: 'in_progress' })
    expect(blocked.ok).toBe(false)
    expect(blocked.blockedByOpen).toEqual([a.id])
    expect(s.get(b.id)!.status).toBe('pending') // 未变
  })

  it('依赖完成后可转 in_progress', () => {
    const s = new TaskListStore()
    const a = s.create({ subject: 'A', description: 'dep' })
    const b = s.create({ subject: 'B', description: 'main' })
    s.update(b.id, { addBlockedBy: [a.id] })
    s.update(a.id, { status: 'completed' })
    const ok = s.update(b.id, { status: 'in_progress' })
    expect(ok.ok).toBe(true)
    expect(s.get(b.id)!.status).toBe('in_progress')
  })

  it('软删的依赖视同已清，不永久卡死后继', () => {
    const s = new TaskListStore()
    const a = s.create({ subject: 'A', description: 'dep' })
    const b = s.create({ subject: 'B', description: 'main' })
    s.update(b.id, { addBlockedBy: [a.id] })
    s.update(a.id, { status: 'deleted' }) // 软删依赖
    expect(s.openBlockers(b.id)).toEqual([])
    expect(s.update(b.id, { status: 'in_progress' }).ok).toBe(true)
  })

  it('addBlocks/addBlockedBy 去重累加', () => {
    const s = new TaskListStore()
    const t = s.create({ subject: 'T', description: 'x' })
    s.update(t.id, { addBlockedBy: ['9', '9'] })
    s.update(t.id, { addBlockedBy: ['9', '8'] })
    expect(s.get(t.id)!.blockedBy).toEqual(['9', '8'])
    s.update(t.id, { addBlocks: ['5'] })
    expect(s.get(t.id)!.blocks).toEqual(['5'])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/taskList.test.ts -t "1.6 任务依赖图"`
Expected: FAIL（`addBlockedBy` 未识别 / `openBlockers` 不存在 / `blockedByOpen` undefined）

- [ ] **Step 3: 实现**

`src/taskList.ts` Task 类型（:6-13）加两字段：

```ts
export interface Task {
  id: string
  subject: string
  description: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
  metadata?: Record<string, unknown>
  blocks?: string[]
  blockedBy?: string[]
}
```

在 `toPublic` 下、`create` 上方加 `openBlockers`：

```ts
/** blockedBy 中既未 completed 也未软删的依赖 id（软删依赖视同已清，避免删依赖永久卡死后继）。 */
openBlockers(id: string): string[] {
  const t = this.tasks.get(id)
  if (!t?.blockedBy?.length) return []
  return t.blockedBy.filter(dep => {
    const d = this.tasks.get(dep)
    if (!d) return false           // 依赖不存在 → 视同已清
    if (d._deleted) return false   // 软删 → 视同已清
    return d.status !== 'completed'
  })
}
```

改 `update` 签名与体（:48-72）。新签名：

```ts
update(id: string, patch: { subject?: string; description?: string; activeForm?: string; status?: 'pending' | 'in_progress' | 'completed' | 'deleted'; metadata?: Record<string, unknown>; addBlocks?: string[]; addBlockedBy?: string[] }): { ok: boolean; updatedFields: string[]; blockedByOpen?: string[] } {
  const t = this.tasks.get(id)
  if (!t) return { ok: false, updatedFields: [] }
  // 依赖门控：转 in_progress 前校验 blockedBy 全清（completed/软删/不存在）
  if (patch.status === 'in_progress') {
    const open = this.openBlockers(id)
    if (open.length) return { ok: false, updatedFields: [], blockedByOpen: open }
  }
  const updated: string[] = []
  if (patch.subject !== undefined) { t.subject = patch.subject; updated.push('subject') }
  if (patch.description !== undefined) { t.description = patch.description; updated.push('description') }
  if (patch.activeForm !== undefined) { t.activeForm = patch.activeForm; updated.push('activeForm') }
  if (patch.addBlocks?.length) { t.blocks = [...new Set([...(t.blocks ?? []), ...patch.addBlocks])]; updated.push('blocks') }
  if (patch.addBlockedBy?.length) { t.blockedBy = [...new Set([...(t.blockedBy ?? []), ...patch.addBlockedBy])]; updated.push('blockedBy') }
  if (patch.metadata !== undefined) {
    const m = { ...(t.metadata ?? {}) }
    for (const [k, v] of Object.entries(patch.metadata)) {
      if (v === null) delete m[k]
      else m[k] = v
    }
    t.metadata = m
    updated.push('metadata')
  }
  if (patch.status !== undefined) {
    if (patch.status === 'deleted') { t._deleted = true }
    else { t.status = patch.status }
    updated.push('status')
  }
  this.lastUpdateTurn = this.currentTurn
  this.persist(id)
  return { ok: true, updatedFields: updated }
}
```

注：`blocks`/`blockedBy` 随 `StoredTask`（`Task & {_deleted?}`）一并 persist（`persist` 的 `{_deleted, ...rest}` 已透传所有字段，无需改 persist/loadFromDisk）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/taskList.test.ts`
Expected: PASS（含原有用例）

- [ ] **Step 5: 提交**

```bash
git add src/taskList.ts test/taskList.test.ts
git commit -m "feat(1.6): taskList 加 blocks/blockedBy 依赖图 + in_progress 门控 + 软删依赖视同已清"
```

---

## Task 2: 1.6 — TaskUpdate 工具暴露 addBlocks/addBlockedBy + 门控消息

**Files:**
- Modify: `src/tools/taskListTools.ts:53-81`（updateSchema + taskUpdateTool）
- Test: `test/taskListTools.test.ts`（若不存在则新建）

**Interfaces:**
- Consumes: Task 1 的 `update` 返回 `{ ok, updatedFields, blockedByOpen? }`
- Produces: TaskUpdate input schema 加 `addBlocks?: string[]`、`addBlockedBy?: string[]`；被依赖拦截时返回中文提示而非静默成功

- [ ] **Step 1: 写失败测试**

`test/taskListTools.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { taskUpdateTool } from '../src/tools/taskListTools.js'
import { TaskListStore } from '../src/taskList.js'
import type { ToolContext } from '../src/tools/types.js'

function ctxWith(store: TaskListStore): ToolContext {
  return { cwd: () => '/tmp', setCwd: () => {}, get signal() { return new AbortController().signal }, fileState: new Map(), taskList: store } as unknown as ToolContext
}

describe('TaskUpdate 依赖图', () => {
  it('addBlockedBy 写入依赖', async () => {
    const s = new TaskListStore()
    const a = s.create({ subject: 'A', description: 'd' })
    const b = s.create({ subject: 'B', description: 'd' })
    const out = await taskUpdateTool.call({ taskId: b.id, addBlockedBy: [a.id] }, ctxWith(s))
    expect(out).toContain('已更新')
    expect(s.get(b.id)!.blockedBy).toEqual([a.id])
  })

  it('未清依赖时拒绝 in_progress 并提示', async () => {
    const s = new TaskListStore()
    const a = s.create({ subject: 'A', description: 'd' })
    const b = s.create({ subject: 'B', description: 'd' })
    s.update(b.id, { addBlockedBy: [a.id] })
    const out = await taskUpdateTool.call({ taskId: b.id, status: 'in_progress' }, ctxWith(s))
    expect(out).toContain('被未完成依赖阻塞')
    expect(out).toContain(`#${a.id}`)
    expect(s.get(b.id)!.status).toBe('pending')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/taskListTools.test.ts`
Expected: FAIL（schema 无 addBlockedBy / 无阻塞提示）

- [ ] **Step 3: 实现**

`src/tools/taskListTools.ts` updateSchema（:53-60）加两字段：

```ts
const updateSchema = z.object({
  taskId: z.string().describe('要更新的任务 id'),
  subject: z.string().optional().describe('新标题'),
  description: z.string().optional().describe('新描述'),
  activeForm: z.string().optional().describe('进行时文案'),
  status: z.enum(['pending', 'in_progress', 'completed', 'deleted']).optional().describe('新状态；deleted 删除任务'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('合并进 metadata；值设 null 删该键'),
  addBlocks: z.array(z.string()).optional().describe('本任务阻塞的下游任务 id（追加去重）'),
  addBlockedBy: z.array(z.string()).optional().describe('阻塞本任务的上游任务 id；全部 completed/删除前不能转 in_progress'),
})
```

taskUpdateTool.call（:67-80）在 `const r = ctx.taskList.update(...)` 后处理门控：

```ts
async call(input, ctx: ToolContext) {
  if (!ctx.taskList) return '错误：当前会话不支持任务清单。'
  const { taskId, ...patch } = input
  if (!ctx.taskList.get(taskId)) return `任务 ${taskId} 不存在`
  if (patch.status === 'completed') {
    const outcome = await ctx.hookDispatch?.('TaskCompleted', {
      hook_event_name: 'TaskCompleted', task_kind: 'todo', task_id: taskId, status: 'completed', subject: ctx.taskList.get(taskId)!.subject,
    })
    if (outcome?.block) return `任务 #${taskId} 完成被 hook 拦截，状态未变。`
  }
  const r = ctx.taskList.update(taskId, patch)
  if (r.blockedByOpen?.length) {
    return `任务 #${taskId} 被未完成依赖阻塞，无法转 in_progress：${r.blockedByOpen.map(id => `#${id}`).join('、')}（先完成或删除这些依赖）`
  }
  if (!r.ok) return `任务 ${taskId} 不存在`
  return `已更新任务 #${taskId}：${r.updatedFields.join('、') || '（无改动）'}`
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/taskListTools.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/taskListTools.ts test/taskListTools.test.ts
git commit -m "feat(1.6): TaskUpdate 暴露 addBlocks/addBlockedBy + 依赖阻塞提示"
```

---

## Task 3: 1.7 — runHooks 慢阶段 onProgress 回调 + makeHookRuntime 透传

**Files:**
- Modify: `src/hooks.ts:169-194`（HookEngineDeps）、`:417-463`（runHooks）
- Modify: `src/hookRuntime.ts:27-32,84`（makeHookRuntime 签名 + 返回）
- Test: `test/hooks.test.ts`

**Interfaces:**
- Produces:
  - `HookEngineDeps.onProgress?: (label?: string) => void`（label 非空=慢阶段 hook 开始；调用时传 undefined=结束清除）
  - runHooks 仅对慢阶段事件（`SLOW_PROGRESS_EVENTS`）且有命中 hook 时触发；热事件（PreToolUse 等）绝不触发
  - `makeHookRuntime(opts & { onProgress?: (label?: string) => void })` 返回对象含 `onProgress`

- [ ] **Step 1: 写失败测试**

`test/hooks.test.ts` 追加：

```ts
import { runHooks } from '../src/hooks.js'

describe('1.7 hooks 进度 onProgress', () => {
  const cmdHook = { PreCompact: [{ hooks: [{ type: 'command', command: 'echo {}' }] }] } as any
  const toolHook = { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo {}' }] }] } as any

  it('慢阶段事件触发 onProgress(label) 再 onProgress() 清除', async () => {
    const calls: (string | undefined)[] = []
    await runHooks('PreCompact', { hook_event_name: 'PreCompact' }, cmdHook, { onProgress: l => calls.push(l) })
    expect(calls[0]).toContain('PreCompact')
    expect(calls[calls.length - 1]).toBeUndefined() // 结束清除
  })

  it('热事件不触发 onProgress', async () => {
    const calls: (string | undefined)[] = []
    await runHooks('PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, toolHook, { onProgress: l => calls.push(l) })
    expect(calls).toEqual([])
  })

  it('无命中 hook 时不触发 onProgress（防闪烁）', async () => {
    const calls: (string | undefined)[] = []
    await runHooks('PreCompact', { hook_event_name: 'PreCompact' }, undefined, { onProgress: l => calls.push(l) })
    expect(calls).toEqual([])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/hooks.test.ts -t "1.7 hooks 进度"`
Expected: FAIL（onProgress 未被调用）

- [ ] **Step 3: 实现**

`src/hooks.ts` HookEngineDeps（:169 接口内，registerAsync 之后）加：

```ts
  /** 慢阶段 hook 进度回调（喂 TUI Spinner）。label 非空=开始；undefined=结束清除。仅慢阶段事件触发。 */
  onProgress?: (label?: string) => void
```

在 runHooks 函数上方（:416 附近，`export async function runHooks` 之前）加常量：

```ts
/** 值得在 TUI 显示进度的慢阶段事件（热事件 PreToolUse/PostToolUse 等不显，防刷屏）。 */
const SLOW_PROGRESS_EVENTS = new Set<HookEvent>(['PreCompact', 'PostCompact', 'SessionStart', 'Stop', 'SubagentStop'])
```

runHooks 体内，在 `if (selected.length === 0) return empty`（:439）之后、`const full`（:441）之前与 Promise.all 处包 try/finally：

```ts
  if (selected.length === 0) return empty

  const showProgress = SLOW_PROGRESS_EVENTS.has(event) && !!deps.onProgress
  if (showProgress) deps.onProgress!(`正在运行 ${event} 钩子…`)
  try {
    const full: ResolvedHookDeps = {
      spawn: deps.spawn ?? nodeSpawn,
      now: deps.now ?? Date.now,
      sessionEnvBase: deps.sessionEnvBase ?? DEFAULT_SESSION_ENV_BASE,
      fetch: deps.fetch ?? (undiciFetch as unknown as typeof fetch),
      allowedHttpHookUrls: deps.allowedHttpHookUrls,
      httpHookAllowedEnvVars: deps.httpHookAllowedEnvVars,
      llm: deps.llm,
      runAgent: deps.runAgent,
      registerAsync: deps.registerAsync,
    }
    const sid = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : undefined
    let envDir: string | undefined
    if (sid && ENV_FILE_EVENTS.has(event) && selected.some(h => h.type === 'command')) {
      envDir = ensureSessionEnvDir(sid, full.sessionEnvBase)
    }
    const results = await Promise.all(selected.map((h, i) =>
      execOneHook(h, payload, full, (envDir && h.type === 'command') ? path.join(envDir, hookEnvFileName(event, i)) : undefined),
    ))
    return mergeResults(results, event)
  } finally {
    if (showProgress) deps.onProgress!()
  }
```

`src/hookRuntime.ts`：makeHookRuntime opts（:27-32）加 `onProgress?: (label?: string) => void`，返回类型与返回对象（:32、:84）加 `onProgress`：

```ts
export function makeHookRuntime(opts: {
  client: OpenAI
  getModel: () => string
  onUsage?: (u: Usage, model: string) => void
  cwd: () => string
  onProgress?: (label?: string) => void
}): Pick<HookEngineDeps, 'llm' | 'runAgent' | 'registerAsync' | 'onProgress'> {
```

```ts
  return { llm, runAgent, registerAsync, onProgress: opts.onProgress }
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/hooks.test.ts`
Expected: PASS（全量 hooks 测试不回归）

- [ ] **Step 5: 提交**

```bash
git add src/hooks.ts src/hookRuntime.ts test/hooks.test.ts
git commit -m "feat(1.7): runHooks 慢阶段 onProgress 回调（热事件不触发）+ makeHookRuntime 透传"
```

---

## Task 4: 5.7 — Settings.statusLineCommand + 分层信任边界

**Files:**
- Modify: `src/config.ts:34-76`（Settings）、`:109-128`（loadRawUserSettings）
- Modify: `src/settingsLayers.ts:14-18`（DANGEROUS_TOP_KEYS）、`:137-161`（parsePresent）
- Test: `test/settingsLayers.test.ts`

**Interfaces:**
- Produces: `Settings.statusLineCommand?: string`；project / git-tracked local scope 剥离该字段；user scope 保留

- [ ] **Step 1: 写失败测试**

`test/settingsLayers.test.ts` 追加：

```ts
import { stripUntrustedScope, DANGEROUS_TOP_KEYS } from '../src/settingsLayers.js'

describe('5.7 statusLineCommand 信任边界', () => {
  it('statusLineCommand 在 DANGEROUS_TOP_KEYS', () => {
    expect((DANGEROUS_TOP_KEYS as readonly string[]).includes('statusLineCommand')).toBe(true)
  })
  it('project scope 剥离 statusLineCommand', () => {
    const { raw, stripped } = stripUntrustedScope({ statusLineCommand: 'echo hi', model: 'x' })
    expect(raw.statusLineCommand).toBeUndefined()
    expect(raw.model).toBe('x') // 普通字段保留
    expect(stripped).toContain('statusLineCommand')
  })
})
```

并在 `test/config.test.ts`（若存在；否则新建）追加 parsePresent 间接覆盖（经 loadLayeredSettings 注入临时 user 文件）——若无现成 harness，可只靠上面两条 + Task 8 的 e2e。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/settingsLayers.test.ts -t "5.7"`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/config.ts` Settings（在 `theme?: string` 上方）加：

```ts
  /** 用户自设状态栏命令：执行取 stdout 附加进状态栏。仅信任 user scope（DANGEROUS_TOP_KEYS 剥离 project）。 */
  statusLineCommand?: string
```

loadRawUserSettings 返回对象（:126 `theme: raw?.theme,` 之后）加：

```ts
    statusLineCommand: raw?.statusLineCommand,
```

`src/settingsLayers.ts` DANGEROUS_TOP_KEYS（:14-18）末尾加 `'statusLineCommand'`：

```ts
export const DANGEROUS_TOP_KEYS = [
  'apiKey', 'baseURL', 'hooks', 'mcpServers', 'webSearch',
  'allowedHttpHookUrls', 'httpHookAllowedEnvVars',
  'provider', 'providers', 'statusLineCommand',
] as const
```

parsePresent（:150 `if (typeof raw.theme === 'string') p.theme = raw.theme` 旁）加：

```ts
  if (typeof raw.statusLineCommand === 'string') p.statusLineCommand = raw.statusLineCommand
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/settingsLayers.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/config.ts src/settingsLayers.ts test/settingsLayers.test.ts
git commit -m "feat(5.7): Settings.statusLineCommand + DANGEROUS_TOP_KEYS 剥离 project scope"
```

---

## Task 5: 5.7 — src/statusLine.ts（解析 + 执行 + 去抖/abort/缓存 runner）

**Files:**
- Create: `src/statusLine.ts`
- Test: `test/statusLine.test.ts`

**Interfaces:**
- Produces:
  - `parseStatusLineStdout(raw: string, maxChars?: number): string`（纯）：`trim → split('\n') → 逐行 trim 去空 → join(' ')`（CC 用 `\n` join 保留多行；deepcode footer 紧凑 → 单行 join + 默认 maxChars=200 截断）
  - `execStatusLineCommand(command: string, input: unknown, opts?: { spawn?; timeoutMs?: number; signal?: AbortSignal; maxChars?: number }): Promise<string | undefined>`：bash -c spawn，JSON input 写 stdin，`AbortSignal.timeout(timeoutMs=5000)` 与外部 signal 任一中止则杀子进程；exit≠0 / 空 / abort / 异常 → undefined（绝不抛）
  - `createStatusLineRunner(opts: { exec: () => Promise<string | undefined>; onChange: (text: string | undefined) => void; debounceMs?: number; now?: () => number }): { schedule(): void; current(): string | undefined; dispose(): void }`：300ms 去抖 + 在途 abort（每次 schedule 取消上一个未跑的 timer，doUpdate 时不并发跑）+ 缓存（结果变化才 onChange，与上次相同不通知）

- [ ] **Step 1: 写失败测试**

`test/statusLine.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { parseStatusLineStdout, createStatusLineRunner } from '../src/statusLine.js'

describe('parseStatusLineStdout', () => {
  it('多行 trim 去空 join 单行', () => {
    expect(parseStatusLineStdout('  a \n\n  b  \n')).toBe('a b')
  })
  it('超长截断到 maxChars', () => {
    expect(parseStatusLineStdout('x'.repeat(50), 10)).toHaveLength(10)
  })
  it('全空白 → 空串', () => {
    expect(parseStatusLineStdout('   \n  \n')).toBe('')
  })
})

describe('createStatusLineRunner', () => {
  it('300ms 去抖：连续 schedule 只跑一次', async () => {
    vi.useFakeTimers()
    const exec = vi.fn(async () => 'out')
    const changes: (string | undefined)[] = []
    const r = createStatusLineRunner({ exec, onChange: t => changes.push(t), debounceMs: 300 })
    r.schedule(); r.schedule(); r.schedule()
    await vi.advanceTimersByTimeAsync(300)
    expect(exec).toHaveBeenCalledTimes(1)
    expect(changes).toEqual(['out'])
    r.dispose(); vi.useRealTimers()
  })
  it('结果不变不重复通知', async () => {
    vi.useFakeTimers()
    const exec = vi.fn(async () => 'same')
    const changes: (string | undefined)[] = []
    const r = createStatusLineRunner({ exec, onChange: t => changes.push(t), debounceMs: 300 })
    r.schedule(); await vi.advanceTimersByTimeAsync(300)
    r.schedule(); await vi.advanceTimersByTimeAsync(300)
    expect(changes).toEqual(['same']) // 第二次相同不通知
    expect(r.current()).toBe('same')
    r.dispose(); vi.useRealTimers()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/statusLine.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/statusLine.ts`**

```ts
// src/statusLine.ts —— 自定义状态栏命令：解析 + 执行 + 去抖/abort/缓存调度。
// 对齐 CC components/StatusLine.tsx：事件驱动 + 300ms 去抖 + 在途 abort + 5s 超时 + 缓存；失败静默保留上次值。
// CC stdout 解析保留多行（\n join）；deepcode footer 紧凑 → 单行 join(' ') + 长度截断（已记 spec 偏离）。
import { spawn as nodeSpawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'

export const STATUS_LINE_DEFAULT_TIMEOUT_MS = 5000
export const STATUS_LINE_DEFAULT_MAX_CHARS = 200

/** trim → 按行 trim 去空 → join 单行 → 截断（CC 同语义但单行化）。 */
export function parseStatusLineStdout(raw: string, maxChars = STATUS_LINE_DEFAULT_MAX_CHARS): string {
  const joined = raw.trim().split('\n').map(l => l.trim()).filter(Boolean).join(' ')
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined
}

/** spawn bash -c 跑命令，JSON input 写 stdin；5s 或外部 signal 中止则杀子进程；exit≠0/空/异常 → undefined（绝不抛）。 */
export function execStatusLineCommand(
  command: string,
  input: unknown,
  opts: { spawn?: typeof nodeSpawn; timeoutMs?: number; signal?: AbortSignal; maxChars?: number } = {},
): Promise<string | undefined> {
  const spawn = opts.spawn ?? nodeSpawn
  const timeoutMs = opts.timeoutMs ?? STATUS_LINE_DEFAULT_TIMEOUT_MS
  return new Promise<string | undefined>(resolve => {
    let done = false
    const finish = (v: string | undefined) => { if (done) return; done = true; clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort); resolve(v) }
    const spawnOpts: SpawnOptions = {
      env: { ...process.env, DEEPCODE_PROJECT_DIR: process.cwd() },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
    let child: any
    try { child = spawn('/bin/bash', ['-c', command], spawnOpts) } catch { return resolve(undefined) }
    const kill = () => { try { child.kill('SIGKILL') } catch { /* 尽力 */ } }
    const timer = setTimeout(() => { kill(); finish(undefined) }, timeoutMs)
    const onAbort = () => { kill(); finish(undefined) }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    let stdout = ''
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.on('error', () => finish(undefined))
    child.on('close', (code: number | null) => {
      if (code !== 0) return finish(undefined)
      const text = parseStatusLineStdout(stdout, opts.maxChars)
      finish(text || undefined) // 空输出当无
    })
    try { child.stdin?.write(JSON.stringify(input) + '\n'); child.stdin?.end() } catch { /* 尽力 */ }
  })
}

/** 去抖（300ms）+ 在途单飞 + 缓存的调度器。schedule() 触发；结果变化才 onChange。 */
export function createStatusLineRunner(opts: {
  exec: () => Promise<string | undefined>
  onChange: (text: string | undefined) => void
  debounceMs?: number
}): { schedule(): void; current(): string | undefined; dispose(): void } {
  const debounceMs = opts.debounceMs ?? 300
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let pendingWhileRunning = false
  let cache: string | undefined
  const doUpdate = async (): Promise<void> => {
    if (running) { pendingWhileRunning = true; return } // 在途则标记，跑完补一次（单飞）
    running = true
    try {
      const text = await opts.exec()
      if (text !== cache) { cache = text; opts.onChange(cache) }
    } catch { /* exec 自身已 fail-safe，这里再兜底 */ }
    finally {
      running = false
      if (pendingWhileRunning) { pendingWhileRunning = false; void doUpdate() }
    }
  }
  return {
    schedule() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = undefined; void doUpdate() }, debounceMs)
    },
    current() { return cache },
    dispose() { if (timer) clearTimeout(timer); timer = undefined },
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/statusLine.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/statusLine.ts test/statusLine.test.ts
git commit -m "feat(5.7): src/statusLine.ts 解析 + execStatusLineCommand(5s/silent) + 去抖/abort/缓存 runner"
```

---

## Task 6: 3.6 — session.ts title 字段 + branch 标题纯助手

**Files:**
- Modify: `src/session.ts:6-13`（SessionMeta）、`:21-29`（SessionHandle）、`:58-67`（makeHandle）、`:89-127`（loadSession）、`:146-165`（listSessions）+ 新增纯助手
- Test: `test/session.test.ts`

**Interfaces:**
- Produces:
  - `SessionMeta.title?: string`
  - `SessionHandle.appendTitle(title: string): void`（写 `{t:'title', title}` 记录）
  - loadSession 解析 `{t:'title'}` → `meta.title`（last-wins）
  - listSessions 预览：`meta.title ?? 首条 user 60 字 ?? '(无预览)'`
  - `stripBranchSuffix(title: string): string`（去掉尾部 ` (Branch)` / ` (Branch N)`）
  - `nextBranchTitle(base: string, existing: Iterable<string>): string`（返回 `${base} (Branch)`、碰撞升级 `(Branch 2/3…)` 的首个未占用名）

- [ ] **Step 1: 写失败测试**

`test/session.test.ts` 追加（用临时目录）：

```ts
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { newSession, loadSession, listSessions, openSession, stripBranchSuffix, nextBranchTitle } from '../src/session.js'

describe('3.6 会话标题', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sess-'))
  it('appendTitle 写入，loadSession last-wins 读出', () => {
    const s = newSession({ cwd: '/p', model: 'm', thinking: false, permMode: 'default' }, dir)
    s.appendMessage({ role: 'user', content: '第一条消息内容' })
    s.appendTitle('我的会话')
    s.appendTitle('改名后')
    const loaded = loadSession(s.file)
    expect(loaded.meta.title).toBe('改名后')
  })
  it('listSessions 预览优先 title，无 title 回退首句', () => {
    const a = newSession({ cwd: '/q', model: 'm', thinking: false, permMode: 'default' }, dir)
    a.appendMessage({ role: 'user', content: '首句预览文本' })
    a.appendTitle('标题甲')
    const b = newSession({ cwd: '/q', model: 'm', thinking: false, permMode: 'default' }, dir)
    b.appendMessage({ role: 'user', content: '只有首句没有标题' })
    const list = listSessions('/q', dir)
    expect(list.find(s => s.file === a.file)!.preview).toBe('标题甲')
    expect(list.find(s => s.file === b.file)!.preview).toBe('只有首句没有标题')
  })
})

describe('3.6 branch 标题助手', () => {
  it('stripBranchSuffix 去尾缀', () => {
    expect(stripBranchSuffix('Foo (Branch)')).toBe('Foo')
    expect(stripBranchSuffix('Foo (Branch 3)')).toBe('Foo')
    expect(stripBranchSuffix('Foo')).toBe('Foo')
  })
  it('nextBranchTitle 碰撞升级', () => {
    expect(nextBranchTitle('Foo', [])).toBe('Foo (Branch)')
    expect(nextBranchTitle('Foo', ['Foo (Branch)'])).toBe('Foo (Branch 2)')
    expect(nextBranchTitle('Foo', ['Foo (Branch)', 'Foo (Branch 2)'])).toBe('Foo (Branch 3)')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/session.test.ts -t "3.6"`
Expected: FAIL（title undefined / 助手不存在）

- [ ] **Step 3: 实现**

`src/session.ts` SessionMeta（:6-13）加 `title?: string`：

```ts
export interface SessionMeta {
  cwd: string
  model: string
  providerId?: string
  thinking: boolean
  effortLevel?: 'low' | 'medium' | 'high'
  permMode: string
  title?: string
}
```

SessionHandle 接口（:21-29）加 `appendTitle(title: string): void`；makeHandle 返回对象（:58-66）加：

```ts
    appendTitle: title => append({ t: 'title', title }),
```

loadSession 初始 meta（:91）加 title 解析。在 `else if (r.t === 'rewind')` 分支前加：

```ts
    else if (r.t === 'title') { if (typeof r.title === 'string') meta.title = r.title }
```

（注：`{t:'meta'}` 分支重建 meta 对象时会丢 title——故 meta 分支也要保留已有 title。把 :102-109 的 meta 重建改为保留 title：）

```ts
    if (r.t === 'meta') {
      meta = {
        cwd: sawMeta ? meta.cwd : (r.cwd ?? ''),
        model: r.model ?? 'deepseek-v4-flash',
        providerId: r.providerId,
        thinking: r.thinking ?? false,
        effortLevel: r.effortLevel,
        permMode: r.permMode ?? 'default',
        title: r.title ?? meta.title, // 保留已有 title（meta 行通常不带 title）
      }
      sawMeta = true
    }
```

listSessions 预览（:156-160）改为优先 title：

```ts
      const firstUser = loaded.messages.find(m => m.role === 'user')
      const fallback = typeof firstUser?.content === 'string' ? firstUser.content.slice(0, 60) : '(无预览)'
      out.push({
        file: full,
        mtimeMs: fs.statSync(full).mtimeMs,
        preview: loaded.meta.title ?? fallback,
      })
```

文件末尾加两个纯助手：

```ts
/** 去掉标题尾部的 ` (Branch)` / ` (Branch N)` 后缀，得到基名。 */
export function stripBranchSuffix(title: string): string {
  return title.replace(/\s*\(Branch(?:\s+\d+)?\)$/, '')
}

/** 返回 `${base} (Branch)`，与 existing 碰撞则升级 `(Branch 2/3…)`，取首个未占用名（对齐 CC getUniqueForkName）。 */
export function nextBranchTitle(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing)
  let candidate = `${base} (Branch)`
  let n = 2
  while (taken.has(candidate)) { candidate = `${base} (Branch ${n})`; n++ }
  return candidate
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/session.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/session.ts test/session.test.ts
git commit -m "feat(3.6): SessionMeta.title + appendTitle 记录 + listSessions 预览优先 title + branch 标题助手"
```

---

## Task 7: 1.7 TUI — Spinner 显示 hook 进度 + useChat/App/FullscreenApp 双接线

**Files:**
- Modify: `src/tui/components/Spinner.tsx:19-44`
- Modify: `src/tui/useChat.ts:181-191`（ChatState）、`:294-303`（hookDeps）、设状态处
- Modify: `src/tui/App.tsx:284`、`src/tui/FullscreenApp.tsx:313`
- Test: `test/spinner.test.ts`（若无则新建，纯渲染断言）

**Interfaces:**
- Consumes: Task 3 的 `makeHookRuntime({ onProgress })`
- Produces: `ChatState.hookProgress: string | null`；Spinner 多一个可选 `hookLabel?: string | null` prop（有则优先显示「正在运行…」行）

- [ ] **Step 1: 写失败测试**

`test/spinner.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { Spinner } from '../src/tui/components/Spinner.js'
import { ThemeProvider } from '../src/tui/theme.js'

describe('Spinner hook 进度', () => {
  it('有 hookLabel 时显示该文案', () => {
    const { lastFrame } = render(
      <ThemeProvider><Spinner turnStartAt={Date.now()} turnOutTokens={0} hookLabel="正在运行 PreCompact 钩子…" /></ThemeProvider>,
    )
    expect(lastFrame()).toContain('正在运行 PreCompact 钩子…')
  })
  it('无 hookLabel 时显示常规 spinner', () => {
    const { lastFrame } = render(
      <ThemeProvider><Spinner turnStartAt={Date.now()} turnOutTokens={0} /></ThemeProvider>,
    )
    expect(lastFrame()).toContain('esc 中断')
  })
})
```

（注：确认 `ThemeProvider` 从 `theme.js` 导出——计划2 已 context 化；若 provider 名不同则按实际改。`ink-testing-library` 已是依赖；若否，退化为断言 Spinner 返回的元素 props，不渲染。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/spinner.test.ts`
Expected: FAIL（hookLabel prop 未识别 / 不显示）

- [ ] **Step 3: 实现**

`src/tui/components/Spinner.tsx` SpinnerProps + 渲染：

```ts
interface SpinnerProps {
  turnStartAt: number | null
  turnOutTokens: number
  hookLabel?: string | null
}

export function Spinner({ turnStartAt, turnOutTokens, hookLabel }: SpinnerProps) {
  const T = useTheme()
  const [symIdx, setSymIdx] = useState(0)
  const [, setTick] = useState(0)
  const [verb] = useState(() => THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)])

  useEffect(() => {
    const sym = setInterval(() => setSymIdx(i => (i + 1) % SPINNER_SYMBOLS.length), 120)
    const sec = setInterval(() => setTick(t => t + 1), 1000)
    return () => { clearInterval(sym); clearInterval(sec) }
  }, [])

  const symbol = SPINNER_SYMBOLS[symIdx]
  const elapsed = turnStartAt ? Math.floor((Date.now() - turnStartAt) / 1000) : 0

  if (hookLabel) {
    return <Text color={T.accent}>{symbol} {hookLabel}</Text>
  }
  return (
    <Text color={T.accent}>
      {symbol} {verb}… ({fmtElapsed(elapsed)} · ↓ {fmtTokens(turnOutTokens)} tokens · esc 中断)
    </Text>
  )
}
```

`src/tui/useChat.ts`：

ChatState（:181-191 区域，turnOutTokens 旁）加：

```ts
  hookProgress: string | null // 1.7 当前运行中的慢阶段 hook 文案（null=无）
```

在 createChatCore 的 UI 状态区（`let transcript` 附近，:313 区域）加可变变量：

```ts
  let hookProgress: string | null = null
```

hookDeps 构造（:294-303）传 onProgress：

```ts
  const hookDeps = {
    ...makeHookRuntime({
      client: opts.client,
      getModel: () => model,
      onUsage: (u, m) => { usageLog.push({ usage: u, model: m }); session.appendUsage(u, m) },
      cwd: () => cwd,
      onProgress: (label?: string) => { hookProgress = label ?? null; setState() },
    }),
    allowedHttpHookUrls: settings.allowedHttpHookUrls,
    httpHookAllowedEnvVars: settings.httpHookAllowedEnvVars,
  }
```

在构造 `state` 对象处把 `hookProgress` 暴露（找 `turnOutTokens,` 所在的 state 字面量，加 `hookProgress,`）。若 state 用 getter 模式则照同款加 `get hookProgress() { return hookProgress }`。

`src/tui/App.tsx:284` 与 `src/tui/FullscreenApp.tsx:313` 同改：

```tsx
{state.busy && <Spinner turnStartAt={state.turnStartAt} turnOutTokens={state.turnOutTokens} hookLabel={state.hookProgress} />}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/spinner.test.ts && npx tsc --noEmit`
Expected: PASS + 类型干净

- [ ] **Step 5: 提交**

```bash
git add src/tui/components/Spinner.tsx src/tui/useChat.ts src/tui/App.tsx src/tui/FullscreenApp.tsx test/spinner.test.ts
git commit -m "feat(1.7): Spinner 显示 hook 进度文案 + useChat onProgress 接线（App/FullscreenApp 双改）"
```

---

## Task 8: 5.7 TUI — statusLine runner 接线 useChat + StatusFooter 渲染 + 双接线

**Files:**
- Modify: `src/tui/useChat.ts`（statusLine runner 构造 + 触发点 + state 暴露）
- Modify: `src/tui/components/StatusFooter.tsx:26-42,64-79`
- Modify: `src/tui/App.tsx:207,303-319`、`src/tui/FullscreenApp.tsx` 对应处
- Test: `test/statusFooter.test.ts`（渲染断言）+ useChat 触发覆盖靠现有 send 测试间接

**Interfaces:**
- Consumes: Task 4 `settings.statusLineCommand`、Task 5 `createStatusLineRunner`/`execStatusLineCommand`
- Produces: `ChatState.statusLineOutput: string | null`；StatusFooter 多 `statusLineOutput?: string | null` prop（有则渲染单独一行）

- [ ] **Step 1: 写失败测试**

`test/statusFooter.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import React from 'react'
import { StatusFooter } from '../src/tui/components/StatusFooter.js'
import { ThemeProvider } from '../src/tui/theme.js'

const base = {
  model: 'm', mode: 'default', cwdBase: 'p', branch: null, memoryCount: 0,
  contextUsed: 0, contextWindow: 100, cost: 0, hitRate: 0, cacheSavings: 0,
  thinking: false, effortLevel: 'medium' as const, toolCounts: [],
}

describe('StatusFooter statusLine 段', () => {
  it('有 statusLineOutput 渲染该行', () => {
    const { lastFrame } = render(<ThemeProvider><StatusFooter {...base} statusLineOutput="主分支 ✓ 通过" /></ThemeProvider>)
    expect(lastFrame()).toContain('主分支 ✓ 通过')
  })
  it('无 statusLineOutput 不渲染', () => {
    const { lastFrame } = render(<ThemeProvider><StatusFooter {...base} /></ThemeProvider>)
    expect(lastFrame()).not.toContain('主分支')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/statusFooter.test.ts`
Expected: FAIL（prop 未识别）

- [ ] **Step 3: 实现**

`src/tui/components/StatusFooter.tsx` props（:26-42）加：

```ts
  statusLineOutput?: string | null
```

在 Row 2（:79 `</Text>` 之后）、Row 3 之前插入 statusLine 行：

```tsx
      {/* Row 2.5（仅有 statusLineCommand 输出）：用户自定义状态行（单行，换行已在解析期 join） */}
      {props.statusLineOutput && <Text dimColor>{props.statusLineOutput}</Text>}
```

`src/tui/useChat.ts`：

文件顶部 import：

```ts
import { createStatusLineRunner, execStatusLineCommand } from '../statusLine.js'
```

ChatState 加：

```ts
  statusLineOutput: string | null // 5.7 自定义状态栏命令输出缓存（null=无/未设）
```

createChatCore 内（UI 状态区）加变量 + runner（仅当配置了命令才建）：

```ts
  let statusLineOutput: string | null = null
  const statusLineRunner = settings.statusLineCommand
    ? createStatusLineRunner({
        exec: () => execStatusLineCommand(settings.statusLineCommand!, {
          model, cwd, permission_mode: permMode, session_id: ctx.sessionId?.(),
        }),
        onChange: text => { statusLineOutput = text ?? null; setState() },
      })
    : undefined
```

触发点（对齐 CC 事件驱动：turn 结束 + 模式/模型变化）。最小接入 = 在 setState 之外，于以下位置调用 `statusLineRunner?.schedule()`：
1. 每轮结束（`turnStartAt = null` 处，:817 附近——turn 推进信号）。
2. `/model`、`/accept`、`/cycle-mode`、`/plan` 改 permMode/model 后（这些分支已 `session.appendMeta`，在其后加一行 `statusLineRunner?.schedule()`）。
3. 会话启动后跑一次（recovered/新建分支末尾，或紧接 `statusLineRunner?.schedule()`）。

为避免散落，封装一个本地辅助并在上述点调用：

```ts
  const refreshStatusLine = (): void => { statusLineRunner?.schedule() }
```

在 createChatCore 末尾（会话建立后）调用 `refreshStatusLine()` 一次；在 turn 结束处 + 上述模式/模型命令分支末尾各加 `refreshStatusLine()`。

state 字面量暴露 `statusLineOutput`（或 `get statusLineOutput() { return statusLineOutput }`）。

dispose（:1281）追加 `statusLineRunner?.dispose()`：

```ts
    dispose: () => { fireSessionEnd('exit'); unsubNotification(); unsubSteer(); steerQueue.clear(); statusLineRunner?.dispose(); void mcpCleanup?.() },
```

`src/tui/App.tsx`：linesBelowCaret（:207）加 statusLine 行；StatusFooter（:303-319）传 prop。FullscreenApp 同改。

```ts
  const linesBelowCaret = 5 + (memoryCount > 0 ? 1 : 0) + (toolCounts.length > 0 ? 1 : 0) + (state.statusLineOutput ? 1 : 0)
```

```tsx
      <StatusFooter
        /* …现有 props… */
        statusLineOutput={state.statusLineOutput}
      />
```

（FullscreenApp 的 footer 行数计算若有对应变量也同步加 `+ (state.statusLineOutput ? 1 : 0)`；若 FullscreenApp 不做 cursor parking 则只加 StatusFooter prop。）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/statusFooter.test.ts && npx tsc --noEmit`
Expected: PASS + 类型干净

- [ ] **Step 5: 提交**

```bash
git add src/tui/useChat.ts src/tui/components/StatusFooter.tsx src/tui/App.tsx src/tui/FullscreenApp.tsx test/statusFooter.test.ts
git commit -m "feat(5.7): statusLine runner 接线 useChat（turn/模式/模型触发）+ StatusFooter 渲染 + 双接线 + IME 行数"
```

---

## Task 9: 3.6 TUI — /fork + /rename 命令 + HELP_TEXT + 补全

**Files:**
- Modify: `src/tui/useChat.ts`（send 分发加 /fork /rename；currentTitle 状态；HELP_TEXT）
- Modify: `src/tui/suggest.ts:7-26`（BUILTIN_COMMANDS）
- Test: `test/useChat.fork.test.ts`（或并入现有 useChat 测试），用 `sessionDir` 注入临时目录

**Interfaces:**
- Consumes: Task 6 `appendTitle`、`nextBranchTitle`、`stripBranchSuffix`、`newSession`、`listSessions`
- Produces: `/rename <名>` 写当前会话 title；`/fork` 快照当前 messages 到新会话文件（原文件冻结）、自动 `(Branch)` 标题、切换继续

- [ ] **Step 1: 写失败测试**

`test/useChat.fork.test.ts`（参考现有 useChat 测试的 createChatCore 构造法；关键是注入 `sessionDir` 临时目录 + 一个 fake `client`）：

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path'
import { createChatCore } from '../src/tui/useChat.js'
import { listSessions } from '../src/session.js'
// fakeClient/fakeOpts 复用现有 useChat 测试 helper（若有 test/helpers）；否则按现有 useChat.*.test.ts 同款构造。

describe('3.6 /rename + /fork', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-fork-')) })

  it('/rename 写 title，listSessions 预览变标题', async () => {
    const core = createChatCore({ /* client: fakeClient, */ yolo: false, cwd: '/proj', sessionDir: dir, onState: () => {} } as any)
    await core.send('/rename 我的任务')
    const list = listSessions('/proj', dir)
    expect(list[0].preview).toBe('我的任务')
  })

  it('/fork 产出独立文件，原会话不受影响，新会话带 (Branch) 标题', async () => {
    const core = createChatCore({ /* client: fakeClient, */ yolo: false, cwd: '/proj', sessionDir: dir, onState: () => {} } as any)
    await core.send('/rename 原会话')
    const before = listSessions('/proj', dir).map(s => s.file)
    await core.send('/fork')
    const after = listSessions('/proj', dir)
    expect(after.length).toBe(before.length + 1) // 多了 fork 文件
    expect(after.some(s => s.preview === '原会话 (Branch)')).toBe(true) // 新会话标题
    expect(after.some(s => s.preview === '原会话')).toBe(true)         // 原会话仍在、未变
  })
})
```

（注：若 createChatCore 强依赖真实 OpenAI client，沿用仓库现有 `test/useChat.*.test.ts` 的 fake client 构造；/rename 与 /fork 都不发起 API 调用，client 不会被命中。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/useChat.fork.test.ts`
Expected: FAIL（/rename /fork 未实现）

- [ ] **Step 3: 实现**

`src/tui/useChat.ts`：

在 UI 状态区加当前会话标题缓存（restoreSession/clear 时重置）：

```ts
  let currentTitle: string | null = null
```

在 `restoreSession` 末尾设 `currentTitle = loaded.meta.title ?? null`；在 `/clear` 与新建会话分支重置 `currentTitle = null`；recovered 分支设为 `recovered` 的 title（`restoreSession` 已设）。

send 分发中（在 `/clear` 分支之后、`/context` 之前，:1010 附近）插入两命令：

```ts
    if (line === '/rename' || line.startsWith('/rename ')) {
      const name = line.slice('/rename'.length).trim()
      if (!name) { notice('info', `当前标题：${currentTitle ?? '（未命名）'}\n用法：/rename <名称>`); return }
      currentTitle = name
      session.appendTitle(name)
      notice('info', `会话已重命名为「${name}」`)
      return
    }
    if (line === '/fork') {
      // 快照当前对话到新会话文件（原文件冻结），自动 (Branch) 标题，切换继续。memdir 共享项目（对齐 CC，不隔离）。
      const base = stripBranchSuffix(currentTitle ?? (() => {
        const fu = messages.find(m => m.role === 'user' && typeof m.content === 'string')
        return typeof fu?.content === 'string' ? fu.content.slice(0, 40) : '会话'
      })())
      const existingTitles = listSessions(cwd, sessionDir).map(s => s.preview)
      const forkTitle = nextBranchTitle(base, existingTitles)
      const forkMeta = { cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id, title: forkTitle }
      const newS = newSession(forkMeta, sessionDir)
      for (const m of messages) newS.appendMessage(m, turnOf.get(m)) // 复制全部内存消息（带 turnId）
      session = newS
      currentTitle = forkTitle
      checkpointer = createCheckpointer(checkpointStoreFor(session.file))
      taskList.bind(sessionIdFromFile(session.file))
      extractor = createMemoryExtractor({
        client: opts.client, model, memdir: memdirFor(cwd), config: mem, ctx,
        runSubagent: opts.runSubagent, onUsage: memoryOnUsage,
      })
      smState = { promptTokens: 0, tokensAtLastUpdate: 0, initialized: false, toolCallsSinceUpdate: 0, lastTurnHadToolCalls: false }
      notice('info', `已分叉到新会话「${forkTitle}」（原会话保持不变，继续写入新文件）`)
      fireSessionStart('startup')
      return
    }
```

确认顶部已 import `newSession`、`listSessions`、`stripBranchSuffix`、`nextBranchTitle`（前者多半已 import；按需补全）。

HELP_TEXT（:219-220）在 `/rewind` 行后加：

```
/fork   分叉当前对话到新会话继续（原会话冻结，新会话标题加 (Branch)）
/rename <名> 给当前会话命名（显示在 /resume 列表）
```

`src/tui/suggest.ts` BUILTIN_COMMANDS（:18 `/resume` 之后）加：

```ts
  { value: '/fork', hint: '分叉当前会话继续' },
  { value: '/rename', hint: '给当前会话命名' },
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/useChat.fork.test.ts && npx tsc --noEmit`
Expected: PASS + 类型干净

- [ ] **Step 5: 提交**

```bash
git add src/tui/useChat.ts src/tui/suggest.ts test/useChat.fork.test.ts
git commit -m "feat(3.6): /fork（快照分叉+Branch标题，memdir共享对齐CC）+ /rename + HELP/补全"
```

---

## 全量校验 + 真机冒烟（TUI 件收尾）

- [ ] **Step A：全量绿**

Run: `npx tsc --noEmit && npm run build && npm test`
Expected: typecheck/build 干净；测试全绿（注意 EPIPE 已知 flaky 不计失败）。

- [ ] **Step B：真机冒烟（`npm start`，碰 TUI 必做）**

冒烟清单（用户复制粘贴命令 + 截图回传，约定见 [[deepcode-tui-smoke-workflow]]）：
1. **/rename + /fork**：`/rename 测试会话` → 发一条消息 → `/fork` → 确认提示「已分叉到新会话『测试会话 (Branch)』」→ `/resume` 列表里同时看到「测试会话」与「测试会话 (Branch)」两条、原会话内容未变。
2. **1.6 任务依赖**：让模型建两个任务并 `addBlockedBy`，未完成依赖时把后继标 in_progress → 确认被拒提示「被未完成依赖阻塞」；完成依赖后可转。
3. **5.7 statusline**：在 `~/.deepcode/settings.json` 配 `"statusLineCommand": "echo \"分支 $(git branch --show-current 2>/dev/null)\""` → 重启 → 状态栏出现该行；发一轮对话后内容刷新（去抖、不闪）；删除配置 → 该行消失。
4. **1.7 hooks 进度**：配一个 PreCompact command hook（如 `echo {}`）→ `/compact` → 确认 spinner 短暂显示「正在运行 PreCompact 钩子…」。
5. **双组件确认**：默认全屏（FullscreenApp）下 1-4 均生效（非仅内联 App）。

- [ ] **Step C：合并**

按 `superpowers:finishing-a-development-branch` 走（合 main，本批全做完一次冒烟后再合，不在 main 直接做）。合前确认 main=origin 基线、更新 roadmap 标记本批 ✅。

---

## Self-Review（写完对照 spec）

**1. Spec 覆盖**：
- 3.6 /fork（spec:77-80，已校准共享 memdir + Branch 标题）→ Task 6（助手）+ Task 9（命令）✅
- 3.6 /rename（spec:82-85）→ Task 6（title 字段）+ Task 9（命令）✅
- 1.6 Task 依赖图（spec:120-123，含软删视同已清）→ Task 1（store）+ Task 2（工具）✅
- 5.7 /statusline（spec:125-132，已校准事件驱动+去抖+5s+多行 trim+缓存）→ Task 4（settings）+ Task 5（exec/parse/runner）+ Task 8（接线）✅
- 1.7 Hooks 进度（spec:138-141）→ Task 3（引擎）+ Task 7（Spinner 接线）✅
- 5.9 围栏 / 1.4 plan / 组 A picker：**不在本批**（计划1/2 已合）✅

**2. Placeholder 扫描**：无 TBD/TODO；每个 code step 含完整代码。✅

**3. 类型一致性**：
- `update` 返回 `{ ok; updatedFields; blockedByOpen? }`——Task 1 定义、Task 2 消费 `blockedByOpen` ✅
- `onProgress?: (label?: string) => void`——Task 3 引擎/runtime、Task 7 useChat 一致 ✅
- `createStatusLineRunner({ exec; onChange; debounceMs? })` / `execStatusLineCommand(command, input, opts)`——Task 5 定义、Task 8 消费一致 ✅
- `appendTitle` / `nextBranchTitle` / `stripBranchSuffix`——Task 6 定义、Task 9 消费一致 ✅
- Spinner `hookLabel`、StatusFooter `statusLineOutput`、ChatState `hookProgress`/`statusLineOutput`——定义与接线一致 ✅

**待执行期确认的现状假设**（非阻塞，发现偏差按实际改）：
- ① `ThemeProvider` 导出名（计划2 context 化产物）——Task 7/8 测试用，若名不同按实际改。
- ② `ink-testing-library` 是否为依赖——若否，Spinner/StatusFooter 测试退化为 props/元素断言。
- ③ ChatState 是字面量还是 getter 模式——`hookProgress`/`statusLineOutput` 暴露方式按实际跟随。
- ④ FullscreenApp 是否做 cursor parking（linesBelowCaret 等价物）——若无则只接 StatusFooter prop。
- ⑤ `createChatCore` 测试构造（fake client）——沿用仓库现有 `test/useChat.*.test.ts` helper。
