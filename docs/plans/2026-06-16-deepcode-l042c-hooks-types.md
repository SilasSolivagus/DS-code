# L-042 ①c Hooks prompt/agent/http 三类型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 hooks 引擎支持 `prompt`（LLM 判定）、`agent`（核查子代理）、`http`（webhook）三种 hook 类型，并把 `llm`/`runAgent` 运行时从真实 client 注入到主会话/headless/loop 的 dispatch 通道（`fetch` 默认全局）。

**Architecture:** 引擎 `src/hooks.ts` 加三个执行器 + 共享解析器（`substituteArguments`、`parseHookEvalResult`、从 `parseHookStdout` 抽出的 `applyHookJson`），全部经 `HookEngineDeps` 注入（DI 便于测）。新模块 `src/hookRuntime.ts` 用 deepcode 的 `chatStream`/`runLoop` 构造 `llm`/`runAgent`，在 `useChat`/`headless` 启动处构造一次 `hookDeps` 并线穿到所有 `runHooks`/`ctx.hookDispatch`/`runLoop` 调用点（`loop.ts` 经新增 `LoopDeps.hookDeps`）。

**Tech Stack:** TypeScript/ESM、vitest、deepcode `chatStream`(DeepSeek)/`runLoop`(子代理)/全局 `fetch`。

**CC 对齐基线（实读 `~/Desktop/src/schemas/hooks.ts` + `utils/hooks/exec{Prompt,Agent,Http}Hook.ts`，本会话确认）：**
- 三类型字符串就是 `prompt`/`agent`/`http`。
- `$ARGUMENTS` 替换为完整 payload JSON；无占位符则追加 `\n\nARGUMENTS: {json}`。
- prompt/agent 结果都是结构化 `{ok: boolean, reason?: string}`（ok:true→放行；ok:false→block + reason）；解析失败→non_blocking_error；超时→cancelled。默认小快模型（CC Haiku → **deepcode flash `deepseek-v4-flash`**）。
- agent 是多轮带工具子代理 + 结构化输出。**deepcode 偏离（记录）**：deepcode 的结构化输出是尚未做的 L-044，故 agent hook 用「系统提示要求末条消息输出 JSON `{ok,reason}` + 解析末条 assistant 文本」近似（复用现有 `runLoop` + 只读工具，hooks-free 子上下文防递归），等 L-044 落地可换成 SyntheticOutputTool。
- http：POST `application/json`，body=payload JSON；header 值 env 变量插值 `$VAR`/`${VAR}`（**白名单 `allowedEnvVars`，不在白名单→空串**）+ 消毒去 `\r\n\x00`（防 CRLF 注入）；响应体须 JSON，按 command stdout JSON 同样解析；非 2xx→block。
- 默认超时：prompt 30s、agent 60s、http **30s**（CC http 默认 10min 对终端 agent 不合理，deepcode 用 30s，记录偏离）。

---

## File Structure

- **Modify** `src/hooks.ts` — `HookEngineDeps` 加 `llm?`/`runAgent?`/`fetch?`；内部 `ResolvedHookDeps`（fetch 默认全局，llm/runAgent 可缺）；新增 `substituteArguments`/`parseHookEvalResult`/`applyHookJson`（从 `parseHookStdout` 抽出）+ `execPromptHook`/`execAgentHook`/`execHttpHook`；`execOneHook` switch 扩四类型。
- **Modify** `test/hooks.test.ts` — 三执行器 + 解析器单测（注入 fake llm/runAgent/fetch）。
- **Create** `src/hookRuntime.ts` — `makeHookRuntime({client,getModel,onUsage,cwd})` → `{llm, runAgent}`。
- **Create** `test/hookRuntime.test.ts` — llm/runAgent 行为单测（fake client 流 / 短 runLoop）。
- **Modify** `src/loop.ts` — `LoopDeps.hookDeps?: HookEngineDeps`；所有 `runHooks(...)` 加第 4 参 `deps.hookDeps`。
- **Modify** `src/tui/useChat.ts` — 构造 `hookDeps`；`ctx.hookDispatch` + 所有直接 `runHooks` + `LoopDeps` 传 `hookDeps`。
- **Modify** `src/headless.ts` — 同 useChat。
- **Modify** `test/loop.test.ts`（或 hooks.test）— 集成：prompt hook 经 loop dispatch 触达 llm。

---

## Task 1: 引擎 prompt 执行器 + 共享解析器 + `$ARGUMENTS` 替换 + `llm` dep

**Files:** Modify `src/hooks.ts`、`test/hooks.test.ts`.

