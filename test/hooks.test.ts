// test/hooks.test.ts
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { matchesMatcher, matchQueryFor, evalIfCondition, parseHookStdout, mergeResults, runHooks, substituteArguments, parseHookEvalResult, interpolateEnvVars, isAsyncFirstLine } from '../src/hooks.js'
import type { HookResult, HooksConfig } from '../src/hooks.js'

describe('matchesMatcher', () => {
  it('undefined / 空串 / * → 恒匹配', () => {
    expect(matchesMatcher(undefined, 'Write')).toBe(true)
    expect(matchesMatcher('', 'Write')).toBe(true)
    expect(matchesMatcher('*', 'Write')).toBe(true)
  })
  it('简单标识符 → 精确匹配', () => {
    expect(matchesMatcher('Write', 'Write')).toBe(true)
    expect(matchesMatcher('Write', 'Edit')).toBe(false)
  })
  it('管道列表 → 多精确或', () => {
    expect(matchesMatcher('Write|Edit', 'Edit')).toBe(true)
    expect(matchesMatcher('Write|Edit', 'Read')).toBe(false)
  })
  it('正则 → 测试', () => {
    expect(matchesMatcher('^Wr.*', 'Write')).toBe(true)
    expect(matchesMatcher('^Ed.*', 'Write')).toBe(false)
  })
  it('非法正则 → false（不抛）', () => {
    expect(matchesMatcher('[invalid(', 'Write')).toBe(false)
  })
  it('超长 matcher → false（ReDoS 护栏）', () => {
    expect(matchesMatcher('a'.repeat(201), 'a')).toBe(false)
  })
})

describe('matchQueryFor', () => {
  it('工具类 → tool_name', () => {
    expect(matchQueryFor('PreToolUse', { tool_name: 'Write' })).toBe('Write')
    expect(matchQueryFor('PostToolUse', { tool_name: 'Bash' })).toBe('Bash')
  })
  it('SessionStart → source；PreCompact → trigger；SubagentStop → agent_type', () => {
    expect(matchQueryFor('SessionStart', { source: 'startup' })).toBe('startup')
    expect(matchQueryFor('PreCompact', { trigger: 'auto' })).toBe('auto')
    expect(matchQueryFor('SubagentStop', { agent_type: 'Explore' })).toBe('Explore')
  })
  it('matcher 忽略类（TaskCreated/Stop）→ undefined', () => {
    expect(matchQueryFor('TaskCreated', {})).toBeUndefined()
    expect(matchQueryFor('Stop', {})).toBeUndefined()
  })
})

describe('evalIfCondition', () => {
  it('无 if → true', () => {
    expect(evalIfCondition(undefined, 'Bash', 'npm test')).toBe(true)
  })
  it('裸工具名 → 仅比工具名', () => {
    expect(evalIfCondition('Bash', 'Bash', 'whatever')).toBe(true)
    expect(evalIfCondition('Bash', 'Write', 'whatever')).toBe(false)
  })
  it('Tool(pat) → 复用 matchRule（:* 前缀）', () => {
    expect(evalIfCondition('Bash(npm test:*)', 'Bash', 'npm test -- foo')).toBe(true)
    expect(evalIfCondition('Bash(npm test:*)', 'Bash', 'rm -rf /')).toBe(false)
  })
})

