import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { globTool } from '../src/tools/glob.js'
import { grepTool } from '../src/tools/grep.js'

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deny-'))
  fs.writeFileSync(path.join(dir, 'id_rsa'), 'SECRET_TOKEN_XYZ')
  fs.writeFileSync(path.join(dir, 'app.ts'), 'SECRET_TOKEN_XYZ')
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

describe('Grep deny 输出过滤', () => {
  it('核心：deny 命中的文件行被过滤，保留非 deny 文件行，并附过滤计数', async () => {
    const out = await grepTool.call({ pattern: 'SECRET_TOKEN_XYZ' }, ctx(['**/id_rsa']))
    // id_rsa 行不应出现（deny 过滤）
    expect(out).not.toContain('id_rsa')
    // app.ts 行应出现
    expect(out).toContain('app.ts')
    // 附有被过滤的计数说明
    expect(out).toContain('被 deny 规则过滤')
  })

  it('无 deny 时 id_rsa 行正常返回（确认过滤由 deny 触发）', async () => {
    const out = await grepTool.call({ pattern: 'SECRET_TOKEN_XYZ' }, ctx([]))
    expect(out).toContain('id_rsa')
  })
})
