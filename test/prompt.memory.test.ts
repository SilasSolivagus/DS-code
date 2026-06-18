import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSystemPrompt } from '../src/prompt.js'

describe('buildSystemPrompt memdir 段', () => {
  let md: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-bsp-')) })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }) })
  test('给 memdir → 注入记忆索引段', () => {
    fs.writeFileSync(path.join(md, 'MEMORY.md'), '- [x](x.md) — hook')
    const out = buildSystemPrompt(process.cwd(), os.homedir(), undefined, undefined, md)
    expect(out).toContain('## 记忆索引')
    expect(out).toContain('x.md')
  })
  test('不给 memdir → 无记忆索引段（recall 开态）', () => {
    const out = buildSystemPrompt(process.cwd(), os.homedir())
    expect(out).not.toContain('## 记忆索引')
  })
})
