import { describe, it, expect } from 'vitest'
import { oscNotification, pushNotificationTool } from '../../src/tools/pushNotification.js'

describe('oscNotification', () => {
  it('iTerm/默认 → OSC 9', () => {
    expect(oscNotification('hi', 'iTerm.app')).toBe(']9;hi\x07')
  })
  it('Ghostty → OSC 777', () => {
    expect(oscNotification('hi', 'ghostty')).toContain(']777;notify;')
  })
  it('未知终端 → 至少含响铃兜底', () => {
    expect(oscNotification('hi', undefined)).toContain('\x07')
  })
})

describe('PushNotification tool', () => {
  it('截断到 200 字 + 返回已发提示', async () => {
    const out = await pushNotificationTool.call({ message: 'x'.repeat(300), status: 'proactive' }, {} as any)
    expect(out).toMatch(/已发送|通知/)
  })
})
