# L-042 ①b-3 Hooks env-file 机制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 CC 式 session 环境文件机制——Setup/SessionStart/CwdChanged/FileChanged hook 经 `DEEPCODE_ENV_FILE` 写 env，Bash 工具执行前按优先级串联注入命令前缀；顺手 fold 两个 ①b-2 终审遗留 minor。

**Architecture:** 新增纯模块 `src/sessionEnv.ts`（路径助手 + 优先级 assemble + cwd 清理 + 单槽缓存），全保真对齐 CC `utils/sessionEnvironment.ts`/`bashProvider.ts`。引擎 `src/hooks.ts` 做最小手术：`HookEngineDeps` 加 `sessionEnvBase?`，env-file 四事件的 command hook 注入 `DEEPCODE_ENV_FILE`（per-event/per-index 路径，从 `payload.session_id` 派生，零 deps 线穿透）。`bash.ts` 前台/后台执行前读前缀；CwdChanged 改 await + 清 cwd env + 失效缓存。

**Tech Stack:** TypeScript/ESM、vitest、Node `child_process`/`fs`/`os`/`path`。

**CC 对齐基线（实读 `~/Desktop/src`，本会话确认）：**
- env 变量名 `CLAUDE_ENV_FILE` → deepcode `DEEPCODE_ENV_FILE`。
- 文件名 `{event.toLowerCase()}-hook-{index}.sh`；目录 `~/.claude/session-env/{sessionId}/` → deepcode `~/.deepcode/session-env/{sessionId}/`。
- 注入 env 的事件**仅** Setup/SessionStart/CwdChanged/FileChanged。
- assemble：glob 目录 → regex `^(setup|sessionstart|cwdchanged|filechanged)-hook-(\d+)\.sh$` 过滤 → 按 **优先级 setup(0)<sessionstart(1)<cwdchanged(2)<filechanged(3)，同类按 index 数字** 排序 → 各文件 `readFile().trim()` 非空入数组 → `join('\n')`。
- 模块级缓存，cwd 变更失效；`clearCwdEnvFiles` 把 cwdchanged-*/filechanged-* 文件清空。
- 前台 + 后台 bash 都拿前缀。
- **deepcode 简化（YAGNI）**：不实现 CC 的「读父进程 `CLAUDE_ENV_FILE`（venv/conda 激活）」分支，只读 session 目录内 hook 文件。

---

## File Structure

- **Create** `src/sessionEnv.ts` — 路径助手、env-file 事件集、优先级 assemble、cwd 清理、单槽缓存。纯 IO 工具，全单测覆盖。
- **Create** `test/sessionEnv.test.ts` — 上述模块单测。
- **Modify** `src/hooks.ts` — `HookEngineDeps.sessionEnvBase?`；`runHooks` 为 env-file 事件的 command hook 算 per-index 路径并 mkdir；`execCommandHook` 注入 `DEEPCODE_ENV_FILE`。
- **Modify** `test/hooks.test.ts` — 引擎注入 env 的单测。
- **Modify** `src/tools/bash.ts` — 前台/后台前缀注入；CwdChanged 改 async await + 清 cwd env + 失效缓存 + 补 `session_id`/`cwd` payload。
- **Modify** `test/tools.bash.test.ts` — 前缀注入 + CwdChanged 失效的单测。
- **Modify** `src/config.ts` — `saveApiKey` 区分 `trigger: 'init' | 'maintenance'`（fold minor 1）。
- **Modify** `test/config.test.ts`（或新增）— Setup trigger 区分单测。
- **Modify** `test/headless.test.ts` — headless SessionStart/InstructionsLoaded dispatch 路径补测（fold minor 2）。

---

## Task 1: `src/sessionEnv.ts` 模块（路径/assemble/清理/缓存）

**Files:**
- Create: `src/sessionEnv.ts`
- Test: `test/sessionEnv.test.ts`

- [ ] **Step 1: 写失败测试**

