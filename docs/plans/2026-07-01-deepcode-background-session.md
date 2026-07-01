# 7.3 后台会话薄片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让当前交互会话「送到后台、释放终端」——fork 会话副本，spawn detached headless 子进程 resume 续跑，原 TUI 退出还终端；`/stop <id>` 停止、`/resume` 回看。1:1 对齐 CC `/background` 语义内核，不做 daemon/PTY/attach。

**Architecture:** 无 daemon。`/background` fork 当前会话 JSONL → `spawn(process.execPath, ['--background-run','--resume',<forkedFile>,'--job',<short>,...], {detached:true})` → 原 TUI `process.exit(0)`。子进程设 `DEEPCODE_SESSION_KIND=bg`、resume 会话续跑 headless、把状态写 `~/.deepcode/jobs/<short>/state.json`（`working→completed/failed`，SIGTERM→`stopped`）。前台 `/stop <id>` 读 pid SIGTERM，`/resume` 并入 bg 会话回看。

**Tech Stack:** TypeScript (ESM, `.js` import 后缀)、Node `child_process.spawn`、vitest、ink/React（TUI）、既有 `src/session.ts`（JSONL 会话）/`src/headless.ts`（无 TUI runLoop）/`src/loop.ts`。

## Global Constraints

- 配置根 `~/.deepcode`；本件新增 `JOBS_DIR = ~/.deepcode/jobs`，job 目录 `~/.deepcode/jobs/<short>/`，`short` = forked sessionId 前 8 字符，`state.json` mode `0600`。
- 测试：`test/` 目录，`npx vitest run test/<file>.test.ts` 跑单文件，`npm test` 跑全量。构建 `npm run build`（tsc），类型检查 `npm run typecheck`。
- ESM：所有相对 import 带 `.js` 后缀（`.ts` 源写 `.js`）。
- **押后（本件不做，红线）**：daemon 全套（socket RPC/lease/adopt/respawn/zombie/spare 池）、PTY host、attach/reattach（APC detach 协议）、daemon `op:"kill"` 远程杀、launchd service、`/loops`。
- **必要偏离（已过审）**：`/stop` 改为前台按 id 杀（CC 是自停，因押后 reattach），语义正确性不受影响。
- **TUI 双组件铁律**：任何 TUI 接线必同改 `src/tui/App.tsx` + `src/tui/FullscreenApp.tsx`（默认跑 FullscreenApp，漏改即全废）。
- **新增会话影响面**：缺省路径（不传新 flag / 不敲新命令）行为必须完全不变，既有测试全绿。
- commit trailer：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 门控文案对齐 CC 语义（中文化，deepcode notice 惯例）：持久化关→"无法后台化——会话持久化已关闭，后台作业无从恢复。"；空会话→"还没内容可后台化——先发一条消息。"

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/config.ts` | 新增 `JOBS_DIR` 常量 | 改 |
| `src/backgroundSession.ts` | `JobState` 模型 + 落盘/枚举/格式化/清理 + `buildBackgroundArgv` 纯函数 | 新 |
| `src/backgroundRunner.ts` | `runBackgroundSession`：resume + 持久化 + job 生命周期 + SIGTERM | 新 |
| `src/index.ts` | `--resume <file>` / `--background-run` / `--job <short>` CLI 分支 | 改 |
| `src/tui/useChat.ts` | `/background`·`/bg` core 方法、`/stop` 命令、`/resume` 并入 bg、新 core 接口 | 改 |
| `src/tui/App.tsx` + `src/tui/FullscreenApp.tsx` | `/background` submit 路由（确认走 questionAsk）；页脚 bg 计数（可选） | 改 |
| `test/backgroundSession.test.ts` | Task 1 单测 | 新 |
| `test/backgroundRunner.test.ts` | Task 2 集成测试 | 新 |
| `test/backgroundCommand.test.ts` | Task 4/5 core 方法测试 | 新 |

---

### Task 1: JobState 模型 + 落盘（纯逻辑）

**Files:**
- Modify: `src/config.ts`（新增 `JOBS_DIR`）
- Create: `src/backgroundSession.ts`
- Test: `test/backgroundSession.test.ts`

**Interfaces:**
- Consumes: 无（叶子模块，只用 node fs/path/os）
- Produces:
  - `JOBS_DIR: string`（config.ts）
  - `interface JobState { sessionId, short, state, cwd, name, initialPrompt?, pid, model, permMode, sessionFile, backend, createdAt, updatedAt }`
  - `shortId(sessionId: string): string`
  - `jobStateDir(short: string): string`
  - `writeJobState(s: JobState): void`
  - `readJobState(short: string): JobState | null`
  - `updateJobState(short: string, patch: Partial<JobState>): JobState | null`
  - `listJobs(): JobState[]`
  - `formatJobList(jobs: JobState[], now: number): string`
  - `cleanupOldJobs(maxAgeMs: number, now: number): void`
  - `buildBackgroundArgv(a: { entry, resumeFile, short, seed?, permMode?, model? }): string[]`

- [ ] **Step 1: 新增 JOBS_DIR 常量**

在 `src/config.ts` 现有 `TASK_LISTS_DIR`（约 line 109）之后加：

```ts
/** 后台会话 job 状态落盘根目录（~/.deepcode/jobs/<short>/state.json） */
export const JOBS_DIR = path.join(os.homedir(), '.deepcode', 'jobs')
```

（`path`/`os` 已在 config.ts 顶部 import，无需新增。）

- [ ] **Step 2: 写失败测试 `test/backgroundSession.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  shortId, jobStateDir, writeJobState, readJobState, updateJobState,
  listJobs, formatJobList, cleanupOldJobs, buildBackgroundArgv, type JobState,
} from '../src/backgroundSession.js'

// 用临时 JOBS_DIR：backgroundSession 读 config.JOBS_DIR，测试用 env 覆盖 home
let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-jobs-'))
  process.env.DEEPCODE_TEST_HOME = tmp // config.JOBS_DIR 在 test 下改读此值（见 Step 4）
})
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.DEEPCODE_TEST_HOME })

