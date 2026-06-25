import { describe, it, expect } from 'vitest'
import { suggestRule } from '../src/permissions.js'

describe('suggestRule', () => {
  it('Bash 普通命令：前 2 词 + :*', () => {
    expect(suggestRule('Bash', 'npm test -- --watch')).toBe('Bash(npm test:*)')
  })
  it('Bash 高危命令：精确整行', () => {
    expect(suggestRule('Bash', 'rm -rf /tmp/x')).toBe('Bash(rm -rf /tmp/x)')
  })
  it('Bash 复合命令：精确整行', () => {
    expect(suggestRule('Bash', 'npm test && echo done')).toBe('Bash(npm test && echo done)')
  })
  it('非 Bash 工具：精确整行', () => {
    expect(suggestRule('Edit', './src/a.ts')).toBe('Edit(./src/a.ts)')
  })
  it('多行 desc：换行替换为空格', () => {
    expect(suggestRule('Write', 'a\nb')).toBe('Write(a b)')
  })
})