- [ ] **Step 1: 写失败测试** — 追加到 `test/hooks.test.ts`（合并已有 import）：

```ts
describe('substituteArguments', () => {
  it('$ARGUMENTS → payload JSON；多处都替换', () => {
    const out = substituteArguments('判断 $ARGUMENTS 是否安全；再看 $ARGUMENTS', { a: 1 })
    expect(out).toBe('判断 {"a":1} 是否安全；再看 {"a":1}')
  })
  it('无占位符 → 追加 ARGUMENTS 段', () => {
    expect(substituteArguments('请评估', { a: 1 })).toBe('请评估\n\nARGUMENTS: {"a":1}')
  })
})

describe('parseHookEvalResult', () => {
  const base = { outcome: 'success', label: '', durationMs: 0 } as any
  it('{ok:true} → success', () => {
    expect(parseHookEvalResult('{"ok":true}', base).outcome).toBe('success')
  })
  it('{ok:false,reason} → blocking + preventContinuation + reason', () => {
    const r = parseHookEvalResult('{"ok":false,"reason":"危险"}', base)
    expect(r.outcome).toBe('blocking'); expect(r.preventContinuation).toBe(true); expect(r.blockingError).toBe('危险')
  })
  it('非 JSON / 缺 ok → non_blocking_error', () => {
    expect(parseHookEvalResult('not json', base).outcome).toBe('non_blocking_error')
    expect(parseHookEvalResult('{"x":1}', base).outcome).toBe('non_blocking_error')
  })
})

describe('runHooks prompt 类型', () => {
  it('prompt hook 调 llm，{ok:false} → block；llm 收到含 $ARGUMENTS 替换的 prompt', async () => {
    const seen: string[] = []
    const llm = async (p: string) => { seen.push(p); return '{"ok":false,"reason":"判定不通过"}' }
    const config = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'prompt', prompt: '评估 $ARGUMENTS' }] }] } as any
    const out = await runHooks('PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }, config, { llm })
    expect(out.block).toBe(true)
    expect(seen[0]).toContain('rm -rf /') // payload 已并入 prompt
  })
  it('未配置 llm → prompt hook 记 non_blocking_error，不 block', async () => {
    const config = { Stop: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }] } as any
    const out = await runHooks('Stop', { hook_event_name: 'Stop' }, config, {})
    expect(out.block).toBe(false)
    expect(out.results[0].outcome).toBe('non_blocking_error')
  })
})
```

- [ ] **Step 2: 跑确认失败** — `npx vitest run test/hooks.test.ts -t "prompt 类型"` → FAIL.

- [ ] **Step 3: 实现 `src/hooks.ts`**

3a. `HookEngineDeps` 加三字段：
```ts
export interface HookEngineDeps {
  spawn?: typeof nodeSpawn
  now?: () => number
  sessionEnvBase?: string
  /** prompt hook：单轮 LLM 判定。返回模型文本（引擎解析 {ok,reason}）。 */
  llm?: (prompt: string, model: string | undefined, signal: AbortSignal) => Promise<string>
  /** agent hook：多轮核查子代理。返回末条 assistant 文本（引擎解析 {ok,reason}）。 */
  runAgent?: (prompt: string, model: string | undefined, signal: AbortSignal) => Promise<string>
  /** http hook：默认全局 fetch。 */
  fetch?: typeof fetch
}
```

3b. 内部解析的 `full` 不再用 `Required<HookEngineDeps>`（llm/runAgent 可缺）。在 import 区下方加内部类型：
```ts
interface ResolvedHookDeps {
  spawn: typeof nodeSpawn
  now: () => number
  sessionEnvBase: string
  fetch: typeof fetch
  llm?: HookEngineDeps['llm']
  runAgent?: HookEngineDeps['runAgent']
}
```
并把 `execOneHook` 的 `deps: Required<HookEngineDeps>` 改为 `deps: ResolvedHookDeps`（注意 `execCommandHook` 签名是 `(hook, payload, spawn, envFilePath?)`——它**不收 deps**，无需改）。