`test/sessionEnv.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ENV_FILE_EVENTS, hookEnvFileName, sessionEnvDirFor, ensureSessionEnvDir,
  getSessionEnvScript, clearCwdEnvFiles, invalidateSessionEnvCache,
} from '../src/sessionEnv.js'

let base: string
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'deepcode-senv-'))
  invalidateSessionEnvCache() // 清单槽缓存，隔离用例
})

describe('sessionEnv 基础', () => {
  it('ENV_FILE_EVENTS 恰为四事件', () => {
    expect([...ENV_FILE_EVENTS].sort()).toEqual(['CwdChanged', 'FileChanged', 'SessionStart', 'Setup'])
  })

  it('hookEnvFileName 小写事件 + index', () => {
    expect(hookEnvFileName('SessionStart', 0)).toBe('sessionstart-hook-0.sh')
    expect(hookEnvFileName('CwdChanged', 2)).toBe('cwdchanged-hook-2.sh')
  })

  it('sessionEnvDirFor 拼 base/sessionId', () => {
    expect(sessionEnvDirFor('sess-1', base)).toBe(path.join(base, 'sess-1'))
  })

  it('ensureSessionEnvDir 创建目录并返回路径', () => {
    const dir = ensureSessionEnvDir('sess-1', base)
    expect(dir).toBe(path.join(base, 'sess-1'))
    // 再写文件不报错即证明目录存在
    writeFileSync(path.join(dir, 'x'), 'y')
    expect(readFileSync(path.join(dir, 'x'), 'utf8')).toBe('y')
  })
})

describe('getSessionEnvScript assemble', () => {
  it('无目录 → 空串', () => {
    expect(getSessionEnvScript('nope', base)).toBe('')
  })

  it('按优先级 setup<sessionstart<cwdchanged<filechanged + index 排序拼接，trim 空文件跳过', () => {
    const dir = ensureSessionEnvDir('s', base)
    writeFileSync(path.join(dir, 'cwdchanged-hook-0.sh'), 'export C=3\n')
    writeFileSync(path.join(dir, 'sessionstart-hook-1.sh'), 'export B2=2b\n')
    writeFileSync(path.join(dir, 'sessionstart-hook-0.sh'), 'export B=2\n')
    writeFileSync(path.join(dir, 'setup-hook-0.sh'), 'export A=1\n')
    writeFileSync(path.join(dir, 'filechanged-hook-0.sh'), '   \n') // 全空白 → 跳过
    writeFileSync(path.join(dir, 'ignore.sh'), 'export Z=9\n')       // 不匹配 regex → 跳过
    expect(getSessionEnvScript('s', base)).toBe('export A=1\nexport B=2\nexport B2=2b\nexport C=3')
  })

  it('单槽缓存：同 sid+base 重复调用不重读（写新文件后须 invalidate 才生效）', () => {
    const dir = ensureSessionEnvDir('s', base)
    writeFileSync(path.join(dir, 'setup-hook-0.sh'), 'export A=1')
    expect(getSessionEnvScript('s', base)).toBe('export A=1')
    writeFileSync(path.join(dir, 'sessionstart-hook-0.sh'), 'export B=2')
    expect(getSessionEnvScript('s', base)).toBe('export A=1') // 命中缓存，未见新文件
    invalidateSessionEnvCache('s')
    expect(getSessionEnvScript('s', base)).toBe('export A=1\nexport B=2')
  })
})

describe('clearCwdEnvFiles', () => {
  it('清空 cwdchanged-*/filechanged-* 文件内容，保留 setup/sessionstart，并失效缓存', () => {
    const dir = ensureSessionEnvDir('s', base)
    writeFileSync(path.join(dir, 'setup-hook-0.sh'), 'export A=1')
    writeFileSync(path.join(dir, 'cwdchanged-hook-0.sh'), 'export C=3')
    writeFileSync(path.join(dir, 'filechanged-hook-0.sh'), 'export F=4')
    expect(getSessionEnvScript('s', base)).toBe('export A=1\nexport C=3\nexport F=4') // 装缓存
    clearCwdEnvFiles('s', base)
    expect(readFileSync(path.join(dir, 'setup-hook-0.sh'), 'utf8')).toBe('export A=1')
    expect(readFileSync(path.join(dir, 'cwdchanged-hook-0.sh'), 'utf8')).toBe('')
    expect(readFileSync(path.join(dir, 'filechanged-hook-0.sh'), 'utf8')).toBe('')
    expect(getSessionEnvScript('s', base)).toBe('export A=1') // 缓存已失效，重读
  })

  it('目录不存在 → 静默 no-op', () => {
    expect(() => clearCwdEnvFiles('absent', base)).not.toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/sessionEnv.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/sessionEnv.ts`**

