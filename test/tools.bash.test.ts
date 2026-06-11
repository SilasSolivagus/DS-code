import { describe, it, expect } from 'vitest'
import { bashTool, truncateMiddle } from '../src/tools/bash.js'
import { makeCtx } from './helpers.js'

describe('Bash', () => {
  it('执行命令并返回输出', async () => {
    const out = await bashTool.call({ command: 'echo hi' }, makeCtx('/tmp'))
    expect(out).toContain('hi')
  })

  it('cd 持久化：影响 ctx.cwd', async () => {
    let cwd = process.cwd()
    const ctx = { ...makeCtx(cwd), cwd: () => cwd, setCwd: (d: string) => { cwd = d } }
    await bashTool.call({ command: 'cd /tmp' }, ctx)
    expect(['/tmp', '/private/tmp']).toContain(cwd) // macOS 下 $PWD 可能解析为 /private/tmp
  })

  it('非零退出码报告给模型', async () => {
    const out = await bashTool.call({ command: 'exit 3' }, makeCtx('/tmp'))
    expect(out).toContain('退出码 3')
  })

  it('stderr 一并返回', async () => {
    const out = await bashTool.call({ command: 'echo oops 1>&2' }, makeCtx('/tmp'))
    expect(out).toContain('oops')
  })

  it('truncateMiddle 保留头尾', () => {
    const s = 'a'.repeat(20000) + 'MID' + 'b'.repeat(20000)
    const t = truncateMiddle(s, 30000)
    expect(t.length).toBeLessThan(31000)
    expect(t.startsWith('aaa')).toBe(true)
    expect(t.endsWith('bbb')).toBe(true)
    expect(t).toContain('已截断')
  })
})