3c. 把 `parseHookStdout` 里 JSON 对象映射段抽成共享函数（紧邻 `parseHookStdout` 放）：
```ts
/** 把 hook 输出的 JSON 对象映射到 HookResult 字段（command stdout / http 响应共用）。 */
export function applyHookJson(json: any, base: HookResult): HookResult {
  const r: HookResult = { ...base }
  if (json.continue === false) r.stop = true
  if (json.decision === 'block') { r.outcome = 'blocking'; r.blockingError = typeof json.reason === 'string' ? json.reason : undefined; r.preventContinuation = true }
  if (json.decision === 'approve') r.permissionDecision = 'allow'
  if (typeof json.systemMessage === 'string') r.systemMessage = json.systemMessage
  const hso = json.hookSpecificOutput
  if (hso && typeof hso === 'object') {
    if (hso.permissionDecision === 'allow' || hso.permissionDecision === 'deny' || hso.permissionDecision === 'ask') r.permissionDecision = hso.permissionDecision
    const pr = hso.permissionReason ?? hso.permissionDecisionReason
    if (typeof pr === 'string') r.permissionReason = pr
    if ('updatedInput' in hso) r.updatedInput = hso.updatedInput
    if (typeof hso.updatedOutput === 'string') r.updatedOutput = hso.updatedOutput
    if (typeof hso.additionalContext === 'string') r.additionalContext = hso.additionalContext
  }
  return r
}
```
然后把 `parseHookStdout` 中从 `const r: HookResult = { ...base }` 到 `return r` 的整段替换为 `return applyHookJson(json, base)`（行为字节等价）。

3d. 新增替换 + 评估解析 + prompt 执行器（放在 `execCommandHook` 之后）：
```ts
/** $ARGUMENTS → payload JSON；无占位符则追加 ARGUMENTS 段（对齐 CC argumentSubstitution）。 */
export function substituteArguments(template: string, payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload)
  if (template.includes('$ARGUMENTS')) return template.split('$ARGUMENTS').join(json)
  return `${template}\n\nARGUMENTS: ${json}`
}

/** prompt/agent hook 的 {ok,reason} 结果解析。ok:true→success；ok:false→blocking(reason)；否则 non_blocking_error。 */
export function parseHookEvalResult(text: string, base: HookResult): HookResult {
  let json: any
  try { json = JSON.parse(text.trim()) } catch { return { ...base, outcome: 'non_blocking_error', blockingError: 'hook 输出无法解析为 JSON {ok,reason}' } }
  if (!json || typeof json.ok !== 'boolean') return { ...base, outcome: 'non_blocking_error', blockingError: 'hook 输出缺少 boolean ok 字段' }
  if (json.ok) return { ...base }
  return { ...base, outcome: 'blocking', blockingError: typeof json.reason === 'string' ? json.reason : 'hook 判定不通过', preventContinuation: true }
}

const HOOK_EVAL_SYSTEM = `你正在评估 deepcode 的一个 hook。\n你的回复必须是且仅是一个 JSON 对象，匹配下列之一：\n1. 条件满足：{"ok": true}\n2. 条件不满足：{"ok": false, "reason": "未满足的原因"}\n不要输出任何其他文字。`

const evalBase = (): HookResult => ({ outcome: 'success', label: '', durationMs: 0 })

/** 单轮 LLM 判定。无 llm → non_blocking_error。超时→cancelled。 */
async function execPromptHook(hook: PromptHook, payload: Record<string, unknown>, deps: ResolvedHookDeps): Promise<HookResult> {
  if (!deps.llm) return { ...evalBase(), outcome: 'non_blocking_error', blockingError: '未配置 llm（prompt hook 不可用）' }
  const prompt = `${HOOK_EVAL_SYSTEM}\n\n${substituteArguments(hook.prompt, payload)}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), (hook.timeout ?? 30) * 1000)
  try {
    const text = await deps.llm(prompt, hook.model, ac.signal)
    return parseHookEvalResult(text, evalBase())
  } catch (e) {
    if (ac.signal.aborted) return { ...evalBase(), outcome: 'cancelled' }
    return { ...evalBase(), outcome: 'non_blocking_error', blockingError: String((e as any)?.message ?? e) }
  } finally { clearTimeout(timer) }
}
```

3e. `execOneHook` switch 加 prompt 分派（在 command 分支后、占位 return 前）：
```ts
  if (hook.type === 'prompt') {
    const r = await execPromptHook(hook, payload, deps)
    return { ...r, label: truncLabel(hook.prompt), durationMs: deps.now() - start }
  }
```
并在文件内加助手（放 execOneHook 上方）：
```ts
const truncLabel = (s: string): string => (s.length > 60 ? s.slice(0, 60) + '…' : s)
```

3f. `runHooks` 的 `full` 构造改为 `ResolvedHookDeps`：
```ts
  const full: ResolvedHookDeps = {
    spawn: deps.spawn ?? nodeSpawn,
    now: deps.now ?? Date.now,
    sessionEnvBase: deps.sessionEnvBase ?? DEFAULT_SESSION_ENV_BASE,
    fetch: deps.fetch ?? (globalThis.fetch as typeof fetch),
    llm: deps.llm,
    runAgent: deps.runAgent,
  }
