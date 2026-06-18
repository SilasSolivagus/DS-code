// test/configReport.test.ts
import { describe, it, expect } from 'vitest'
import { formatConfigReport } from '../src/configReport.js'

describe('formatConfigReport', () => {
  it('标来源、打码 apiKey、警告剥离、列文件', () => {
    const out = formatConfigReport({
      settings: { permissions: { allow: [], deny: ['**/.env'] }, compactTokens: 200000, costWarnCNY: 15, maxToolResultChars: 100000, model: 'pro', apiKey: 'sk-secret123' } as any,
      provenance: { model: 'project', apiKey: 'user', permissions: 'merged' },
      scopes: [
        { scope: 'user', path: '/home/u/.deepcode/settings.json', present: true, demoted: false, stripped: [] },
        { scope: 'project', path: '/proj/.deepcode/settings.json', present: true, demoted: false, stripped: ['apiKey', 'hooks', 'permissions.allow'] },
        { scope: 'local', path: '/proj/.deepcode/settings.local.json', present: false, demoted: false, stripped: [] },
      ],
    })
    expect(out).toContain('model')
    expect(out).toContain('[project]')
    expect(out).not.toContain('sk-secret123')      // 打码
    expect(out).toContain('已忽略')                  // 剥离警告
    expect(out).toContain('apiKey')                 // 列出被剥字段
    expect(out).toContain('/proj/.deepcode/settings.json')
  })
})
