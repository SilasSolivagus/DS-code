import { describe, it, expect } from 'vitest'
import { splitStablePrefix } from '../src/tui/streamingMarkdown.js'

describe('splitStablePrefix', () => {
  it('单段落（仍可能增长）→ 全 unstable', () => {
    expect(splitStablePrefix('hello world')).toEqual({ stable: '', unstable: 'hello world' })
  })
  it('标题 + 段落 → 标题进 stable、末段留 unstable', () => {
    const r = splitStablePrefix('# 标题\n\n正文还在写')
    expect(r.stable).toContain('# 标题')
    expect(r.unstable).toContain('正文还在写')
  })
  it('未闭合代码围栏 → 全 unstable（不误切）', () => {
    const r = splitStablePrefix('```js\nconst a = 1')
    expect(r.stable).toBe('')
    expect(r.unstable).toContain('```js')
  })
  it('空文本', () => {
    expect(splitStablePrefix('')).toEqual({ stable: '', unstable: '' })
  })
})