function mkJob(over: Partial<JobState> = {}): JobState {
  return {
    sessionId: 'abcd1234efgh', short: 'abcd1234', state: 'working',
    cwd: '/proj', name: '跑个长任务', initialPrompt: '干活', pid: 4242,
    model: 'glm-5.2', permMode: 'default', sessionFile: '/s/abcd.jsonl',
    backend: 'detached', createdAt: 1000, updatedAt: 1000, ...over,
  }
}

describe('shortId', () => {
  it('取前 8 字符', () => { expect(shortId('abcd1234efgh')).toBe('abcd1234') })
})

describe('write/read/update', () => {
  it('往返一致', () => {
    const j = mkJob()
    writeJobState(j)
    expect(readJobState('abcd1234')).toEqual(j)
  })
  it('update 合并 patch 并保留其余字段', () => {
    writeJobState(mkJob())
    const upd = updateJobState('abcd1234', { state: 'stopped', updatedAt: 2000 })
    expect(upd?.state).toBe('stopped')
    expect(upd?.updatedAt).toBe(2000)
    expect(upd?.name).toBe('跑个长任务')
    expect(readJobState('abcd1234')?.state).toBe('stopped')
  })
  it('读不存在返回 null', () => { expect(readJobState('nope0000')).toBeNull() })
})

describe('listJobs', () => {
  it('枚举全部 job，坏文件跳过', () => {
    writeJobState(mkJob({ short: 'aaaa1111', sessionId: 'aaaa1111xxxx' }))
    writeJobState(mkJob({ short: 'bbbb2222', sessionId: 'bbbb2222xxxx' }))
    // 坏文件
    fs.mkdirSync(jobStateDir('cccc3333'), { recursive: true })
    fs.writeFileSync(path.join(jobStateDir('cccc3333'), 'state.json'), '{坏 json')
    const jobs = listJobs()
    expect(jobs.map(j => j.short).sort()).toEqual(['aaaa1111', 'bbbb2222'])
  })
  it('空目录返回 []', () => { expect(listJobs()).toEqual([]) })
})

describe('formatJobList', () => {
  it('每行含 short/state/name', () => {
    const out = formatJobList([mkJob()], 1000)
    expect(out).toContain('abcd1234')
    expect(out).toContain('working')
    expect(out).toContain('跑个长任务')
  })
})

describe('cleanupOldJobs', () => {
  it('删超龄终态 job，保留 working 与新 job', () => {
    writeJobState(mkJob({ short: 'old00000', sessionId: 'old00000xxx', state: 'completed', updatedAt: 0 }))
    writeJobState(mkJob({ short: 'run00000', sessionId: 'run00000xxx', state: 'working', updatedAt: 0 }))
    writeJobState(mkJob({ short: 'new00000', sessionId: 'new00000xxx', state: 'completed', updatedAt: 9_000_000 }))
    cleanupOldJobs(1000, 10_000_000)
    expect(readJobState('old00000')).toBeNull()      // 终态且超龄 → 删
    expect(readJobState('run00000')).not.toBeNull()  // working → 保留
    expect(readJobState('new00000')).not.toBeNull()  // 未超龄 → 保留
  })
})

describe('buildBackgroundArgv', () => {
  it('含 --background-run/--resume/--job；有 seed 加 -p；带 permMode/model', () => {
    const argv = buildBackgroundArgv({ entry: '/x/index.js', resumeFile: '/s/f.jsonl', short: 'abcd1234', seed: '继续', permMode: 'acceptEdits', model: 'glm-5.2' })
    expect(argv).toEqual(['/x/index.js', '--background-run', '--resume', '/s/f.jsonl', '--job', 'abcd1234', '-p', '继续', '--permission-mode', 'acceptEdits', '--model', 'glm-5.2'])
  })
  it('无 seed/无 permMode/无 model 时省略', () => {
    const argv = buildBackgroundArgv({ entry: '/x/index.js', resumeFile: '/s/f.jsonl', short: 'abcd1234' })
    expect(argv).toEqual(['/x/index.js', '--background-run', '--resume', '/s/f.jsonl', '--job', 'abcd1234'])
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run test/backgroundSession.test.ts`
Expected: FAIL（`Cannot find module '../src/backgroundSession.js'`）

- [ ] **Step 4: 实现 `src/backgroundSession.ts`**

```ts
// src/backgroundSession.ts
// 7.3 后台会话薄片：job 状态模型 + 落盘/枚举/格式化。纯逻辑，无 TUI 依赖。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export type JobStatus = 'working' | 'completed' | 'failed' | 'stopped'

export interface JobState {
  sessionId: string       // forked 会话 id（= sessionFile basename 去 .jsonl）
  short: string           // sessionId[:8]，job 目录名
  state: JobStatus
  cwd: string
  name: string            // 会话标题 / seed 首句，供列表展示
  initialPrompt?: string  // seed prompt（可空=续跑未完回合）
  pid: number             // detached 子进程 pid（供 /stop 杀；父进程 spawn 后回填）
  model: string
  permMode: string
  sessionFile: string     // forked JSONL 绝对路径（供 /resume 回看）
  backend: 'detached'
  createdAt: number
  updatedAt: number
}

/** 测试可用 DEEPCODE_TEST_HOME 覆盖 home，避免污染真实 ~/.deepcode/jobs。 */
function jobsRoot(): string {
  const home = process.env.DEEPCODE_TEST_HOME || os.homedir()
  return path.join(home, '.deepcode', 'jobs')
}

export function shortId(sessionId: string): string {
  return sessionId.slice(0, 8)
}

export function jobStateDir(short: string): string {
  return path.join(jobsRoot(), short)
}

function stateFile(short: string): string {
  return path.join(jobStateDir(short), 'state.json')
}

export function writeJobState(s: JobState): void {
  fs.mkdirSync(jobStateDir(s.short), { recursive: true })
  fs.writeFileSync(stateFile(s.short), JSON.stringify(s), { mode: 0o600 })
}

export function readJobState(short: string): JobState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile(short), 'utf8')) as JobState
  } catch { return null }
}

export function updateJobState(short: string, patch: Partial<JobState>): JobState | null {
  const cur = readJobState(short)
  if (!cur) return null
  const next = { ...cur, ...patch }
  writeJobState(next)
  return next
}

