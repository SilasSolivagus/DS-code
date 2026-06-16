// test/hooks.test.ts
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { matchesMatcher, matchQueryFor, evalIfCondition, parseHookStdout, mergeResults, runHooks } from '../src/hooks.js'
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