describe('parseHookStdout', () => {
  it('exit 2 → blocking + preventContinuation + stderr 作 reason', () => {
    const r = parseHookStdout('', 2, '安全审计失败')
    expect(r.outcome).toBe('blocking')
    expect(r.blockingError).toBe('安全审计失败')
    expect(r.preventContinuation).toBe(true)
  })
  it('exit 非 0 非 2 → non_blocking_error', () => {
    expect(parseHookStdout('', 1, 'boom').outcome).toBe('non_blocking_error')
  })
  it('exit 0 空输出 → success', () => {
    expect(parseHookStdout('', 0, '').outcome).toBe('success')
  })
  it('exit 0 非 JSON → success + additionalContext', () => {
    const r = parseHookStdout('hello world', 0, '')
    expect(r.outcome).toBe('success')
    expect(r.additionalContext).toBe('hello world')
  })
  it('exit 0 JSON permissionDecision deny', () => {
    const r = parseHookStdout(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: '禁止' } }), 0, '')
    expect(r.permissionDecision).toBe('deny')
    expect(r.permissionReason).toBe('禁止')
  })
  it('exit 0 JSON updatedInput + additionalContext', () => {
    const r = parseHookStdout(JSON.stringify({ hookSpecificOutput: { updatedInput: { path: '/safe' }, additionalContext: '已改写' } }), 0, '')
    expect(r.updatedInput).toEqual({ path: '/safe' })
    expect(r.additionalContext).toBe('已改写')
  })
  it('exit 0 JSON decision:block → blocking', () => {
    const r = parseHookStdout(JSON.stringify({ decision: 'block', reason: 'no' }), 0, '')
    expect(r.outcome).toBe('blocking')
    expect(r.blockingError).toBe('no')
  })
  it('exit 0 JSON decision:approve → permissionDecision allow', () => {
    const r = parseHookStdout(JSON.stringify({ decision: 'approve' }), 0, '')
    expect(r.permissionDecision).toBe('allow')
  })
  it('exit 0 JSON continue:false → stop', () => {
    expect(parseHookStdout(JSON.stringify({ continue: false }), 0, '').stop).toBe(true)
  })
  it('exit 0 JSON 数组 → 当作 additionalContext，不丢数据', () => {
    const r = parseHookStdout('["w1","w2"]', 0, '')
    expect(r.outcome).toBe('success')
    expect(r.additionalContext).toBe('["w1","w2"]')
  })
})

const mk = (over: Partial<HookResult>): HookResult => ({ outcome: 'success', label: 'h', durationMs: 1, ...over })

describe('mergeResults', () => {
  it('任一 blocking / deny → block，取首个 reason', () => {
    const o = mergeResults([mk({ outcome: 'success' }), mk({ outcome: 'blocking', blockingError: 'X' })], 'PreToolUse')
    expect(o.block).toBe(true)
    expect(o.blockReason).toBe('X')
  })
  it('优先级 deny > ask > allow', () => {
    expect(mergeResults([mk({ permissionDecision: 'allow' }), mk({ permissionDecision: 'ask' }), mk({ permissionDecision: 'deny' })], 'PreToolUse').permission).toBe('deny')
    expect(mergeResults([mk({ permissionDecision: 'allow' }), mk({ permissionDecision: 'ask' })], 'PreToolUse').permission).toBe('ask')
    expect(mergeResults([mk({ permissionDecision: 'allow' })], 'PreToolUse').permission).toBe('allow')
  })
  it('updatedInput / updatedOutput 取配置序最后一个非空', () => {
    const o = mergeResults([mk({ updatedInput: { a: 1 } }), mk({ updatedInput: { a: 2 } })], 'PreToolUse')
    expect(o.updatedInput).toEqual({ a: 2 })
  })
  it('additionalContext / systemMessage 累加（\\n\\n 连接）', () => {
    const o = mergeResults([mk({ additionalContext: 'A' }), mk({ additionalContext: 'B' })], 'PostToolUse')
    expect(o.additionalContext).toBe('A\n\nB')
  })
  it('preventContinuation / stop 任一为真', () => {
    expect(mergeResults([mk({}), mk({ preventContinuation: true })], 'Stop').preventContinuation).toBe(true)
    expect(mergeResults([mk({ stop: true })], 'Stop').stop).toBe(true)
  })
  it('一个 hook decision:block(blocking) + 另一个 ask → block 为真且 permission 为 ask', () => {
    const o = mergeResults([mk({ outcome: 'blocking', blockingError: 'no', preventContinuation: true }), mk({ permissionDecision: 'ask' })], 'PreToolUse')
    expect(o.block).toBe(true)
    expect(o.permission).toBe('ask')
  })
})

// 造假 child：可控 stdout/stderr/exit；记录 stdin。
function fakeChild(stdout: string, code: number, stderr = '') {
  const child: any = new EventEmitter()
  child.stdin = { write: vi.fn(), end: vi.fn() }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout))
    if (stderr) child.stderr.emit('data', Buffer.from(stderr))
    child.emit('close', code)
  })
  return child
}