export function listJobs(): JobState[] {
  let dirs: string[]
  try { dirs = fs.readdirSync(jobsRoot()) } catch { return [] }
  const out: JobState[] = []
  for (const d of dirs) {
    const j = readJobState(d)
    if (j) out.push(j)
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function formatJobList(jobs: JobState[], now: number): string {
  if (jobs.length === 0) return '（无后台会话）'
  return jobs.map(j => {
    const age = Math.max(0, Math.round((now - j.createdAt) / 1000))
    return `${j.short}  [${j.state}]  ${j.name}  · ${j.cwd} · ${age}s 前`
  }).join('\n')
}

/** 删除超龄的终态 job（working 永不删）。启动时调一次。 */
export function cleanupOldJobs(maxAgeMs: number, now: number): void {
  for (const j of listJobs()) {
    if (j.state === 'working') continue
    if (now - j.updatedAt > maxAgeMs) {
      fs.rmSync(jobStateDir(j.short), { recursive: true, force: true })
    }
  }
}

/** 构造 detached 子进程 argv（纯函数，供 /background spawn 用）。 */
export function buildBackgroundArgv(a: {
  entry: string; resumeFile: string; short: string
  seed?: string; permMode?: string; model?: string
}): string[] {
  return [
    a.entry, '--background-run', '--resume', a.resumeFile, '--job', a.short,
    ...(a.seed ? ['-p', a.seed] : []),
    ...(a.permMode ? ['--permission-mode', a.permMode] : []),
    ...(a.model ? ['--model', a.model] : []),
  ]
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/backgroundSession.test.ts`
Expected: PASS（全部用例绿）

- [ ] **Step 6: 类型检查 + 提交**

```bash
npm run typecheck
git add src/config.ts src/backgroundSession.ts test/backgroundSession.test.ts
git commit -m "feat(bg-session): JobState 模型 + 落盘/枚举/argv 纯函数（7.3 Task1）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 后台运行器 runBackgroundSession

**Files:**
- Create: `src/backgroundRunner.ts`
- Test: `test/backgroundRunner.test.ts`

**Interfaces:**
- Consumes: `readJobState`/`updateJobState`/`shortId`（Task 1）；`loadSession`/`openSession`（session.ts）；`runLoop`（loop.ts）
- Produces: `runBackgroundSession(opts: { client: OpenAI; resumeFile: string; jobShort: string; seed?: string; yolo?: boolean; permMode?: string; flagSettingsPath?: string }): Promise<void>`

**说明**：本函数是 `runHeadless` 的后台变体——**不新建会话而是 resume 指定文件、把新消息持久化回该文件、维护 job 状态**。为不牵动既有 headless 路径（零回归风险），自成一体，工具集与 runHeadless 结构相同（有意的受控重复：后台路径在持久化 + job 生命周期上与 ephemeral headless 发散，强行共享会耦合两条语义）。

- [ ] **Step 1: 写失败测试 `test/backgroundRunner.test.ts`**

用 mock client（返回一条无工具调用的 assistant 消息即结束 loop），验证 resume + 状态机。

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { newSession } from '../src/session.js'
import { writeJobState, readJobState, type JobState } from '../src/backgroundSession.js'
import { runBackgroundSession } from '../src/backgroundRunner.js'

let tmp: string, sessDir: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-bgrun-'))
  process.env.DEEPCODE_TEST_HOME = tmp
  sessDir = path.join(tmp, 'sessions')
})
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.DEEPCODE_TEST_HOME })

// 一个只回一句、无 tool_calls 的 client（loop 立即 done）
function mockClient(reply = '后台跑完了') {
  return {
    chat: { completions: { create: vi.fn(async () => ({
      choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    })) } },
  } as any
}

function seedSession(): { file: string; short: string } {
  const h = newSession({ cwd: tmp, model: 'glm-5.2', thinking: false, permMode: 'default' }, sessDir)
  h.appendMessage({ role: 'system', content: 'sys' })
  h.appendMessage({ role: 'user', content: '先前的问题' }, 1)
  const short = path.basename(h.file).replace(/\.jsonl$/, '').slice(0, 8)
  return { file: h.file, short }
}

