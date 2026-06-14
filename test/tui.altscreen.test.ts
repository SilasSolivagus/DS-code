import { describe, it, expect, vi } from 'vitest'
import { enterAltScreen, installCleanup } from '../src/tui/altscreen.js'

describe('altscreen', () => {
  it('enterAltScreen 写进备用屏 + 清屏归位转义；leave 还原主屏 + 显光标', () => {
    const writes: string[] = []
    const leave = enterAltScreen(s => writes.push(s))
    expect(writes.join('')).toContain('\x1b[?1049h')
    expect(writes.join('')).toContain('\x1b[2J')
    leave()
    expect(writes.join('')).toContain('\x1b[?1049l')
    expect(writes.join('')).toContain('\x1b[?25h')
  })

  it('leave 幂等：二次调用不再写', () => {
    const writes: string[] = []
    const leave = enterAltScreen(s => writes.push(s))
    const n1 = writes.length
    leave()
    const n2 = writes.length
    leave()
    expect(writes.length).toBe(n2)
    expect(n2).toBeGreaterThan(n1)
  })

  it('installCleanup 注册 4 个进程事件、disposer 全摘除', () => {
    const before = {
      exit: process.listenerCount('exit'),
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
      uncaught: process.listenerCount('uncaughtException'),
    }
    const dispose = installCleanup(() => {})
    expect(process.listenerCount('exit')).toBe(before.exit + 1)
    expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1)
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1)
    expect(process.listenerCount('uncaughtException')).toBe(before.uncaught + 1)
    dispose()
    expect(process.listenerCount('exit')).toBe(before.exit)
    expect(process.listenerCount('SIGINT')).toBe(before.sigint)
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm)
    expect(process.listenerCount('uncaughtException')).toBe(before.uncaught)
  })
})