```ts
// src/sessionEnv.ts —— CC 式 session 环境文件机制（对齐 ~/Desktop/src/utils/sessionEnvironment.ts）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { HookEvent } from './hooks.js'

/** 默认 session-env 根目录（按 sessionId 隔离，不跨会话）。 */
export const DEFAULT_SESSION_ENV_BASE = path.join(os.homedir(), '.deepcode', 'session-env')

/** 仅这四类事件的 command hook 会被注入 DEEPCODE_ENV_FILE（对齐 CC）。 */
export const ENV_FILE_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>([
  'Setup', 'SessionStart', 'CwdChanged', 'FileChanged',
])

/** 拼接优先级：小者先注入（被大者覆盖）。对齐 CC HOOK_ENV_PRIORITY。 */
const PRIORITY: Record<string, number> = { setup: 0, sessionstart: 1, cwdchanged: 2, filechanged: 3 }
const HOOK_ENV_REGEX = /^(setup|sessionstart|cwdchanged|filechanged)-hook-(\d+)\.sh$/

export function hookEnvFileName(event: HookEvent, index: number): string {
  return `${event.toLowerCase()}-hook-${index}.sh`
}

export function sessionEnvDirFor(sessionId: string, base: string = DEFAULT_SESSION_ENV_BASE): string {
  return path.join(base, sessionId)
}

/** mkdir -p 并返回 session 目录路径（hook 写文件前调用，保证目录存在）。 */
export function ensureSessionEnvDir(sessionId: string, base: string = DEFAULT_SESSION_ENV_BASE): string {
  const dir = sessionEnvDirFor(sessionId, base)
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* 尽力 */ }
  return dir
}

// 单槽缓存（进程内通常仅一个活跃会话；/clear/resume 换 sid 自然 miss）。
let cache: { sid: string; base: string; script: string } | null = null

/** 读 session 目录下所有 hook env 文件，按优先级+index 排序拼成命令前缀（空则空串）。带单槽缓存。 */
export function getSessionEnvScript(sessionId: string | undefined, base: string = DEFAULT_SESSION_ENV_BASE): string {
  if (!sessionId) return ''
  if (cache && cache.sid === sessionId && cache.base === base) return cache.script
  const dir = sessionEnvDirFor(sessionId, base)
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { cache = { sid: sessionId, base, script: '' }; return '' }
  const matched: Array<{ name: string; pri: number; idx: number }> = []
  for (const name of names) {
    const m = HOOK_ENV_REGEX.exec(name)
    if (!m) continue
    matched.push({ name, pri: PRIORITY[m[1]], idx: Number(m[2]) })
  }
  matched.sort((a, b) => (a.pri - b.pri) || (a.idx - b.idx))
  const parts: string[] = []
  for (const { name } of matched) {
    let content = ''
    try { content = fs.readFileSync(path.join(dir, name), 'utf8').trim() } catch { /* 尽力 */ }
    if (content) parts.push(content)
  }
  const script = parts.join('\n')
  cache = { sid: sessionId, base, script }
  return script
}

/** 清空当前会话的 cwdchanged-*/filechanged-* 文件内容并失效缓存（cwd 变更时调）。 */
export function clearCwdEnvFiles(sessionId: string, base: string = DEFAULT_SESSION_ENV_BASE): void {
  const dir = sessionEnvDirFor(sessionId, base)
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return }
  for (const name of names) {
    if (/^(cwdchanged|filechanged)-hook-\d+\.sh$/.test(name)) {
      try { fs.writeFileSync(path.join(dir, name), '') } catch { /* 尽力 */ }
    }
  }
  invalidateSessionEnvCache(sessionId)
}

/** 失效缓存：不传 sid 清全部；传 sid 仅清匹配槽。 */
export function invalidateSessionEnvCache(sessionId?: string): void {
  if (sessionId === undefined || (cache && cache.sid === sessionId)) cache = null
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/sessionEnv.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
git add src/sessionEnv.ts test/sessionEnv.test.ts
git commit -m "feat(hooks): session-env file module — path/assemble/cwd-clear/cache (L-042 ①b-3)"
```

