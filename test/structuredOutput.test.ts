import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { makeStructuredOutputTool, STRUCTURED_OUTPUT_TOOL_NAME, MAX_STRUCTURED_OUTPUT_RETRIES, structuredOutputReminder } from '../src/tools/structuredOutput.js'

const schema = z.object({ ok: z.boolean(), reason: z.string().optional() })
const ctx: any = { cwd: () => process.cwd(), setCwd: () => {}, signal: new AbortController().signal, fileState: new Map() }

describe('structuredOutput 常量', () => {
  it('工具名与重试上限对齐 CC', () => {
    expect(STRUCTURED_OUTPUT_TOOL_NAME).toBe('StructuredOutput')
    expect(MAX_STRUCTURED_OUTPUT_RETRIES).toBe(5)
    expect(structuredOutputReminder()).toContain('StructuredOutput')
  })
})

describe('makeStructuredOutputTool', () => {
  it('合 schema → onValid 收到规范化对象 + 返回成功串', async () => {
    const seen: unknown[] = []
    const tool = makeStructuredOutputTool(schema, v => seen.push(v))
    expect(tool.name).toBe('StructuredOutput')
    expect(tool.isReadOnly).toBe(true)
    expect(tool.needsPermission({} as any)).toBe(false)
    const out = await tool.call({ ok: false, reason: '不通过' }, ctx)
    expect(seen).toEqual([{ ok: false, reason: '不通过' }])
    expect(out).toContain('已记录')
  })

  it('不合 schema → 返回错误串、onValid 不被调', async () => {
    const onValid = vi.fn()
    const tool = makeStructuredOutputTool(schema, onValid)
    const out = await tool.call({ ok: 'yes' } as any, ctx)
    expect(onValid).not.toHaveBeenCalled()
    expect(out).toContain('错误')
    expect(out).toContain(STRUCTURED_OUTPUT_TOOL_NAME)
  })

  it('inputSchema 即传入 schema（API 层经 toApiTools 暴露给模型）', () => {
    const tool = makeStructuredOutputTool(schema, () => {})
    expect(tool.inputSchema).toBe(schema)
  })
})
