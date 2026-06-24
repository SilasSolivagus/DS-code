import { describe, it, expect } from 'vitest'
import { BUILTIN_OUTPUT_STYLES, resolveOutputStyle, loadOutputStyles } from '../src/outputStyles.js'

describe('outputStyles', () => {
  it('内置含 Explanatory 与 Learning，均 keepCodingInstructions=true', () => {
    const names = BUILTIN_OUTPUT_STYLES.map(s => s.name)
    expect(names).toContain('Explanatory')
    expect(names).toContain('Learning')
    for (const s of BUILTIN_OUTPUT_STYLES) expect(s.keepCodingInstructions).toBe(true)
  })

  it("resolveOutputStyle('default') → undefined（不注入）", () => {
    expect(resolveOutputStyle('default', BUILTIN_OUTPUT_STYLES)).toBeUndefined()
    expect(resolveOutputStyle(undefined, BUILTIN_OUTPUT_STYLES)).toBeUndefined()
    expect(resolveOutputStyle('不存在的', BUILTIN_OUTPUT_STYLES)).toBeUndefined()
  })

  it('resolveOutputStyle 命中内置（大小写不敏感）', () => {
    expect(resolveOutputStyle('explanatory', BUILTIN_OUTPUT_STYLES)?.name).toBe('Explanatory')
  })

  it('loadOutputStyles 在缺失目录时只返回内置（不抛）', () => {
    const styles = loadOutputStyles('/nonexistent-home-xyz')
    expect(styles).toEqual(BUILTIN_OUTPUT_STYLES)
  })
})
