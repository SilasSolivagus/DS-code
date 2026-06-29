import { describe, it, expect } from 'vitest'
import { describeImage } from '../src/imageDescribe.js'

it('拼多模态请求并返回识别文字', async () => {
  let captured: any
  const fakeClient = { chat: { completions: { create: async (req: any) => { captured = req; return { choices: [{ message: { content: '识别结果X' } }] } } } } }
  const out = await describeImage({ base64: 'AAAA', mime: 'image/png' }, '这报错怎么解决', { client: fakeClient, model: 'glm-4.6v' })
  expect(out).toBe('识别结果X')
  expect(captured.model).toBe('glm-4.6v')
  const content = captured.messages[0].content
  expect(content.find((p: any) => p.type === 'image_url').image_url.url).toBe('data:image/png;base64,AAAA')
  expect(content.find((p: any) => p.type === 'text').text).toContain('这报错怎么解决')
})
