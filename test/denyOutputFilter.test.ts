import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { globTool } from '../src/tools/glob.js'

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deny-'))
  fs.writeFileSync(path.join(dir, 'id_rsa'), 'SECRET')
  fs.writeFileSync(path.join(dir, 'app.ts'), 'ok')
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const ctx = (deny: string[]) => ({ cwd: () => dir, denyPatterns: () => deny } as any)

it('Glob 过滤掉 deny 命中的结果', async () => {
  const out = await globTool.call({ pattern: '*' }, ctx(['**/id_rsa']))
  expect(out).not.toContain('id_rsa')
  expect(out).toContain('app.ts')
  expect(out).toContain('被 deny 规则过滤')
})

it('无 deny 时正常返回', async () => {
  const out = await globTool.call({ pattern: '*' }, ctx([]))
  expect(out).toContain('id_rsa')
})
