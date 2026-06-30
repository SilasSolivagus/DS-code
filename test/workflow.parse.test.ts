// test/workflow.parse.test.ts
import { describe, it, expect } from 'vitest'
import { parseWorkflow, WorkflowParseError } from '../src/workflow/parse.js'

const ok = `export const meta = { name: 'x', description: 'd', phases: [{ title: 'A' }] }
const r = await agent('hi')`

describe('parseWorkflow', () => {
  it('拆出 meta 与 scriptBody', () => {
    const { meta, scriptBody } = parseWorkflow(ok)
    expect(meta.name).toBe('x')
    expect(meta.phases?.[0].title).toBe('A')
    expect(scriptBody).toContain("agent('hi')")
    expect(scriptBody).not.toContain('export const meta')
  })
  it('拒非确定性 Date.now()', () => {
    expect(() => parseWorkflow(`export const meta={name:'x',description:'d'}\nconst t=Date.now()`))
      .toThrow(/must be deterministic: Date\.now\(\)\/Math\.random\(\)\/new Date\(\) are unavailable \(breaks resume\)/)
  })
  it('拒 Math.random / new Date', () => {
    expect(() => parseWorkflow(`export const meta={name:'x',description:'d'}\nMath.random()`)).toThrow(WorkflowParseError)
    expect(() => parseWorkflow(`export const meta={name:'x',description:'d'}\nnew Date()`)).toThrow(WorkflowParseError)
  })
  it('拒 TS 语法（纯 JS）', () => {
    expect(() => parseWorkflow(`export const meta={name:'x',description:'d'}\nconst a: string[] = []`))
      .toThrow(/must be plain JavaScript/)
  })
  it('拒缺失 meta', () => {
    expect(() => parseWorkflow(`const r = await agent('hi')`)).toThrow(/meta/)
  })
  it('拒语法错误', () => {
    expect(() => parseWorkflow(`export const meta={name:'x',description:'d'}\nconst (`)).toThrow(/syntax/)
  })
})