describe('runBackgroundSession', () => {
  it('resume 会话跑到 done → state completed，新消息落回同一文件', async () => {
    const { file, short } = seedSession()
    writeJobState({ sessionId: path.basename(file).replace(/\.jsonl$/, ''), short, state: 'working', cwd: tmp, name: 'x', pid: process.pid, model: 'glm-5.2', permMode: 'default', sessionFile: file, backend: 'detached', createdAt: 1, updatedAt: 1 })
    await runBackgroundSession({ client: mockClient(), resumeFile: file, jobShort: short, seed: '继续干' })
    expect(readJobState(short)?.state).toBe('completed')
    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).toContain('继续干')        // seed 落盘
    expect(raw).toContain('后台跑完了')     // assistant 回复落盘
  })

  it('client 抛错 → state failed', async () => {
    const { file, short } = seedSession()
    writeJobState({ sessionId: path.basename(file).replace(/\.jsonl$/, ''), short, state: 'working', cwd: tmp, name: 'x', pid: process.pid, model: 'glm-5.2', permMode: 'default', sessionFile: file, backend: 'detached', createdAt: 1, updatedAt: 1 })
    const bad = { chat: { completions: { create: vi.fn(async () => { throw new Error('boom') }) } } } as any
    await runBackgroundSession({ client: bad, resumeFile: file, jobShort: short, seed: 'x' })
    expect(readJobState(short)?.state).toBe('failed')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/backgroundRunner.test.ts`
Expected: FAIL（`Cannot find module '../src/backgroundRunner.js'`）

- [ ] **Step 3: 实现 `src/backgroundRunner.ts`**

以 `src/headless.ts` 的 `runHeadless` 为骨架，改三处：①用 `loadSession(resumeFile)` 的 messages 代替新建 initMsgs；②`openSession(resumeFile)` 句柄，seed 与每轮新消息 append 落盘；③进入设 env + 结束/异常/SIGTERM 更新 job 状态。工具集构造与 runHeadless 相同（复制该表达式，含 agent/workflow/webfetch/webSearch/bgTask/skill）。

```ts
// src/backgroundRunner.ts
// 7.3：/background detached 子进程的运行器。resume 会话续跑 + 持久化 + job 状态机。
import path from 'node:path'
import os from 'node:os'
import type OpenAI from 'openai'
import { runLoop } from './loop.js'
import { allTools } from './tools/index.js'
import { makeAgentTool } from './tools/agent.js'
import { makeWorkflowTool } from './tools/workflow.js'
import { runSubagent } from './subagentRunner.js'
import { resolveAgents } from './agentsLoader.js'
import { makeWebFetchTool } from './tools/webfetch.js'
import { makeWebSearchTool, resolveWebSearchConfig } from './tools/webSearchTool.js'
import { bgTaskListTool, taskOutputTool, taskStopTool } from './tools/taskTools.js'
import { taskCreateTool, taskGetTool, taskUpdateTool, taskListTool } from './tools/taskListTools.js'
import { installTaskCleanup } from './tasks.js'
import { buildSystemPrompt } from './prompt.js'
import { loadOutputStyles, resolveOutputStyle } from './outputStyles.js'
import { loadLayeredSettings } from './settingsLayers.js'
import { runHooks } from './hooks.js'
import { makeHookRuntime } from './hookRuntime.js'
import { initMcpTools } from './mcp.js'
import { loadSkills } from './skillsLoader.js'
import { makeSkillTool } from './tools/skill.js'
import { TaskListStore } from './taskList.js'
import { resolveDenyList, buildDenySourceMap } from './deny.js'
import { activeFastModel, resolveSubModel } from './providers.js'
import { loadSession, openSession, sessionIdFromFile } from './session.js'
import { updateJobState } from './backgroundSession.js'
import type { ToolContext, WorktreeSessionState } from './tools/types.js'
import type { Usage } from './api.js'

export async function runBackgroundSession(opts: {
  client: OpenAI; resumeFile: string; jobShort: string
  seed?: string; yolo?: boolean; permMode?: string; flagSettingsPath?: string
}): Promise<void> {
  process.env.DEEPCODE_SESSION_KIND = 'bg'
  installTaskCleanup()

  // SIGTERM（/stop 杀）→ 标 stopped 后退出
  const onTerm = () => { updateJobState(opts.jobShort, { state: 'stopped', updatedAt: Date.now() }); process.exit(0) }
  process.on('SIGTERM', onTerm)

  const loaded = loadSession(opts.resumeFile)
  const layered = loadLayeredSettings(loaded.meta.cwd || process.cwd(), opts.flagSettingsPath)
  const settings = layered.settings
  const denySources = buildDenySourceMap(layered.permissionSources.deny)
  const model = opts.model ?? loaded.meta.model ?? settings.model ?? activeFastModel()
  let cwd = loaded.meta.cwd || process.cwd()
  const agents = resolveAgents(cwd)
  const skills = loadSkills(cwd, undefined, settings.skills)
  const injectionBuffer: string[] = []
  const taskList = new TaskListStore()
  const sessionId = sessionIdFromFile(opts.resumeFile)
  taskList.bind(sessionId)
  const handle = openSession(opts.resumeFile)
  let worktreeState: WorktreeSessionState | null = null
  const ctx: ToolContext = {
    cwd: () => cwd,
    setCwd: d => { cwd = d },
    denyPatterns: () => resolveDenyList(settings.permissions.deny),
    signal: new AbortController().signal,
    fileState: new Map(loaded.fileState),
    taskList,
    hookDispatch: (event, payload) => runHooks(event, payload, settings.hooks),
    sessionId: () => sessionId,
    injectUserMessage: (c: string) => injectionBuffer.push(c),
    worktreeSession: { get: () => worktreeState, set: s => { worktreeState = s } },
    worktreeConfig: () => settings.worktree,
  }
  const total: Usage = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 }
  const addUsage = (u: Usage) => {
    total.prompt_tokens += u.prompt_tokens; total.completion_tokens += u.completion_tokens; total.prompt_cache_hit_tokens += u.prompt_cache_hit_tokens
  }
  const hookDeps = {
    ...makeHookRuntime({ client: opts.client, getModel: () => model, onUsage: (u, _m) => addUsage(u), cwd: () => cwd }),
    allowedHttpHookUrls: settings.allowedHttpHookUrls,
    httpHookAllowedEnvVars: settings.httpHookAllowedEnvVars,
  }
  ctx.hookDispatch = (event, payload) => runHooks(event, payload, settings.hooks, hookDeps)

  // resume：用已存消息续跑；若无 system 头则补一条（防空会话）
  const messages: any[] = loaded.messages.length
    ? [...loaded.messages]
    : [{ role: 'system', content: buildSystemPrompt(cwd, undefined, skills, settings.skills?.listingBudgetChars, undefined, resolveOutputStyle(settings.outputStyle, loadOutputStyles())) }]
  // seed prompt → 追加 user 消息并落盘（无 seed 时续跑未完回合，reply-on-resume）
  if (opts.seed) {
    const um = { role: 'user', content: opts.seed }
    messages.push(um)
    handle.appendMessage(um, loaded.maxTurnId + 1)
  }

  const { tools: mcpTools, cleanup: mcpCleanup } = await initMcpTools(settings.mcpServers, { onWarn: msg => process.stderr.write(msg + '\n') })
  const lenBefore = messages.length
  const gen = runLoop(messages, {
    client: opts.client,
    tools: [...allTools, taskCreateTool, taskGetTool, taskUpdateTool, taskListTool, makeAgentTool({ client: opts.client, onUsage: (u, _model) => addUsage(u), getModel: () => model, agents, worktree: settings.worktree }), makeWorkflowTool({ client: opts.client, onUsage: (u, _model) => addUsage(u), sessionModel: model, agents, runSubagent, journalDir: path.join(cwd, '.deepcode', 'workflows'), resolveModelAlias: (m: string) => resolveSubModel(m, model) }), makeWebFetchTool({ client: opts.client, onUsage: (u, _model) => addUsage(u) }), makeWebSearchTool({ config: resolveWebSearchConfig(settings) }), bgTaskListTool, taskOutputTool, taskStopTool, ...mcpTools, makeSkillTool(skills, { client: opts.client, onUsage: (u, _m) => addUsage(u), getModel: () => model, agents, skillPool: [...allTools, makeWebFetchTool({ client: opts.client, onUsage: (u, _m) => addUsage(u) })], listingBudgetChars: settings.skills?.listingBudgetChars })],
    model,
    thinking: false,
    maxToolResultChars: settings.maxToolResultChars,
    ctx,
    permission: {
      mode: opts.yolo ? 'yolo' : (opts.permMode as any) || 'default',
      rules: settings.permissions.allow,
      deny: resolveDenyList(settings.permissions.deny),
      cwd,
      saveRule: () => {},
      ask: async () => 'no', // 后台无人值守：默认拒绝，理由喂回模型
      ruleSources: layered.permissionSources.allow,
      denySources,
    },
    reminders: () => { taskList.tick(); const n = taskList.staleReminder(); return n ? [n] : [] },
    drainInjections: () => injectionBuffer.splice(0),
    injectTaskNotifications: true,
    hooks: settings.hooks,
    hookDeps,
  })
  try {
    let step
    while (!(step = await gen.next()).done) { const ev = step.value; if (ev.type === 'turn_end') addUsage(ev.usage) }
    // 落盘本轮新增消息 + fileState 快照
    for (const m of messages.slice(lenBefore)) handle.appendMessage(m)
    handle.appendFileState([...ctx.fileState])
    updateJobState(opts.jobShort, { state: 'completed', updatedAt: Date.now() })
  } catch (e) {
    try { for (const m of messages.slice(lenBefore)) handle.appendMessage(m) } catch {}
    updateJobState(opts.jobShort, { state: 'failed', updatedAt: Date.now() })
  } finally {
    process.off('SIGTERM', onTerm)
    await mcpCleanup()
  }
}
```

> 注：`opts.model` 在接口未列——补进签名。修 Step 3 首行接口为含 `model?: string`。（见下 Step 3b。）

- [ ] **Step 3b: 接口补 model 字段**

把 `runBackgroundSession` 签名的 opts 加 `model?: string`：

```ts
export async function runBackgroundSession(opts: {
  client: OpenAI; resumeFile: string; jobShort: string
  seed?: string; yolo?: boolean; permMode?: string; model?: string; flagSettingsPath?: string
}): Promise<void> {
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/backgroundRunner.test.ts`
Expected: PASS（completed / failed 两用例绿；若 mock client 形状与 loop 不符，比对 `test/` 下既有 loop/headless 测试的 mock 结构对齐）

- [ ] **Step 5: 类型检查 + 提交**

```bash
npm run typecheck
git add src/backgroundRunner.ts test/backgroundRunner.test.ts
git commit -m "feat(bg-session): runBackgroundSession 运行器（resume+持久化+job 状态机）（7.3 Task2）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: CLI 接线（--resume / --background-run / --job）

**Files:**
- Modify: `src/index.ts`
- Test: 手动 + 依赖 Task 4 冒烟（纯分支接线，逻辑薄）

**Interfaces:**
- Consumes: `runBackgroundSession`（Task 2）
- Produces: CLI 认 `--background-run`（内部）+ `--resume <file>` + `--job <short>`

- [ ] **Step 1: 在 `src/index.ts` 顶部解析新 flag**

在现有 flag 解析（约 line 12）后加：

```ts
const bgRun = argv.includes('--background-run')
const resumeIdx = argv.indexOf('--resume')
const resumeFile = resumeIdx >= 0 ? argv[resumeIdx + 1] : undefined
const jobIdx = argv.indexOf('--job')
const jobShort = jobIdx >= 0 ? argv[jobIdx + 1] : undefined
const permIdx = argv.indexOf('--permission-mode')
const permMode = permIdx >= 0 ? argv[permIdx + 1] : undefined
const modelIdx = argv.indexOf('--model')
const modelFlag = modelIdx >= 0 ? argv[modelIdx + 1] : undefined
```

- [ ] **Step 2: 在 `try {` 内最前面加 background-run 分支**

在 `if (pIdx !== -1) {`（line 15）**之前**插入（后台运行优先于 -p/stdin/TTY 判定）：

```ts
  if (bgRun) {
    if (!resumeFile || !jobShort) throw new Error('--background-run 需 --resume <file> 与 --job <short>')
    const client = createClient(flagSettingsPath)
    const { runBackgroundSession } = await import('./backgroundRunner.js')
    // seed = -p 之后的值（父进程用 -p 传 seed）；无 -p 则续跑未完回合
    const seed = pIdx !== -1 ? argv[pIdx + 1] : undefined
    await runBackgroundSession({ client, resumeFile, jobShort, seed, yolo, permMode, model: modelFlag, flagSettingsPath })
    process.exit(0)
  } else if (pIdx !== -1) {
```

（即把原 `if (pIdx !== -1) {` 改成 `} else if (pIdx !== -1) {` 接在新分支后。）

- [ ] **Step 3: 类型检查 + 构建**

Run: `npm run typecheck && npm run build`
Expected: 通过，无类型错误

- [ ] **Step 4: 手动烟验 CLI 分派（无网络）**

Run: `node dist/index.js --background-run 2>&1 | head -1`
Expected: 打印 `--background-run 需 --resume <file> 与 --job <short>`（证分支已接入）

- [ ] **Step 5: 提交**

```bash
git add src/index.ts
git commit -m "feat(bg-session): CLI --background-run/--resume/--job 分派（7.3 Task3）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: /background 命令（fork + spawn + 退出）

**Files:**
- Modify: `src/tui/useChat.ts`（新 core 方法 `backgroundSession` + `/background` 命令分支 + 接口 `backgroundSession`）
- Test: `test/backgroundCommand.test.ts`

**Interfaces:**
- Consumes: `buildBackgroundArgv`/`writeJobState`/`shortId`（Task 1）；`newSession`/`listSessions`/`nextBranchTitle`/`stripBranchSuffix`（session.ts）
- Produces: `ChatCore.backgroundSession(seed?: string): Promise<{ ok: boolean; message: string; spawned?: boolean }>`；`/background`·`/bg` 命令

**说明**：core 方法只负责**门控 + fork + 写初始 state + spawn + 返回结果**（不含 `process.exit`——退出由 UI 层做，便于测试）。确认弹窗走 App/FullscreenApp 的 `questionAsk`（Task 6）。spawn 用依赖注入以便测试。

- [ ] **Step 1: 写失败测试 `test/backgroundCommand.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// 通过 createChatCore 造 core，注入 mock client + spawn。参考既有 test/tui.useChat*.test.ts 的建 core 方式。
import { createChatCore } from '../src/tui/useChat.js'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-bgcmd-'))
  process.env.DEEPCODE_TEST_HOME = tmp
})
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.DEEPCODE_TEST_HOME })

