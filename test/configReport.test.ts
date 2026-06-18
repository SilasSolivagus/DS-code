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

  it('降级 scope + 缺失 scope + 短 key 无泄漏', () => {
    const out = formatConfigReport({
      settings: { apiKey: 'shortkey', model: 'dev' } as any,
      provenance: { apiKey: 'local', model: 'user' },
      scopes: [
        { scope: 'user', path: '/home/u/.deepcode/settings.json', present: true, demoted: false, stripped: [] },
        { scope: 'local', path: '/proj/.deepcode/settings.local.json', present: true, demoted: true, stripped: ['permissions'] },
        { scope: 'project', path: '/proj/.deepcode/settings.json', present: false, demoted: false, stripped: [] },
      ],
    })
    expect(out).toContain('git-tracked 已降级')     // 降级标记
    expect(out).toContain('(已加载)')               // 现存 user scope
    expect(out).toContain('(已加载·降级)')          // 降级 local scope
    expect(out).toContain('(缺失)')                 // 缺失 project scope
    expect(out).not.toContain('shortkey')          // 短 key（8字符）无泄漏
    expect(out).toContain('…(已打码)')              // 仅显示掩码
  })
})
