// test/tui.input.test.tsx
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { InputBox } from '../src/tui/components/InputBox.js'

const noop = () => {}
// ink 的 useInput 在 useEffect 中注册 stdin 监听器；需等一个微任务让 effect 跑完后才能写 stdin
const delay = (ms = 0) => new Promise(res => setTimeout(res, ms))

describe('InputBox', () => {
  it('空闲时显示 placeholder、提示符与快捷键提示，输入后显示内容与光标', async () => {
    const r = render(<InputBox onSubmit={noop} onInterrupt={noop} history={[]} busy={false} />)
    await delay()
    expect(r.lastFrame()).toContain('随便问点什么…')
    expect(r.lastFrame()).toContain('>')
    expect(r.lastFrame()).toContain('? 查看快捷键')
    r.stdin.write('你好')
    expect(r.lastFrame()).toContain('你好')
  })

  it('Enter 提交并清空；行尾反斜杠续行不提交', async () => {
    const onSubmit = vi.fn()
    const r = render(<InputBox onSubmit={onSubmit} onInterrupt={noop} history={[]} busy={false} />)
    await delay()
    r.stdin.write('第一行\\')
    r.stdin.write('\r')
    expect(onSubmit).not.toHaveBeenCalled()
    r.stdin.write('第二行')
    r.stdin.write('\r')
    expect(onSubmit).toHaveBeenCalledWith('第一行\n第二行')
  })

  it('↑↓ 翻历史', async () => {
    const r = render(<InputBox onSubmit={noop} onInterrupt={noop} history={['旧命令A', '旧命令B']} busy={false} />)
    await delay()
    r.stdin.write('\x1b[A') // ↑
    expect(r.lastFrame()).toContain('旧命令B')
    r.stdin.write('\x1b[A')
    expect(r.lastFrame()).toContain('旧命令A')
    r.stdin.write('\x1b[B') // ↓
    expect(r.lastFrame()).toContain('旧命令B')
  })

  it('busy 时 Esc 触发 onInterrupt；空闲时 Esc 清空输入', async () => {
    const onInterrupt = vi.fn()
    const r = render(<InputBox onSubmit={noop} onInterrupt={onInterrupt} history={[]} busy={true} />)
    await delay()
    r.stdin.write('\x1b') // Esc
    expect(onInterrupt).toHaveBeenCalled()
    const r2 = render(<InputBox onSubmit={noop} onInterrupt={noop} history={[]} busy={false} />)
    await delay()
    r2.stdin.write('abc')
    r2.stdin.write('\x1b')
    expect(r2.lastFrame()).not.toContain('abc')
  })

  it('onChange 上报当前值（供补全菜单消费）', async () => {
    const onChange = vi.fn()
    const r = render(<InputBox onSubmit={noop} onInterrupt={noop} onChange={onChange} history={[]} busy={false} />)
    await delay()
    r.stdin.write('/mo')
    expect(onChange).toHaveBeenLastCalledWith('/mo')
  })
})
