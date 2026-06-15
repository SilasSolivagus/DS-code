// test/export.test.ts
import { describe, it, expect } from 'vitest'
import { exportTranscript, type ExportMeta } from '../src/export.js'

const meta: ExportMeta = { model: 'deepseek-v4-flash', cwd: '/work', exportedAt: '2026-06-15T00:00:00.000Z' }

describe('exportTranscript', () => {
  it('空对话（只有 system）：仅标题 + meta，无消息小节', () => {
    const md = exportTranscript([{ role: 'system', content: 'SYS' }], meta)
    expect(md).toContain('# deepcode 对话导出')
    expect(md).toContain('deepseek-v4-flash')
    expect(md).toContain('/work')
    expect(md).toContain('2026-06-15T00:00:00.000Z')
    expect(md).not.toContain('SYS') // system 被跳过
    expect(md).not.toContain('👤')
    expect(md).not.toContain('🤖')
  })

  it('单轮用户 + 助手：各一个小节，原样输出', () => {
    const md = exportTranscript(
      [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好，我能帮你什么？' },
      ],
      meta,
    )
    expect(md).toContain('## 👤 用户')
    expect(md).toContain('你好')
    expect(md).toContain('## 🤖 助手')
    expect(md).toContain('你好，我能帮你什么？')
  })

  it('带 tool_calls 的助手：渲染工具调用行', () => {
    const md = exportTranscript(
      [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: '读文件' },
        {
          role: 'assistant',
          content: '好的',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"path":"a.ts"}' } },
          ],
        },
      ],
      meta,
    )
    expect(md).toContain('好的')
    expect(md).toContain('🔧')
    expect(md).toContain('Read')
    expect(md).toContain('a.ts')
  })

  it('content 为 null 但有 tool_calls 的助手：仍渲染工具调用', () => {
    const md = exportTranscript(
      [
        { role: 'system', content: 'SYS' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } }],
        },
      ],
      meta,
    )
    expect(md).toContain('## 🤖 助手')
    expect(md).toContain('🔧')
    expect(md).toContain('Bash')
  })

  it('role=tool 结果：渲染工具结果块', () => {
    const md = exportTranscript(
      [
        { role: 'system', content: 'SYS' },
        { role: 'tool', tool_call_id: 'c1', content: 'file contents here' },
      ],
      meta,
    )
    expect(md).toContain('⎿')
    expect(md).toContain('file contents here')
  })

  it('content 为数组形态：拼接文本部分', () => {
    const md = exportTranscript(
      [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] },
      ],
      meta,
    )
    expect(md).toContain('第一段')
    expect(md).toContain('第二段')
  })

  it('空内容消息跳过：content 为空字符串的 user 不产生小节', () => {
    const md = exportTranscript(
      [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: '' },
        { role: 'assistant', content: '回复' },
      ],
      meta,
    )
    // 只应有一个 user 标题（实际为 0 个，因为空 user 被跳过）
    expect(md).not.toContain('## 👤 用户')
    expect(md).toContain('## 🤖 助手')
    expect(md).toContain('回复')
  })

  it('不调用 new Date（纯函数）：时间完全由 meta 决定', () => {
    const md = exportTranscript([{ role: 'system', content: 'SYS' }], {
      model: 'm',
      cwd: 'c',
      exportedAt: 'FIXED-TIME',
    })
    expect(md).toContain('FIXED-TIME')
  })
})