---

## Task 2: 引擎注入 `DEEPCODE_ENV_FILE`（hooks.ts 手术）

env-file 四事件的 **command** hook 执行时，env 注入 `DEEPCODE_ENV_FILE=<sessionEnvDir>/<event>-hook-<i>.sh`；目录预先 mkdir。路径从 `payload.session_id` 派生（零 deps 线穿透——`ctx.hookDispatch`/`settings.hooks` 调用点无需改签名）。`sessionEnvBase` 经 `HookEngineDeps` 可注入（测试指向 tmpdir）。

**Files:**
- Modify: `src/hooks.ts`（`HookEngineDeps`、`execCommandHook`、`execOneHook`、`runHooks`）
- Test: `test/hooks.test.ts`

- [ ] **Step 1: 写失败测试**

`test/hooks.test.ts` 末尾追加（沿用本文件既有 import 风格；若无下列 import 则补）：

```ts
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

describe('runHooks 注入 DEEPCODE_ENV_FILE', () => {
  it('SessionStart command hook 收到指向 sessionstart-hook-0.sh 的 DEEPCODE_ENV_FILE 且目录已建', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'deepcode-eng-senv-'))
    const config = {
      SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo export FOO=bar >> "$DEEPCODE_ENV_FILE"' }] }],
    } as any
    await runHooks('SessionStart',
      { hook_event_name: 'SessionStart', session_id: 'sess-eng', source: 'startup' },
      config, { sessionEnvBase: base })
    const f = path.join(base, 'sess-eng', 'sessionstart-hook-0.sh')
    expect(existsSync(f)).toBe(true)
    expect(readFileSync(f, 'utf8')).toContain('export FOO=bar')
  })

  it('非 env-file 事件（PreToolUse）不注入 DEEPCODE_ENV_FILE', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'deepcode-eng-senv2-'))
    const config = {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo "${DEEPCODE_ENV_FILE:-NONE}" >> /dev/stderr' }] }],
    } as any
    const out = await runHooks('PreToolUse',
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'sess-x' },
      config, { sessionEnvBase: base })
    // 未注入 → 不在 base 下创建任何 session 目录
    expect(existsSync(path.join(base, 'sess-x'))).toBe(false)
    expect(out.block).toBe(false)
  })

  it('env-file 事件但 payload 无 session_id → 不注入、不建目录', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'deepcode-eng-senv3-'))
    const config = {
      Setup: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo export X=1 >> "${DEEPCODE_ENV_FILE:-/dev/null}"' }] }],
    } as any
    await runHooks('Setup', { hook_event_name: 'Setup', trigger: 'init' }, config, { sessionEnvBase: base })
    expect(existsSync(base)).toBe(true) // base 本身是 mkdtemp 建的
    // 无 session 子目录被创建（readdir base 为空）
    expect(readdirSync(base)).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/hooks.test.ts -t DEEPCODE_ENV_FILE`
Expected: FAIL（引擎尚未注入）

- [ ] **Step 3: 实现 `src/hooks.ts`**

3a. 顶部 import 区追加：

```ts
import { ENV_FILE_EVENTS, ensureSessionEnvDir, hookEnvFileName, DEFAULT_SESSION_ENV_BASE } from './sessionEnv.js'
```

3b. `HookEngineDeps` 加字段：

```ts
export interface HookEngineDeps {
  spawn?: typeof nodeSpawn
  now?: () => number
  sessionEnvBase?: string
}
```

3c. `execCommandHook` 加可选 `envFilePath`，注入 env：