describe('runHooks', () => {
  it('未配置该事件 → 零开销，spawn 不被调用', async () => {
    const spawn = vi.fn()
    const o = await runHooks('PreToolUse', { tool_name: 'Write' }, undefined, { spawn })
    expect(o.results).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
  })
  it('command 类型：写 stdin payload + 解析 exit 0 JSON', async () => {
    const spawn = vi.fn(() => fakeChild(JSON.stringify({ hookSpecificOutput: { additionalContext: 'ok' } }), 0))
    const cfg: HooksConfig = { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo hi' }] }] }
    const o = await runHooks('PreToolUse', { tool_name: 'Write', tool_input: { a: 1 } }, cfg, { spawn })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(o.additionalContext).toBe('ok')
    expect(o.results[0].label).toBe('echo hi')
  })
  it('matcher 不匹配 → 不 spawn', async () => {
    const spawn = vi.fn(() => fakeChild('', 0))
    const cfg: HooksConfig = { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'x' }] }] }
    await runHooks('PreToolUse', { tool_name: 'Write' }, cfg, { spawn })
    expect(spawn).not.toHaveBeenCalled()
  })
  it('if 不匹配 → 跳过该 hook', async () => {
    const spawn = vi.fn(() => fakeChild('', 0))
    const cfg: HooksConfig = { PreToolUse: [{ hooks: [{ type: 'command', command: 'x', if: 'Bash(git:*)' }] }] }
    await runHooks('PreToolUse', { tool_name: 'Bash', tool_desc: 'npm test' }, cfg, { spawn })
    expect(spawn).not.toHaveBeenCalled()
  })
  it('exit 2 → block', async () => {
    const spawn = vi.fn(() => fakeChild('', 2, '拒绝'))
    const cfg: HooksConfig = { PreToolUse: [{ hooks: [{ type: 'command', command: 'guard' }] }] }
    const o = await runHooks('PreToolUse', { tool_name: 'Write' }, cfg, { spawn })
    expect(o.block).toBe(true)
    expect(o.blockReason).toBe('拒绝')
  })
  it('未支持类型（prompt）→ non_blocking_error 占位，不崩', async () => {
    const cfg: HooksConfig = { PreToolUse: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }] }
    const o = await runHooks('PreToolUse', { tool_name: 'Write' }, cfg, {})
    expect(o.results[0].outcome).toBe('non_blocking_error')
  })
})

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
    expect(existsSync(path.join(base, 'sess-x'))).toBe(false)
    expect(out.block).toBe(false)
  })

  it('env-file 事件但 payload 无 session_id → 不注入、不建目录', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'deepcode-eng-senv3-'))
    const config = {
      Setup: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo export X=1 >> "${DEEPCODE_ENV_FILE:-/dev/null}"' }] }],
    } as any
    await runHooks('Setup', { hook_event_name: 'Setup', trigger: 'init' }, config, { sessionEnvBase: base })
    expect(existsSync(base)).toBe(true)
    expect(readdirSync(base)).toEqual([])
  })
})

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
    expect(seen[0]).toContain('rm -rf /')
  })
  it('未配置 llm → prompt hook 记 non_blocking_error，不 block', async () => {
    const config = { Stop: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }] } as any
    const out = await runHooks('Stop', { hook_event_name: 'Stop' }, config, {})
    expect(out.block).toBe(false)
    expect(out.results[0].outcome).toBe('non_blocking_error')
  })
})

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

