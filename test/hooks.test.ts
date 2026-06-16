// test/hooks.test.ts
import { describe, it, expect, vi } from 'vitest'
import { matchesMatcher, matchQueryFor, evalIfCondition, parseHookStdout } from '../src/hooks.js'

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
  it('exit 0 JSON continue:false → stop', () => {
    expect(parseHookStdout(JSON.stringify({ continue: false }), 0, '').stop).toBe(true)
  })
})