```ts
function execCommandHook(hook: CommandHook, payload: Record<string, unknown>, spawn: typeof nodeSpawn, envFilePath?: string): Promise<HookResult> {
  return new Promise(resolve => {
    const timeoutMs = (hook.timeout ?? 60) * 1000
    const opts: SpawnOptions = {
      env: {
        ...process.env,
        DEEPCODE_PROJECT_DIR: process.cwd(),
        DEEPCODE_CWD: String(payload.cwd ?? ''),
        ...(envFilePath ? { DEEPCODE_ENV_FILE: envFilePath } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
    // …（其余不变）
```

（仅改 `opts.env` 与函数签名；函数体其余原样保留。）

3d. `execOneHook` 透传 `envFilePath`：

```ts
async function execOneHook(hook: HookCommand, payload: Record<string, unknown>, deps: Required<HookEngineDeps>, envFilePath?: string): Promise<HookResult> {
  const start = deps.now()
  if (hook.type === 'command') {
    const r = await execCommandHook(hook, payload, deps.spawn, envFilePath)
    return { ...r, label: hook.command, durationMs: deps.now() - start }
  }
  return { outcome: 'non_blocking_error', label: `(${hook.type} 未支持)`, durationMs: deps.now() - start }
}
```

3e. `runHooks`：`full` 补 `sessionEnvBase` 默认；为 env-file 事件预建目录并按 index 算路径：

```ts
  const full: Required<HookEngineDeps> = {
    spawn: deps.spawn ?? nodeSpawn,
    now: deps.now ?? Date.now,
    sessionEnvBase: deps.sessionEnvBase ?? DEFAULT_SESSION_ENV_BASE,
  }

  // env-file 机制：Setup/SessionStart/CwdChanged/FileChanged 的 command hook 注入 DEEPCODE_ENV_FILE。
  const sid = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : undefined
  let envDir: string | undefined
  if (sid && ENV_FILE_EVENTS.has(event) && selected.some(h => h.type === 'command')) {
    envDir = ensureSessionEnvDir(sid, full.sessionEnvBase)
  }
  const results = await Promise.all(selected.map((h, i) =>
    execOneHook(h, payload, full, (envDir && h.type === 'command') ? path.join(envDir, hookEnvFileName(event, i)) : undefined),
  ))
  return mergeResults(results, event)
```

（注意：`path` 需在 hooks.ts import；若未 import 则顶部加 `import path from 'node:path'`。删除原 `const results = await Promise.all(selected.map(h => execOneHook(h, payload, full)))` 旧行。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/hooks.test.ts`
Expected: PASS（含新增 3 例 + 既有引擎用例全绿）

- [ ] **Step 5: Commit**

```bash
git add src/hooks.ts test/hooks.test.ts
git commit -m "feat(hooks): engine injects DEEPCODE_ENV_FILE for env-file events (L-042 ①b-3)"
```

---

## Task 3: bash.ts 前缀注入 + CwdChanged await/清理/失效

**Files:**
- Modify: `src/tools/bash.ts`
- Test: `test/tools.bash.test.ts`

- [ ] **Step 1: 写失败测试**

`test/tools.bash.test.ts` 追加（沿用本文件既有 ctx 构造法；下示为模板，按文件现有 helper 调整）：

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ensureSessionEnvDir, DEFAULT_SESSION_ENV_BASE, invalidateSessionEnvCache } from '../src/sessionEnv.js'

describe('bash 注入 session env 前缀', () => {
  beforeEach(() => invalidateSessionEnvCache())

  it('前台命令带上 hook 写入的 env 前缀（echo $FOO 能读到）', async () => {
    // 注：sessionEnv 默认 base 为 ~/.deepcode/session-env；本用例用真 sessionId 隔离 + 末尾清理。
    const sid = 'bashtest-' + Math.random().toString(36).slice(2)
    const dir = ensureSessionEnvDir(sid, DEFAULT_SESSION_ENV_BASE)
    writeFileSync(path.join(dir, 'sessionstart-hook-0.sh'), 'export FOO=bar123')
    invalidateSessionEnvCache(sid)
    const ctx: any = { cwd: () => process.cwd(), setCwd: () => {}, signal: undefined, sessionId: () => sid }
    const out = await bashTool.call({ command: 'echo "$FOO"' } as any, ctx)
    expect(out).toContain('bar123')
  })

  it('无 sessionId → 无前缀，命令照常执行', async () => {
    const ctx: any = { cwd: () => process.cwd(), setCwd: () => {}, signal: undefined, sessionId: () => undefined }
    const out = await bashTool.call({ command: 'echo hello' } as any, ctx)
    expect(out).toContain('hello')
  })

  it('CwdChanged：cd 后失效缓存 + 发事件带 session_id/new_cwd', async () => {
    const sid = 'bashcwd-' + Math.random().toString(36).slice(2)
    const events: any[] = []
    const tmp = mkdtempSync(path.join(tmpdir(), 'bash-cwd-'))
    let cur = process.cwd()
    const ctx: any = {
      cwd: () => cur, setCwd: (d: string) => { cur = d }, signal: undefined, sessionId: () => sid,
      hookDispatch: async (event: string, payload: any) => { events.push({ event, payload }); return { block: false, preventContinuation: false, stop: false, results: [] } },
    }
    await bashTool.call({ command: `cd ${tmp}` } as any, ctx)
    const cwdEvt = events.find(e => e.event === 'CwdChanged')
    expect(cwdEvt).toBeTruthy()
    expect(cwdEvt.payload.session_id).toBe(sid)
    expect(cwdEvt.payload.new_cwd).toContain(path.basename(tmp))
  })
})
```

