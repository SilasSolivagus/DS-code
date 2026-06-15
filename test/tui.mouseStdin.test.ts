import { describe, it, expect } from 'vitest'
import { parseWheel } from '../src/tui/mouseStdin.js'

describe('parseWheel', () => {
  it('提取滚轮上/下，转发剔除', () => {
    expect(parseWheel('\x1b[<64;10;5M')).toEqual({ forward: '', wheels: ['up'] })
    expect(parseWheel('\x1b[<65;10;5M')).toEqual({ forward: '', wheels: ['down'] })
  })

  it('普通按键原样转发，不误判', () => {
    expect(parseWheel('abc')).toEqual({ forward: 'abc', wheels: [] })
    expect(parseWheel('\x1b[A')).toEqual({ forward: '\x1b[A', wheels: [] })  // 上箭头
    expect(parseWheel('\x1b[5~')).toEqual({ forward: '\x1b[5~', wheels: [] }) // PageUp
  })

  it('混合：按键保留、滚轮剔除并解析', () => {
    const r = parseWheel('a\x1b[<64;1;1Mb')
    expect(r.forward).toBe('ab')
    expect(r.wheels).toEqual(['up'])
  })

  it('连续多个滚轮事件', () => {
    const r = parseWheel('\x1b[<65;1;1M\x1b[<65;1;1M\x1b[<64;1;1M')
    expect(r.wheels).toEqual(['down', 'down', 'up'])
    expect(r.forward).toBe('')
  })

  it('非滚轮鼠标（点击 button 0）也剔除、不触发滚动', () => {
    const r = parseWheel('\x1b[<0;1;1M')
    expect(r.forward).toBe('')
    expect(r.wheels).toEqual([])
  })
})