```
（删旧 `Required<HookEngineDeps>` 版本。env-file 那段 `selected.some(h => h.type === 'command')` 等保持不变。）

- [ ] **Step 4: 跑确认通过** — `npx vitest run test/hooks.test.ts` → 全 PASS（新增 + 既有引擎/env-file 用例）。

- [ ] **Step 5: Commit**
```bash
git add src/hooks.ts test/hooks.test.ts
git commit -m "feat(hooks): prompt 类型执行器 + 共享 {ok,reason}/JSON 解析器 + llm dep (L-042 ①c)"
```

---

## Task 2: 引擎 agent 执行器 + `runAgent` dep

**Files:** Modify `src/hooks.ts`、`test/hooks.test.ts`.

- [ ] **Step 1: 写失败测试** — 追加到 `test/hooks.test.ts`：
```ts
describe('runHooks agent 类型', () => {
  it('agent hook 调 runAgent；{ok:false} → block；prompt 含 payload', async () => {
    const seen: string[] = []
    const runAgent = async (p: string) => { seen.push(p); return '好的\n{"ok":false,"reason":"子代理判定不完整"}'.split('\n').pop()! }
    const config = { SubagentStop: [{ hooks: [{ type: 'agent', prompt: '核查 $ARGUMENTS' }] }] } as any
    const out = await runHooks('SubagentStop', { hook_event_name: 'SubagentStop', last_assistant_message: 'done' }, config, { runAgent })
    expect(out.block).toBe(true)
    expect(seen[0]).toContain('done')
  })
  it('未配置 runAgent → non_blocking_error，不 block', async () => {
    const config = { SubagentStop: [{ hooks: [{ type: 'agent', prompt: 'x' }] }] } as any
    const out = await runHooks('SubagentStop', { hook_event_name: 'SubagentStop' }, config, {})
    expect(out.block).toBe(false)
    expect(out.results[0].outcome).toBe('non_blocking_error')
  })
})
```

- [ ] **Step 2: 跑确认失败** — `npx vitest run test/hooks.test.ts -t "agent 类型"` → FAIL.

- [ ] **Step 3: 实现** — 在 `execPromptHook` 之后加：
```ts
const AGENT_HOOK_SYSTEM = `你正在作为 deepcode 的 agent hook 运行一个核查子代理。完成核查后，你的最后一条消息必须是且仅是一个 JSON 对象：\n- 通过：{"ok": true}\n- 不通过：{"ok": false, "reason": "原因"}\n不要输出任何其他文字。`