> 真跑 `/bin/bash`（与既有 bash 测试一致）。第 1 例用默认 base + 随机 sessionId 隔离，避免污染；CI 上 `~/.deepcode/session-env` 可写。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/tools.bash.test.ts -t "session env"`
Expected: FAIL（前缀未注入）

- [ ] **Step 3: 实现 `src/tools/bash.ts`**

3a. import 区追加：

```ts
import { getSessionEnvScript, clearCwdEnvFiles, invalidateSessionEnvCache } from '../sessionEnv.js'
```

3b. `call(input, ctx)` 顶部（`if (input.run_in_background === true && !ctx.isSubagent)` 之前）算前缀：

```ts
    const envPrefix = getSessionEnvScript(ctx.sessionId?.())
    const prefixed = (cmd: string) => (envPrefix ? `${envPrefix}\n${cmd}` : cmd)
```

3c. 后台分支 spawn 命令套前缀（`bash.ts:39`）：

```ts
      const child = spawn('/bin/bash', ['-c', prefixed(input.command)], { cwd: ctx.cwd(), detached: true })
```

3d. 前台分支 wrapped 套前缀（`bash.ts:72`）：

```ts
      const wrapped = `${prefixed(input.command)}\n__dc_ec=$?\nprintf '\\n${MARKER}%s|%s' "$PWD" "$__dc_ec"`
```

3e. 前台 execFile 回调改 `async`，CwdChanged 分支改 await + 清 cwd env + 失效缓存（替换 `bash.ts:89-95` 现有 if/else 块）：

```ts
        async (err: any, stdout, stderr) => {
          // …（中段 out/exitCode/idx 解析不变）…
            if (newCwd && newCwd !== ctx.cwd()) {
              const oldCwd = ctx.cwd()
              ctx.setCwd(newCwd)
              const sid = ctx.sessionId?.()
              if (sid) clearCwdEnvFiles(sid) // 清旧 cwd 专属 env，hook 重写新值
              await ctx.hookDispatch?.('CwdChanged', {
                hook_event_name: 'CwdChanged', cwd: newCwd, session_id: sid, old_cwd: oldCwd, new_cwd: newCwd,
              })?.catch(() => undefined)
              if (sid) invalidateSessionEnvCache(sid) // 下条命令重读前缀
            } else if (newCwd) {
              ctx.setCwd(newCwd)
            }
          // …（其余 merged/resolve 不变）…
        },
```

> `?.` 短路：`ctx.hookDispatch` 为 nullish 时整链（含 `.catch`）短路为 `undefined`，`await undefined` 安全。回调改 async 后 `resolve(...)` 仍在末尾——execFile 忽略回调返回的 Promise，外层 `new Promise` 由 `resolve` 决议，await 不丢。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/tools.bash.test.ts`
Expected: PASS（含新增 3 例 + 既有 bash 用例全绿）

