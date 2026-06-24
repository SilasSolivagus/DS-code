import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { globTool } from '../src/tools/glob.js'
import { grepTool } from '../src/tools/grep.js'
import { makeCtx } from './helpers.js'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'dc-'))
  mkdirSync(path.join(dir, 'src'))
  writeFileSync(path.join(dir, 'src/a.ts'), 'export function hello() {}\n')
  writeFileSync(path.join(dir, 'src/b.ts'), 'export function world() {}\n')
  writeFileSync(path.join(dir, 'readme.md'), '# hi\n')
})

describe('Glob', () => {
  it('按模式匹配文件', async () => {
    const out = await globTool.call({ pattern: 'src/**/*.ts' }, makeCtx(dir))
    expect(out).toContain('src/a.ts')
    expect(out).toContain('src/b.ts')
    expect(out).not.toContain('readme.md')
  })
  it('无匹配时明确说明', async () => {
    const out = await globTool.call({ pattern: '**/*.py' }, makeCtx(dir))
    expect(out).toContain('没有匹配')
  })
})

describe('Grep', () => {
  it('返回 文件:行号:内容', async () => {
    const out = await grepTool.call({ pattern: 'hello' }, makeCtx(dir))
    expect(out).toMatch(/a\.ts:1:/)
  })
  it('glob 过滤生效', async () => {
    const out = await grepTool.call({ pattern: 'hi', glob: '*.ts' }, makeCtx(dir))
    expect(out).toContain('没有匹配')
  })
  it('非法正则返回明确错误而非「没有匹配」', async () => {
    const out = await grepTool.call({ pattern: '(?invalid' }, makeCtx(dir))
    expect(out).toContain('Grep 错误')
  })
  it('description 含 ripgrep/正则/multiline/glob 提示', () => {
    expect(grepTool.description).toContain('ripgrep')
    expect(grepTool.description).toContain('multiline')
    expect(grepTool.description).toContain('正则')
    expect(grepTool.description).toContain('glob')
  })
})

describe('Glob description', () => {
  it('description 含 glob 模式示例', () => {
    expect(globTool.description).toContain('**/*.ts')
    expect(globTool.description).toContain('src/**/test_*')
  })
})