// 说明：createChatCore 的确切入参以既有测试为准（client/cwd/sessionDir/runSubagent/loadLayeredSettings mock）。
// 断言重点：
//  1) 空会话时 backgroundSession() 返回 { ok:false }，不 spawn。
//  2) 有消息时 fork 出新会话文件（原文件不变）、写 working state、调 spawn 且 argv 含 --background-run。

describe('backgroundSession core', () => {
  it('空会话拒绝、不 spawn', async () => {
    const spawn = vi.fn()
    const core = makeCore({ spawn }) // 见 helper（按既有测试封装）
    const r = await core.backgroundSession()
    expect(r.ok).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('有消息 → fork 文件 + 写 state + spawn argv 正确', async () => {
    const spawn = vi.fn(() => ({ pid: 5555, unref: () => {} }))
    const core = makeCore({ spawn })
    await core.send('先发一句') // 走 mock client 跑一轮，产生消息
    const r = await core.backgroundSession('继续在后台干')
    expect(r.ok).toBe(true)
    expect(spawn).toHaveBeenCalledOnce()
    const argv = spawn.mock.calls[0][1] as string[]
    expect(argv).toContain('--background-run')
    expect(argv).toContain('--job')
    // fork 出的会话文件存在于 sessions 目录，且 state.json working
    const jobsDir = path.join(tmp, '.deepcode', 'jobs')
    const shorts = fs.readdirSync(jobsDir)
    expect(shorts.length).toBe(1)
    const st = JSON.parse(fs.readFileSync(path.join(jobsDir, shorts[0], 'state.json'), 'utf8'))
    expect(st.state).toBe('working')
    expect(st.pid).toBe(5555)
  })
})
```

> **实现者注**：`makeCore` helper 按 `test/` 下既有 `tui.useChat*.test.ts` 建 core 的模式封装（mock `config.loadLayeredSettings` 钉空 permissions、禁 memory、mock client）。`spawn` 依赖注入见 Step 2。

- [ ] **Step 2: `createChatCore` 增加可注入 spawn（默认 child_process.spawn）**

在 `createChatCore` 的 opts 类型加可选 `spawnFn?: typeof import('node:child_process').spawn`；核心内 `const spawnBg = opts.spawnFn ?? (await import('node:child_process')).spawn`（或顶部静态 import 并允许覆盖）。用于测试注入。

- [ ] **Step 3: 实现 core 方法 `backgroundSession`**

在 useChat.ts 的 core 对象构造区（`/fork` 逻辑附近可参考）加内部函数，并在返回的 core 接口暴露：

```ts
const backgroundSession = async (seed?: string): Promise<{ ok: boolean; message: string; spawned?: boolean }> => {
  // 门控：空会话（除 system 外无消息）
  const hasContent = messages.some(m => m.role === 'user' || m.role === 'assistant')
  if (!hasContent) { const message = '还没内容可后台化——先发一条消息。'; notice('warn', message); return { ok: false, message } }

  // fork 当前会话到新文件（复用 /fork 逻辑：拷消息，标题 (Branch)）
  const base = stripBranchSuffix(currentTitle ?? (() => {
    const fu = messages.find(m => m.role === 'user' && typeof m.content === 'string')
    return typeof fu?.content === 'string' ? fu.content.slice(0, 40) : '会话'
  })())
  const forkTitle = nextBranchTitle(base, listSessions(cwd, sessionDir).map(s => s.preview))
  const forkMeta = { cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id, title: forkTitle }
  const forkS = newSession(forkMeta, sessionDir)
  for (const m of messages) forkS.appendMessage(m, turnOf.get(m))
  const forkedId = sessionIdFromFile(forkS.file)
  const short = shortId(forkedId)

  // 写初始 working state（pid 待回填）
  const now = Date.now()
  writeJobState({
    sessionId: forkedId, short, state: 'working', cwd, name: seed?.slice(0, 40) || forkTitle,
    initialPrompt: seed, pid: 0, model, permMode, sessionFile: forkS.file, backend: 'detached',
    createdAt: now, updatedAt: now,
  })

  // spawn detached 子进程
  const argv = buildBackgroundArgv({ entry: process.argv[1], resumeFile: forkS.file, short, seed, permMode, model })
  const child = spawnBg(process.execPath, argv.slice(1), { detached: true, stdio: 'ignore' })
  child.unref()
  if (child.pid) updateJobState(short, { pid: child.pid })

  return { ok: true, spawned: true, message: `已送到后台（${short}）。终端已释放。用 /resume 回看，/stop ${short} 停止。` }
}
```

（注：`buildBackgroundArgv` 首元素是 entry，spawn 第二参用 `argv.slice(1)`；或让 `buildBackgroundArgv` 不含 entry——二选一，保持与 Task1 测试一致：Task1 argv 含 entry，故此处 `spawnBg(process.execPath, argv.slice(1), ...)`。需 import `updateJobState`、`writeJobState`、`shortId`、`buildBackgroundArgv`、`sessionIdFromFile`。）

- [ ] **Step 4: core 接口暴露 `backgroundSession`（不在 send() 里拦 /background）**

`/background` 的交互（确认弹窗 + 退出释放终端）全在 App/FullscreenApp 层做（Task 6），与 `/exit`/`/resume` 走 App.tsx 拦截同款——core 方法只负责门控+fork+spawn+返回，**不** `process.exit`（便于测试）。因此本步**不**在 `send()` 里加 `/background` 分支。

只做两件：
1. 在 core 返回对象（约 line 1421 `return {`）加 `backgroundSession,`。
2. ChatCore 接口（约 line 266-292）加 `backgroundSession(seed?: string): Promise<{ ok: boolean; message: string; spawned?: boolean }>`。

门控失败（空会话）时由 `backgroundSession` 内部直接 `notice('warn', '还没内容可后台化——先发一条消息。')` 再返回 `{ ok:false, message }`（把 Task 4 Step 3 的空会话分支改为先 `notice` 后 return），这样 App 层只需在 `r.ok` 为真时 `exit()`，失败原因已由 core 提示。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/backgroundCommand.test.ts`
Expected: PASS

- [ ] **Step 6: 全量回归 + 类型 + 提交**

```bash
npx vitest run && npm run typecheck
git add src/tui/useChat.ts test/backgroundCommand.test.ts
git commit -m "feat(bg-session): backgroundSession core（门控+fork+spawn+state）（7.3 Task4）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: /stop 命令（列表 / 按 id 杀）

**Files:**
- Modify: `src/tui/useChat.ts`
- Test: `test/backgroundCommand.test.ts`（追加）

**Interfaces:**
- Consumes: `listJobs`/`readJobState`/`updateJobState`/`formatJobList`（Task 1）
- Produces: `/stop [id]` 命令（无 id 列表；有 id 杀 pid + 标 stopped）

- [ ] **Step 1: 追加失败测试**

```ts
describe('/stop 命令', () => {
  it('无 id → 列出运行中 job', async () => {
    // 预置两个 working job（writeJobState）+ 建 core，敲 /stop
    // 断言 notice 文本含两个 short
  })
  it('有 id → process.kill(pid,SIGTERM) + state stopped', async () => {
    const kill = vi.fn()
    // 注入 killFn，预置 job pid=9999，敲 /stop <short>
    // 断言 kill 调用 (9999,'SIGTERM')，readJobState(short).state==='stopped'
  })
  it('未知 id → 提示找不到', async () => { /* /stop nope0000 → warn */ })
})
```

- [ ] **Step 2: `createChatCore` 增加可注入 killFn（默认 process.kill）**

opts 加 `killFn?: (pid: number, sig: string) => void`；核心内 `const killProc = opts.killFn ?? ((p: number, s: string) => process.kill(p, s as any))`。

- [ ] **Step 3: 实现 `/stop` 命令分支**

在 send() 命令区加：

```ts
if (line === '/stop' || line.startsWith('/stop ')) {
  const id = line.slice('/stop'.length).trim()
  if (!id) {
    const running = listJobs().filter(j => j.state === 'working')
    notice('info', running.length ? `运行中的后台会话：\n${formatJobList(running, Date.now())}\n用 /stop <id> 停止` : '（无运行中的后台会话）')
    return
  }
  const job = readJobState(id)
  if (!job) { notice('warn', `找不到后台会话 ${id}`); return }
  if (job.state !== 'working') { notice('info', `${id} 已是 ${job.state}`); return }
  try { killProc(job.pid, 'SIGTERM') } catch (e: any) { notice('warn', `杀进程失败：${e?.message ?? e}`) }
  updateJobState(id, { state: 'stopped', updatedAt: Date.now() })
  notice('info', `已停止后台会话 ${id}（transcript 保留，可 /resume 回看）`)
  return
}
```

需 import `listJobs`、`readJobState`、`updateJobState`、`formatJobList`。

- [ ] **Step 4: 跑测试 + 回归**

Run: `npx vitest run test/backgroundCommand.test.ts && npx vitest run`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tui/useChat.ts test/backgroundCommand.test.ts
git commit -m "feat(bg-session): /stop 命令（列表/按 id 杀）（7.3 Task5）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: TUI 接线（/background 确认+退出、/resume 并入 bg、页脚计数）

**Files:**
- Modify: `src/tui/App.tsx` + `src/tui/FullscreenApp.tsx`（双改）
- Modify: `src/tui/useChat.ts`（`resumeList` 并入 bg 会话；帮助文案加 /background /stop）

**Interfaces:**
- Consumes: `core.backgroundSession`（Task 4）、`questionAsk`（既有 AskUserQuestion 桥）、`listJobs`（Task 1）
- Produces: `/background` 交互（确认弹窗 → 调 core → 退出释放终端）；`/resume` picker 含 bg 会话

- [ ] **Step 1: App.tsx submit() 拦截 /background**

在 `submit`（App.tsx line 138）里，`/exit` 拦截旁加（复用现有 `questionAsk` 走 pendingQuestion 渲染，与 AskUserQuestion 同 UI，无新组件）：

```tsx
if (text === '/background' || text === '/bg' || text.startsWith('/background ') || text.startsWith('/bg ')) {
  const seed = text.replace(/^\/(background|bg)\s?/, '').trim() || undefined
  void (async () => {
    const ans = await core.askConfirm('把当前会话送到后台并释放终端？', '后台会话', '送到后台', '留在前台')
    if (!ans) return
    const r = await core.backgroundSession(seed)
    if (!r.ok) return // core 已 notice 失败原因；实为门控，留前台
    exit() // 释放终端，回 shell（子进程已 detached 继续跑）
  })()
  return
}
```

- [ ] **Step 2: core 暴露 `askConfirm`（包装 questionAsk）**

在 useChat.ts core 加：

```ts
const askConfirm = async (question: string, header: string, yes: string, no: string): Promise<boolean> => {
  const ans = await questionAsk([{ question, header, multiSelect: false, options: [{ label: yes, description: '' }, { label: no, description: '' }] }])
  return !!ans && ans[0]?.selected?.[0] === yes
}
```

core 接口加 `askConfirm(...)`；返回对象加 `askConfirm,`。

（门控在 core.backgroundSession 内已做——若空会话，`backgroundSession` 返回 `ok:false` 且**在 App 里需先 notice**。修正：让 App 在 `!r.ok` 时 `core` 已 notice。为此 `backgroundSession` 失败时自身调 `notice`。或 App 显式 notice r.message。**采用**：App 在 `!r.ok` 时 `core.notice?.` 不可得——改为 `backgroundSession` 内部空会话直接 `notice('warn', ...)` 再返回 ok:false。把 Task 4 Step 3 的门控分支改为调用内部 `notice` 后 return。）

- [ ] **Step 3: FullscreenApp.tsx 同步接线**

在 FullscreenApp 的 submit 等价处（对照 App.tsx line 138-165 的命令拦截块）加**完全相同**的 `/background` 拦截。**务必双改**，默认全屏跑 FullscreenApp，漏改即整功能失效。

- [ ] **Step 4: /resume 并入 bg 会话**

改 useChat.ts `resumeList`（line 1476）合并 bg 会话文件：

```ts
resumeList: () => {
  const sessions = listSessions(cwd, sessionDir).slice(0, 10).map(s => ({ file: s.file, preview: s.preview }))
  const bg = listJobs().filter(j => j.cwd === cwd).map(j => ({ file: j.sessionFile, preview: `[bg ${j.state}] ${j.name}` }))
  const seen = new Set(sessions.map(s => s.file))
  return [...bg.filter(b => !seen.has(b.file)), ...sessions].slice(0, 15)
},
```

- [ ] **Step 5: 帮助文案 + 页脚计数（可选，双改）**

- 帮助串（line 307）加：`/background 或 /bg [prompt] 把会话送到后台并释放终端\n/stop [id] 列出/停止后台会话`。
- （可选）页脚：App + FullscreenApp 页脚读 `listJobs().filter(j=>j.state==='working').length`，>0 时显示 `⚙ 后台 N`。若冒烟觉得噪音大可砍。

- [ ] **Step 6: 构建 + 全量回归**

Run: `npm run build && npx vitest run && npm run typecheck`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add src/tui/App.tsx src/tui/FullscreenApp.tsx src/tui/useChat.ts
git commit -m "feat(bg-session): TUI 接线（/background 确认+退出、/resume 并入 bg、帮助）（7.3 Task6）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 真机冒烟（不可省）

**Files:** 无（手动验证）

**前置**：`npm run build`。用本地构建跑：`node dist/index.js`（**勿用全局旧 deepcode**——教训：跑错二进制）。provider 用 glm（glm-5.2 或 glm-5-turbo）。

- [ ] **Step 1: background 一个长任务**

启动 `node dist/index.js` → 发 `帮我把当前目录 README 每一节都扩写一段`（或任一多轮任务）→ 敲 `/background`。
验证：确认弹窗「把当前会话送到后台并释放终端？」出现 → 选「送到后台」→ **TUI 退出、回到 shell 提示符（终端释放）**。

- [ ] **Step 2: 验证子进程在跑 + state 落盘**

Run: `ls ~/.deepcode/jobs/ && cat ~/.deepcode/jobs/*/state.json`
Expected: 有 `<short>/state.json`，`state:"working"`，`pid` 是活进程。
Run: `ps -p <pid>`
Expected: 进程存在（detached headless 子进程在跑）。

- [ ] **Step 3: /stop 杀掉**

新开 `node dist/index.js` → 敲 `/stop`（列出运行中）→ 敲 `/stop <short>`。
Expected: notice「已停止后台会话 <short>」；`cat state.json` → `state:"stopped"`；`ps -p <pid>` → 进程已退。

- [ ] **Step 4: /resume 回看**

同一 TUI 敲 `/resume` → 列表含 `[bg stopped] …` → 选中 → 看到 background 期间续跑的 transcript（若在 stop 前跑完则见完整回复）。

- [ ] **Step 5: 完成态验证（另跑一次不 stop）**

再 background 一个短任务（如 `列出当前目录文件`）→ 等几秒 → `cat ~/.deepcode/jobs/<short>/state.json` → `state:"completed"`。

- [ ] **Step 6: 记录冒烟结果**

把冒烟观察（终端释放/子进程/stop/resume/completed 五点）记入 `.superpowers/sdd/progress.md` 或 commit message。如发现单测漏掉的真机 bug（参考历史：ink/页脚/spawn 环境差异），先 systematic-debugging 定根因再修，补回归测试。

---

## Self-Review

**1. Spec coverage**（逐条对 spec §三/§四/§五/§六）：
- 进程模型 fork+resume+detached+退出 → Task 4（fork+spawn）+ Task 3（CLI）+ Task 6（退出）✓
- 后台运行器 resume+持久化+state 生命周期+SIGTERM → Task 2 ✓
- Job 状态 `~/.deepcode/jobs/<short>/state.json` + schema + list/format/cleanup → Task 1 ✓
- `/background`·`/bg` + 门控文案 + 确认弹窗 → Task 4（门控/fork/spawn）+ Task 6（确认/退出）✓
- `/stop [id]` 列表/杀（偏离已实现为前台按 id 杀）→ Task 5 ✓
- `/resume` 并入 bg → Task 6 Step 4 ✓
- 双 TUI 组件 → Task 6 Step 1/3（App+FullscreenApp）✓
- 页脚计数（可选）→ Task 6 Step 5 ✓
- 预留 reattach 钩子（SESSION_KIND env + state 写 pid）→ Task 2（env）+ Task 4（pid 回填）✓
- 测试策略（纯函数/CLI/fork/门控/runner/spawn/回归/真机冒烟）→ Task 1-7 ✓
- 押后红线（daemon/PTY/attach/loops）→ 全程不实现 ✓

**2. Placeholder scan**：无 TBD/TODO；每步含实际代码/命令/期望输出。Task 4 Step 4 有一处「修正」自反省（改为 App 层退出）——已在文中明确最终采用 App 层退出，core 只 spawn+返回。Task 2 Step 3b 补 `model?` 字段已显式列出。

**3. Type consistency**：
- `JobState` 字段贯穿 Task 1（定义）→ Task 2（updateJobState）→ Task 4（writeJobState 全字段）一致。
- `runBackgroundSession` 签名含 `model?`（Step 3b 补齐），与 index.ts 调用（Task 3 传 `model: modelFlag`）一致。
- `buildBackgroundArgv` 返回含 entry 首元素（Task 1 测试）↔ Task 4 spawn 用 `argv.slice(1)` 一致。
- `backgroundSession` 返回 `{ ok, message, spawned? }` 贯穿 Task 4（定义/接口）→ Task 6（App 调用 `r.ok`）一致。
- `askConfirm(question, header, yes, no): Promise<boolean>` Task 6 Step 2 定义 ↔ Step 1 调用签名一致。

**已修**：Task 4 的 send()-内退出派发与 App-层退出二选一 → 统一为 **App 层退出**（core 不 process.exit，便于测试）；Task 6 Step 2 注明空会话门控由 `backgroundSession` 内部 notice。