- [ ] **Step 5: Commit**

```bash
git add src/tools/bash.ts test/tools.bash.test.ts
git commit -m "feat(hooks): bash injects session-env prefix + CwdChanged await/clear/invalidate (L-042 ①b-3)"
```

---

## Task 4: Setup trigger 区分 init/maintenance（fold minor 1）

`saveApiKey` 当前恒发 `trigger:'init'`；改为依据保存前是否已存在持久化 key 区分。`hasApiKey()` 含 env 判断，但「已初始化」应只看落盘的 `s.apiKey`（env 注入不算 setup 完成）。

**Files:**
- Modify: `src/config.ts:84-91`
- Test: `test/config.test.ts`（**已存在且 hermetic**：顶层已 `vi.mock('node:os')` 把 homedir 重定向到 tmpdir、已 mock runHooks 到共享 `hookCalls`、已有 `describe('saveApiKey Setup hook')`。**禁止新建 mock 或动顶层**——只在既有 describe 内追加一例，不会污染用户真实 `~/.deepcode/settings.json`。）

- [ ] **Step 1: 写失败测试**

在 `test/config.test.ts` 既有 `describe('saveApiKey Setup hook', () => { … })`（约 line 109，已有 `beforeEach(() => { hookCalls.length = 0 })`）内追加一例。既有 init 用例（写前无落盘 key → init）已覆盖 init 分支，本例补 maintenance：

```ts
  it('已有落盘 key 再改 → Setup(trigger=maintenance)', async () => {
    saveSettings({ permissions: { allow: [] }, compactTokens: 200000, costWarnUSD: 2, apiKey: 'sk-old', hooks: { Setup: [{ hooks: [{ type: 'command', command: 'true' }] }] } } as any)
    hookCalls.length = 0
    saveApiKey('sk-changed')
    await new Promise(r => setTimeout(r, 0))
    const setup = hookCalls.find(c => c.event === 'Setup')
    expect(setup).toBeTruthy()
    expect(setup!.payload.trigger).toBe('maintenance')
  })
```

