import { describe, it, expect } from 'vitest'
import { resolveAttachments, expandTextAttachments } from '../src/tui/useChat.js'

describe('resolveAttachments / expandTextAttachments（文本部分）', () => {
  it('展开文本占位符为完整原文', async () => {
    const out = await resolveAttachments('看这段 [Pasted text #1] 谢谢', [{ id: 1, type: 'text', content: 'A\nB\nC' }])
    expect(out).toBe('看这段 A\nB\nC 谢谢')
  })
  it('无附件原样返回', async () => {
    expect(await resolveAttachments('hello', undefined)).toBe('hello')
  })
  it('expandTextAttachments 同步展开（steer 路径用）', () => {
    expect(expandTextAttachments('a [Pasted text #1] b', [{ id: 1, type: 'text', content: 'X\nY' }])).toBe('a X\nY b')
    expect(expandTextAttachments('a', undefined)).toBe('a')
  })
})

describe('resolveAttachments — 图片识别注入', () => {
  it('图片占位符 → describeImage 注入', async () => {
    const fakeDescribe = async () => '报错是 NPE，第12行空指针'
    const out = await resolveAttachments(
      '这报错？ [Image #1]',
      [{ id: 1, type: 'image', base64: 'A', mime: 'image/png', source: 'file' }],
      { describe: fakeDescribe },
    )
    expect(out).toContain('<图片#1 识别(glm-4.6v)>报错是 NPE，第12行空指针</图片#1>')
    expect(out).not.toContain('[Image #1]')
  })

  it('GlmKeyMissingError → 未配置 GLM key 降级 + onError 回调', async () => {
    const { GlmKeyMissingError } = await import('../src/imageDescribe.js')
    const fakeDescribe = async () => { throw new GlmKeyMissingError() }
    const errors: string[] = []
    const out = await resolveAttachments(
      '[Image #2] 是什么',
      [{ id: 2, type: 'image', base64: 'B', mime: 'image/jpeg', source: 'clipboard' }],
      { describe: fakeDescribe, onError: (msg) => errors.push(msg) },
    )
    expect(out).toContain('<图片#2 无法识别：未配置 GLM key>')
    expect(errors).toEqual(['未配置 GLM key'])
  })

  it('其他错误 → 识别失败降级', async () => {
    const fakeDescribe = async () => { throw new Error('network error') }
    const steps: number[] = []
    const out = await resolveAttachments(
      '[Image #3]',
      [{ id: 3, type: 'image', base64: 'C', mime: 'image/png', source: 'file' }],
      { describe: fakeDescribe, onStep: (id) => steps.push(id) },
    )
    expect(out).toContain('<图片#3 无法识别：识别失败>')
    expect(steps).toEqual([3])
  })

  it('文本+图片混合：文本展开 + 图片注入', async () => {
    const fakeDescribe = async () => 'hello image'
    const out = await resolveAttachments(
      '[Pasted text #1] 和 [Image #2]',
      [
        { id: 1, type: 'text', content: 'some text' },
        { id: 2, type: 'image', base64: 'D', mime: 'image/png', source: 'file' },
      ],
      { describe: fakeDescribe },
    )
    expect(out).toBe('some text 和 <图片#2 识别(glm-4.6v)>hello image</图片#2>')
  })

  it('$& 等特殊替换模式在描述中不损坏输出（回归 Fix #1）', async () => {
    const fakeDescribe = async () => '价格是 $&100'
    const out = await resolveAttachments(
      '看图 [Image #1]',
      [{ id: 1, type: 'image', base64: 'A', mime: 'image/png', source: 'file' }],
      { describe: fakeDescribe },
    )
    // 描述中的 $& 必须原样保留，不得被 String.replace 插回占位符
    expect(out).toContain('价格是 $&100')
    expect(out).not.toContain('[Image #1]')
  })
})