describe('interpolateEnvVars', () => {
  it('白名单内插值，白名单外→空串；消毒 CRLF/NUL', () => {
    process.env.DC_HOOK_TOK = 'secret'
    process.env.DC_HOOK_EVIL = 'a\r\nX-Evil: 1'
    const allowed = new Set(['DC_HOOK_TOK', 'DC_HOOK_EVIL'])
    expect(interpolateEnvVars('Bearer $DC_HOOK_TOK', allowed)).toBe('Bearer secret')
    expect(interpolateEnvVars('Bearer ${DC_HOOK_TOK}', allowed)).toBe('Bearer secret')
    expect(interpolateEnvVars('$DC_NOT_ALLOWED', new Set())).toBe('')
    expect(interpolateEnvVars('$DC_HOOK_EVIL', allowed)).toBe('aX-Evil: 1')
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
    expect(captured.init.headers['X-Tok']).toBe('') // 未配 allowedEnvVars → 空串
    delete process.env.DC_T
  })
  it('非 2xx → blocking', async () => {
    const fakeFetch = (async () => ({ status: 500, text: async () => '' })) as any
    const config = { Stop: [{ hooks: [{ type: 'http', url: 'https://hook.test/y' }] }] } as any
    const out = await runHooks('Stop', { hook_event_name: 'Stop' }, config, { fetch: fakeFetch })
    expect(out.results[0].outcome).toBe('blocking')
  })
})

describe('runHooks async', () => {
  it('配置 async:true → 调 registerAsync，返 backgrounded，不阻塞', async () => {
    const registerAsync = vi.fn()
    const spawn = vi.fn(() => fakeChild('', 0)) // 即便 child 会 close，配置级 async 已在 stdin 后 handoff
    const cfg: HooksConfig = { PreToolUse: [{ hooks: [{ type: 'command', command: 'bg', async: true }] }] }
    const o = await runHooks('PreToolUse', { tool_name: 'Write' }, cfg, { spawn, registerAsync })
    expect(registerAsync).toHaveBeenCalledTimes(1)
    expect(o.results[0].outcome).toBe('backgrounded')
    expect(o.block).toBe(false)
  })

  it('stdout 首行 {"async":true} → 调 registerAsync 并 handoff', async () => {
    const registerAsync = vi.fn()
    // child 仅 emit 首行 marker，不 close（模拟仍在后台跑）
    const child: any = new EventEmitter()
    child.stdin = { write: vi.fn(), end: vi.fn() }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = vi.fn()
    queueMicrotask(() => child.stdout.emit('data', Buffer.from('{"async":true}\n')))
    const spawn = vi.fn(() => child)
    const cfg: HooksConfig = { PreToolUse: [{ hooks: [{ type: 'command', command: 'maybe' }] }] }
    const o = await runHooks('PreToolUse', { tool_name: 'Write' }, cfg, { spawn, registerAsync })
    expect(registerAsync).toHaveBeenCalledTimes(1)
    expect(o.results[0].outcome).toBe('backgrounded')
  })

  it('fail-safe：配置 async 但无 registerAsync dep → 同步阻塞执行', async () => {
    const spawn = vi.fn(() => fakeChild(JSON.stringify({ hookSpecificOutput: { additionalContext: 'sync' } }), 0))
    const cfg: HooksConfig = { PreToolUse: [{ hooks: [{ type: 'command', command: 'bg', async: true }] }] }
    const o = await runHooks('PreToolUse', { tool_name: 'Write' }, cfg, { spawn })
    expect(o.results[0].outcome).toBe('success')
    expect(o.additionalContext).toBe('sync')
  })
})

describe('isAsyncFirstLine', () => {
  it('合法 async marker → 解析', () => {
    expect(isAsyncFirstLine('{"async":true}')).toEqual({ async: true })
  })
  it('带 asyncTimeout（ms）', () => {
    expect(isAsyncFirstLine('{"async":true,"asyncTimeout":5000}')).toEqual({ async: true, asyncTimeout: 5000 })
  })
  it('async 非 true → null', () => {
    expect(isAsyncFirstLine('{"async":false}')).toBeNull()
  })
  it('无 async 字段 → null', () => {
    expect(isAsyncFirstLine('{"foo":1}')).toBeNull()
  })
  it('行不完整（无闭合括号）→ null', () => {
    expect(isAsyncFirstLine('{"async":tru')).toBeNull()
  })
  it('非 JSON → null', () => {
    expect(isAsyncFirstLine('hello world')).toBeNull()
  })
  it('asyncTimeout 非数字 → 忽略该字段', () => {
    expect(isAsyncFirstLine('{"async":true,"asyncTimeout":"x"}')).toEqual({ async: true })
  })
})