> 关键：先 `saveSettings({ …, apiKey: 'sk-old', … })` 落盘一个 key，再 `saveApiKey('sk-changed')`——`saveApiKey` 内部 `loadSettings()` 读到 `apiKey:'sk-old'` ⇒ `hadKey=true` ⇒ maintenance。既有 line 112 init 用例（saveSettings 不含 apiKey）随实现仍判 init，不受影响。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/config.test.ts -t maintenance`
Expected: FAIL（恒 init）

- [ ] **Step 3: 实现 `src/config.ts`**

```ts
export function saveApiKey(key: string): void {
  const s = loadSettings()
  const hadKey = !!s.apiKey // 保存前是否已有落盘 key → 区分 init/maintenance
  s.apiKey = key || undefined
  saveSettings(s)
  try { fs.chmodSync(FILE, 0o600) } catch { /* 尽力而为 */ }
  // Setup hook：首跑向导写 key=init；后续改 key=maintenance。fire-and-forget，hook 故障不阻断。
  if (s.hooks) void runHooks('Setup', { hook_event_name: 'Setup', cwd: process.cwd(), trigger: hadKey ? 'maintenance' : 'init' }, s.hooks).catch(() => {})
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/config.test.ts -t maintenance`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(hooks): Setup trigger init vs maintenance on key change (L-042 ①b-3)"
```

---

## Task 5: headless SessionStart/InstructionsLoaded dispatch 补测（fold minor 2）

opus 终审标注 headless 的 SessionStart/InstructionsLoaded dispatch 路径无测试覆盖。补一条断言其被派发。

**Files:**
- Modify: `test/headless.test.ts`

- [ ] **Step 1: 写失败前先确认 baseline**

本任务仅加测试（实现已存在于 `headless.ts:54-71`）。目的：锁定回归护栏。在 `test/headless.test.ts` 顶部既有 `vi.mock('../src/api.js', …)` 之后追加对 hooks/config 的部分 mock：

```ts
const hookCalls: Array<{ event: string; payload: any }> = []
vi.mock('../src/hooks.js', async (orig) => {
  const actual = await orig<typeof import('../src/hooks.js')>()
  return { ...actual, runHooks: vi.fn(async (event: any, payload: any) => { hookCalls.push({ event, payload }); return { block: false, preventContinuation: false, stop: false, results: [] } }) }
})
vi.mock('../src/config.js', async (orig) => {
  const actual = await orig<typeof import('../src/config.js')>()
  return { ...actual, loadSettings: vi.fn(() => ({ ...actual.loadSettings(), hooks: { SessionStart: [{ matcher: '*', hooks: [] }], InstructionsLoaded: [{ matcher: '*', hooks: [] }] } })) }
})
```

- [ ] **Step 2: 写测试**

在 `describe('runHeadless', …)` 内追加：

```ts
  it('启动派发 SessionStart(startup) 与 InstructionsLoaded', async () => {
    hookCalls.length = 0
    script.push({ result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })
    await runHeadless({ client: {} as any, prompt: '你好', yolo: true })
    const ss = hookCalls.find(c => c.event === 'SessionStart')
    expect(ss?.payload.source).toBe('startup')
    expect(ss?.payload.session_id).toMatch(/^headless-/)
    // 当前 cwd（deepcode 仓库根）含 DEEPCODE.md/CLAUDE.md → 至少一条 InstructionsLoaded
    expect(hookCalls.some(c => c.event === 'InstructionsLoaded' && c.payload.load_reason === 'startup')).toBe(true)
  })
```

> 若运行目录恰无任何记忆文件致 InstructionsLoaded 不触发，则在测试内先 `writeFileSync(path.join(process.cwd(), 'DEEPCODE.md'), '# t')`（用 tmp cwd 或测后清理）；实现者按 `findMemoryFiles` 实际查找根目录调整，确保断言稳定。

- [ ] **Step 3: 跑测试确认通过**

Run: `npx vitest run test/headless.test.ts`
Expected: PASS（既有用例不受 mock 影响——mock 仅替换 runHooks/loadSettings，api 行为不变）

> 风险点：mock `loadSettings` 全局替换可能影响同文件既有用例（permissions/loop 读 settings）。实现者须跑全 `test/headless.test.ts` 确认既有 3+ 用例仍绿；若 mock 干扰，改为「仅在该用例内 `vi.spyOn`/局部覆盖」而非顶层 `vi.mock`。

- [ ] **Step 4: Commit**

```bash
git add test/headless.test.ts
git commit -m "test(hooks): cover headless SessionStart/InstructionsLoaded dispatch (L-042 ①b-3)"
```

---

## 完成后

- 全量 `npm test && npm run typecheck && npm run build` 全绿（纯逻辑 + 真跑 /bin/bash 的集成测试，**免真机 TUI 冒烟**——本件不碰 ink）。
- 走 `superpowers:subagent-driven-development` 每任务 implementer + 规格审 + 质量审双门；**末尾 opus 全量终审**（Task 2/3 是真·引擎手术 + bash 执行路径改动，终审重点核：① env 注入仅限 command 且仅 env-file 事件、② 前缀注入不破坏前台 marker/退出码解析与后台管道、③ CwdChanged 回调改 async 后 resolve 时序无丢、④ 三 dispatch 通道无需改签名的零穿透成立、⑤ 缓存失效时机正确无跨会话泄漏）。
- 终审过后 `finishing-a-development-branch` 合 main（no-ff）、push origin。
- 更新 memory：①b-3 完成、下一步 ①c（prompt/agent/http 三类型）。

## 后续（不在本件）
**①c** prompt/agent/http 三类型（扩 `HookEngineDeps` 的 llm/runAgent/fetch）→ **①d** async/asyncRewake（挂 tasks.ts；同时 fold ①b-1 终审 minor：PermissionDenied payload 缺 tool_input、headless block 丢 additionalContext）→ **①e** TUI 进度（碰 TUI 需用户真机冒烟）。