/** 多轮核查子代理（复用注入的 runAgent，返回末条文本）。无 runAgent → non_blocking_error。 */
async function execAgentHook(hook: AgentHook, payload: Record<string, unknown>, deps: ResolvedHookDeps): Promise<HookResult> {
  if (!deps.runAgent) return { ...evalBase(), outcome: 'non_blocking_error', blockingError: '未配置 runAgent（agent hook 不可用）' }
  const prompt = `${AGENT_HOOK_SYSTEM}\n\n${substituteArguments(hook.prompt, payload)}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), (hook.timeout ?? 60) * 1000)
  try {
    const text = await deps.runAgent(prompt, hook.model, ac.signal)
    return parseHookEvalResult(text ?? '', evalBase())
  } catch (e) {
    if (ac.signal.aborted) return { ...evalBase(), outcome: 'cancelled' }
    return { ...evalBase(), outcome: 'non_blocking_error', blockingError: String((e as any)?.message ?? e) }
  } finally { clearTimeout(timer) }
}
```
`execOneHook` switch 加（prompt 分支后）：
```ts
  if (hook.type === 'agent') {
    const r = await execAgentHook(hook, payload, deps)
    return { ...r, label: truncLabel(hook.prompt), durationMs: deps.now() - start }
  }
```

- [ ] **Step 4: 跑确认通过** — `npx vitest run test/hooks.test.ts` → 全 PASS.

- [ ] **Step 5: Commit**
```bash
git add src/hooks.ts test/hooks.test.ts
git commit -m "feat(hooks): agent 类型执行器 + runAgent dep（{ok,reason} 文本解析近似，待 L-044）(L-042 ①c)"
```

---

## Task 3: 引擎 http 执行器 + `fetch` dep + env 插值/消毒

**Files:** Modify `src/hooks.ts`、`test/hooks.test.ts`.

- [ ] **Step 1: 写失败测试** — 追加到 `test/hooks.test.ts`：
```ts
describe('interpolateEnvVars', () => {
  it('白名单内插值，白名单外→空串；消毒 CRLF/NUL', () => {
    process.env.DC_HOOK_TOK = 'secret'
    process.env.DC_HOOK_EVIL = 'a\r\nX-Evil: 1'
    const allowed = new Set(['DC_HOOK_TOK', 'DC_HOOK_EVIL'])
    expect(interpolateEnvVars('Bearer $DC_HOOK_TOK', allowed)).toBe('Bearer secret')
    expect(interpolateEnvVars('Bearer ${DC_HOOK_TOK}', allowed)).toBe('Bearer secret')
    expect(interpolateEnvVars('$DC_NOT_ALLOWED', new Set())).toBe('')
    expect(interpolateEnvVars('$DC_HOOK_EVIL', allowed)).toBe('aX-Evil: 1') // \r\n 已剥
    delete process.env.DC_HOOK_TOK; delete process.env.DC_HOOK_EVIL
  })
})

describe('runHooks http 类型', () => {
  it('POST payload JSON + 插值 header；2xx + decision:block → block', async () => {
    let captured: any
    const fakeFetch = (async (url: string, init: any) => { captured = { url, init }; return { status: 200, text: async () => '{"decision":"block","reason":"webhook 拒绝"}' } }) as any
    const config = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'http', url: 'https://hook.test/x', headers: { 'X-Tok': '$DC_T' } }] }] } as any
    process.env.DC_T = 'tok1'
    const out = await runHooks('PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, config, { fetch: fakeFetch })
    expect(out.block).toBe(true)
    expect(captured.url).toBe('https://hook.test/x')
    expect(captured.init.method).toBe('POST')
    expect(JSON.parse(captured.init.body).tool_name).toBe('Bash')
    // header 默认 allowedEnvVars 为空 → $DC_T 不在白名单 → 空串
    expect(captured.init.headers['X-Tok']).toBe('')
    delete process.env.DC_T
  })
  it('非 2xx → blocking', async () => {
    const fakeFetch = (async () => ({ status: 500, text: async () => '' })) as any
    const config = { Stop: [{ hooks: [{ type: 'http', url: 'https://hook.test/y' }] }] } as any
    const out = await runHooks('Stop', { hook_event_name: 'Stop' }, config, { fetch: fakeFetch })
    expect(out.results[0].outcome).toBe('blocking')
  })
})
```
> 注意 allowedEnvVars 白名单语义：header 里引用的 env 变量必须出现在该 hook 的 `allowedEnvVars` 才插值，否则空串（对齐 CC 防 secret 外泄）。上面第一个用例未配 allowedEnvVars 故 `X-Tok` 为空，是预期。

- [ ] **Step 2: 跑确认失败** — `npx vitest run test/hooks.test.ts -t "http 类型"` → FAIL.

- [ ] **Step 3: 实现** — 在 `execAgentHook` 之后加：
```ts
/** header 值 env 插值（仅白名单内变量），随后消毒去 \r\n\x00（防 CRLF 注入）。对齐 CC。 */
export function interpolateEnvVars(value: string, allowed: Set<string>): string {
  const replaced = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced, plain) => {
    const name = braced ?? plain
    return allowed.has(name) ? (process.env[name] ?? '') : ''
  })
  // eslint-disable-next-line no-control-regex
  return replaced.replace(/[\r\n\x00]/g, '')
}

/** webhook：POST payload JSON，响应体按 hook JSON 解析；非 2xx→blocking。无 fetch（已默认全局）不会发生。 */
async function execHttpHook(hook: HttpHook, payload: Record<string, unknown>, deps: ResolvedHookDeps): Promise<HookResult> {
  const allowed = new Set(hook.allowedEnvVars ?? [])
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  for (const [k, v] of Object.entries(hook.headers ?? {})) headers[k] = interpolateEnvVars(v, allowed)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), (hook.timeout ?? 30) * 1000)
  const base: HookResult = { outcome: 'success', label: '', durationMs: 0 }
  try {
    const res = await deps.fetch(hook.url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ac.signal })
    const bodyText = await res.text()
    let json: any
    if (bodyText.trim()) { try { json = JSON.parse(bodyText.trim()) } catch { /* 非 JSON 体 */ } }
    let r = (json && typeof json === 'object' && !Array.isArray(json)) ? applyHookJson(json, base) : { ...base }
    if (res.status < 200 || res.status >= 300) {
      r = { ...r, outcome: 'blocking', preventContinuation: true, blockingError: r.blockingError ?? `HTTP ${res.status}` }
    }
    return r
  } catch (e) {
    if (ac.signal.aborted) return { ...base, outcome: 'cancelled' }
    return { ...base, outcome: 'non_blocking_error', blockingError: String((e as any)?.message ?? e) }
  } finally { clearTimeout(timer) }
}
```
`execOneHook` switch 加（agent 分支后）：
```ts
  if (hook.type === 'http') {
    const r = await execHttpHook(hook, payload, deps)
    return { ...r, label: hook.url, durationMs: deps.now() - start }
  }
```
（占位 return 改为 `return { outcome: 'non_blocking_error', label: \`(${(hook as any).type} 未支持)\`, durationMs: deps.now() - start }`，仅未知 type 兜底。）

- [ ] **Step 4: 跑确认通过 + 全量** — `npx vitest run test/hooks.test.ts && npm test && npm run typecheck && npm run build` → 全 PASS/clean.

- [ ] **Step 5: Commit**
```bash
git add src/hooks.ts test/hooks.test.ts
git commit -m "feat(hooks): http 类型执行器 + fetch dep + env 插值白名单/消毒 (L-042 ①c)"
```

---

## Task 4: `src/hookRuntime.ts` + 把 llm/runAgent 线穿到 useChat/headless/loop

**Files:** Create `src/hookRuntime.ts`、`test/hookRuntime.test.ts`；Modify `src/loop.ts`、`src/tui/useChat.ts`、`src/headless.ts`；Test `test/loop.test.ts`.

- [ ] **Step 1: 写 hookRuntime 失败测试** — `test/hookRuntime.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest'

// 用与 headless.test.ts 同款的 api mock：chatStream 返回脚本化结果
const script: Array<{ deltas?: any[]; result: any }> = []
vi.mock('../src/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/api.js')>()
  return { ...actual, chatStream: vi.fn(() => (async function* () {
    const scene = script.shift(); if (!scene) throw new Error('script exhausted')
    for (const d of scene.deltas ?? []) yield typeof d === 'string' ? { type: 'text', delta: d } : d
    return scene.result
  })()) }
})

import { makeHookRuntime } from '../src/hookRuntime.js'

const usage = { prompt_tokens: 1, completion_tokens: 1, prompt_cache_hit_tokens: 0 }

describe('makeHookRuntime.llm', () => {
  it('单轮：把 prompt 作 user 消息发 chatStream，返回 content', async () => {
    script.length = 0
    script.push({ result: { content: '{"ok":true}', toolCalls: [], usage, finishReason: 'stop' } })
    const rt = makeHookRuntime({ client: {} as any, getModel: () => 'deepseek-v4-flash', cwd: () => process.cwd() })
    const text = await rt.llm!('评估这个', undefined, new AbortController().signal)
    expect(text).toBe('{"ok":true}')
  })
})
```
> runAgent 走完整 `runLoop`（真子代理回路），单测成本高且依赖工具——本任务 runAgent 不强求独立单测，靠 Task 2 的引擎测（注入 fake runAgent）+ Task 4 的集成测覆盖语义。hookRuntime 测只锁 llm 的 chatStream 装配。

- [ ] **Step 2: 跑确认失败** — `npx vitest run test/hookRuntime.test.ts` → FAIL（模块不存在）.

- [ ] **Step 3: 实现 `src/hookRuntime.ts`**
```ts
// src/hookRuntime.ts —— 用 deepcode 运行时构造 hooks 的 llm/runAgent（http 用全局 fetch，不在此）
import type OpenAI from 'openai'
import { chatStream, type Usage } from './api.js'
import { runLoop } from './loop.js'
import { allTools } from './tools/index.js'
import { SUB_MODEL } from './tools/constants.js'
import { subagentPermissionDecision } from './tools/agent.js'
import type { HookEngineDeps } from './hooks.js'
import type { ToolContext } from './tools/types.js'

// hook 子代理只用只读工具（防写，且无需审批 UI）。
const HOOK_AGENT_TOOLS = allTools.filter(t => t.isReadOnly)

/** 把 hook.model（'flash'/'inherit'/具体 id/undefined）解析成真实模型 id。 */
function resolveModel(model: string | undefined, getModel: () => string): string {
  if (!model || model === 'flash') return SUB_MODEL
  if (model === 'inherit') return getModel()
  return model
}

export function makeHookRuntime(opts: {
  client: OpenAI
  getModel: () => string
  onUsage?: (u: Usage, model: string) => void
  cwd: () => string
}): Pick<HookEngineDeps, 'llm' | 'runAgent'> {
  const llm: HookEngineDeps['llm'] = async (prompt, model, signal) => {
    const gen = chatStream(opts.client, {
      model: resolveModel(model, opts.getModel),
      messages: [{ role: 'user', content: prompt }],
      tools: [], thinking: false, signal,
    })
    let step = await gen.next()
    while (!step.done) step = await gen.next()
    return step.value.content
  }

  const runAgent: HookEngineDeps['runAgent'] = async (prompt, model, signal) => {
    const subModel = resolveModel(model, opts.getModel)
    const subCtx: ToolContext = {
      cwd: opts.cwd,
      setCwd: () => { /* hook 子代理只读，不漂移 cwd */ },
      get signal() { return signal },
      fileState: new Map(),
      isSubagent: true, // 纯执行：禁后台任务；且不注入 hookDispatch → 子回路 hooks-free 防递归
    }
    const messages: any[] = [{ role: 'user', content: prompt }]
    const gen = runLoop(messages, {
      client: opts.client,
      tools: HOOK_AGENT_TOOLS,
      model: subModel,
      thinking: false,
      permission: { mode: 'default', rules: [], saveRule: () => {}, ask: async (_n, desc) => subagentPermissionDecision(desc) },
      ctx: subCtx,
      maxTurns: 10,
    })
    let step
    while (!(step = await gen.next()).done) {
      if (step.value.type === 'turn_end' && opts.onUsage) opts.onUsage(step.value.usage, subModel)
    }
    const final = [...messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content)
    return final?.content ?? ''
  }

  return { llm, runAgent }
}
```
> 若 `import type OpenAI from 'openai'` 形态与项目其它文件不一致，照搬 `src/tools/agent.ts` 的 OpenAI import 写法。

- [ ] **Step 4: 跑 hookRuntime 测试通过** — `npx vitest run test/hookRuntime.test.ts` → PASS.

- [ ] **Step 5: 线穿 `src/loop.ts`**
5a. `LoopDeps` 加字段（紧随 `hooks?`）：
```ts
  /** prompt/agent/http hook 运行时（llm/runAgent/fetch）。仅主会话传入；与 hooks 配对。 */
  hookDeps?: import('./hooks.js').HookEngineDeps
```
5b. 把 loop.ts 内**所有** `runHooks(EV, {...}, deps.hooks)` 调用统一加第 4 参 `deps.hookDeps`。调用点（按现状）：`PreToolUse`、`PermissionRequest`、`PermissionDenied`（在 `permHooks` 闭包里两处）、`PostToolUse`、`PostToolUseFailure`、`StopFailure`、`Stop`。例如：
```ts
const pre = await runHooks('PreToolUse', { ... }, deps.hooks, deps.hookDeps)
```
permHooks 闭包：
```ts
const permHooks = deps.hooks ? {
  onRequest: (d: string) => runHooks('PermissionRequest', { ... }, deps.hooks, deps.hookDeps),
  onDenied: (d: string, reason: string) => runHooks('PermissionDenied', { ... }, deps.hooks, deps.hookDeps),
} : undefined
```
> 完成后 `grep -n "runHooks(" src/loop.ts` 确认每处都带第 4 参 `deps.hookDeps`。

- [ ] **Step 6: 线穿 `src/tui/useChat.ts`**
6a. import：`import { makeHookRuntime } from '../hookRuntime.js'`.
6b. 在 `ctx` 构造前（`model`/`opts.client` 已可用；约 line 200 附近）建一次：
```ts
  const hookDeps = makeHookRuntime({
    client: opts.client,
    getModel: () => model,
    onUsage: (u, m) => { usageLog.push({ usage: u, model: m }); session.appendUsage(u, m) },
    cwd: () => cwd,
  })
```
> `usageLog`/`session` 若此时尚未定义，放到它们定义之后、首个 dispatch 之前即可；确保 `hookDeps` 在 `ctx.hookDispatch` 与所有 `runHooks` 之前已声明（避免 TDZ）。
6c. `ctx.hookDispatch` 改：`hookDispatch: (event, payload) => runHooks(event, payload, settings.hooks, hookDeps)`.
6d. useChat 内**所有**直接 `runHooks(EV, {...}, settings.hooks)` 加第 4 参 `hookDeps`（SessionStart/SessionEnd/ConfigChange/InstructionsLoaded/PreCompact/PostCompact/Notification/UserPromptSubmit）。
6e. 构造 `LoopDeps` 的对象（约 line 468-486，含 `hooks: settings.hooks`）加 `hookDeps,`。

- [ ] **Step 7: 线穿 `src/headless.ts`**
7a. import `makeHookRuntime`.
7b. 建 `const hookDeps = makeHookRuntime({ client: opts.client, getModel: () => model, onUsage: addUsage, cwd: () => cwd })`（在 `ctx` 之后、首个 runHooks 之前）。
7c. `ctx.hookDispatch` 加 `hookDeps` 第 4 参。
7d. headless 直接 `runHooks(SessionStart/InstructionsLoaded/UserPromptSubmit, ..., settings.hooks)` 加 `hookDeps`。
7e. `runLoop(messages, { ... })` 的 deps 加 `hookDeps,`（headless loop 也是主会话级）。

- [ ] **Step 8: 集成测试（prompt hook 经 loop 触达 llm）** — 在 `test/loop.test.ts` 的 `describe('runLoop', ...)` 内加（复用该文件既有 `script`/`makeDeps`/`drain` + 已 import 的 `mkdtempSync`/`writeFileSync`/`tmpdir`/`path`/`readTool`）：
```ts
  it('PreToolUse 配 prompt hook：经 loop 触达 hookDeps.llm，{ok:false} 阻断工具', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-hook-'))
    const f = path.join(dir, 'a.txt'); writeFileSync(f, 'x')
    let called = false
    script.push(
      { result: { content: '', toolCalls: [{ id: 't1', name: 'Read', args: JSON.stringify({ file_path: f }) }], usage, finishReason: 'tool_calls' } },
      { result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } },
    )
    const deps = makeDeps([readTool])
    deps.hooks = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'prompt', prompt: '评估 $ARGUMENTS' }] }] } as any
    deps.hookDeps = { llm: async () => { called = true; return '{"ok":false,"reason":"judge 拒绝"}' } }
    const messages: any[] = [{ role: 'system', content: 's' }, { role: 'user', content: '读' }]
    await drain(runLoop(messages, deps))
    expect(called).toBe(true) // prompt hook 经 loop 的 runHooks(...,deps.hookDeps) 调到了 llm
    const toolMsg = messages.find(m => m.role === 'tool')
    expect(toolMsg.content).toContain('PreToolUse hook 阻止') // {ok:false}→block→工具被拦
  })
```
> 此集成测目的仅证明**线穿到位**（loop 把 `deps.hookDeps` 传给 `runHooks` → prompt 执行器触达 `llm`），引擎语义已由 Task 1-3 覆盖，不重复。

- [ ] **Step 9: 全量回归** — `npm test && npm run typecheck && npm run build` → 全 PASS/clean。重点确认 useChat/headless/loop 既有用例无回归（hookDeps 为新增可选字段，未配 hooks 时不触发任何 llm/fetch）。

- [ ] **Step 10: Commit**
```bash
git add src/hookRuntime.ts test/hookRuntime.test.ts src/loop.ts src/tui/useChat.ts src/headless.ts test/loop.test.ts
git commit -m "feat(hooks): hookRuntime(llm/runAgent) + 线穿 useChat/headless/loop (L-042 ①c)"
```

---

## 完成后

- 全量 `npm test` + `npm run typecheck` + `npm run build` 全绿（纯逻辑 + 注入 fake 的执行器测；**免真机 TUI 冒烟**——本件不碰 ink）。
- 走 `superpowers:subagent-driven-development` 每任务 implementer + 规格审 + 质量审双门；**末尾 opus 全量终审**（重点核：① 三执行器超时/abort/错误路径都归一到 HookResult 不抛漏、② `applyHookJson` 抽取与 parseHookStdout 字节等价无回归、③ http env 白名单/消毒确实防 secret 外泄与 CRLF、④ runAgent 子上下文无 hookDispatch 确保 hooks-free 防递归、⑤ 线穿后未配 hooks 仍零开销、loop/useChat/headless 无回归、⑥ agent hook 文本解析近似的偏离已记录）。
- 终审过后 `finishing-a-development-branch` 合 main、push origin。
- 更新 memory：①c 完成、下一步 ①d（async/asyncRewake，挂 tasks.ts；fold ①b-1 终审 minor：PermissionDenied payload 缺 tool_input、headless block 丢 additionalContext）。

## 后续（不在本件）
**①d** async/asyncRewake（command hook stdout 首行 `{"async":true}` → registerAsync 挂 tasks.ts，立即 backgrounded 不阻塞；rewake 注入）→ **①e** TUI 进度（HookProgressMessage，碰 TUI 需用户真机冒烟）。L-044 落地后把 agent hook 的文本解析近似换成 SyntheticOutputTool 结构化输出。
