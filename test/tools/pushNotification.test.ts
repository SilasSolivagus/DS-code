import { describe, it, expect } from 'vitest'
import { oscNotification, pushNotificationTool } from '../../src/tools/pushNotification.js'

describe('oscNotification', () => {
  it('iTerm/默认 → OSC 9 + 独立 BEL', () => {
    expect(oscNotification('hi', 'iTerm.app')).toBe('\x1b]9;hi\x07\x07')
  })
  it('Ghostty → OSC 777 + 独立 BEL', () => {
    expect(oscNotification('hi', 'ghostty')).toContain('\x1b]777;notify;')
    expect(oscNotification('hi', 'ghostty')).toMatch(/\x07\x07$/)
  })
  it('未知终端 → OSC 9 + 独立 BEL 响铃兜底', () => {
    expect(oscNotification('hi', 'unknown')).toBe('\x1b]9;hi\x07\x07')
    expect(oscNotification('hi', 'unknown')).toMatch(/\x07\x07$/)
  })
})

describe('PushNotification tool', () => {
  it('截断到 200 字 + 返回已发提示', async () => {
    const out = await pushNotificationTool.call({ message: 'x'.repeat(300), status: 'proactive' }, {} as any)
    expect(out).toMatch(/已发送|通知/)
    expect(out).toContain('已发送桌面通知：' + 'x'.repeat(200))
  })
})
