// test/inputbox.steering.test.ts
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { InputBox } from '../src/tui/components/InputBox.js'

// ink 的 useInput 在 useEffect 中注册 stdin 监听器；需等一个微任务让 effect 跑完后才能写 stdin
const delay = (ms = 0) => new Promise(res => setTimeout(res, ms))

// 若仓库无 ink-testing-library，则跳过组件渲染测试、靠真机冒烟；此处给出标准用法。
describe('InputBox steering 按键', () => {
  it('busy 时普通 Enter 调 onSteer 而非 onSubmit', async () => {
    const onSteer = vi.fn(), onSubmit = vi.fn()
    const { stdin } = render(React.createElement(InputBox, {
      onSubmit, onInterrupt: () => {}, onSteer, onSteerPop: vi.fn(),
      steerQueueSize: 0, history: [], busy: true,
    }))
    await delay()
    stdin.write('hi')
    stdin.write('\r')              // Enter
    expect(onSteer).toHaveBeenCalledWith('hi')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('busy 时 Enter 输入为空不调 onSteer', async () => {
    const onSteer = vi.fn()
    const { stdin } = render(React.createElement(InputBox, {
      onSubmit: vi.fn(), onInterrupt: () => {}, onSteer, onSteerPop: vi.fn(),
      steerQueueSize: 0, history: [], busy: true,
    }))
    await delay()
    stdin.write('\r')              // Enter with no input
    expect(onSteer).not.toHaveBeenCalled()
  })

  it('steerQueueItems 非空时渲染排队预览文本', async () => {
    const { lastFrame } = render(React.createElement(InputBox, {
      onSubmit: vi.fn(), onInterrupt: () => {}, onSteer: vi.fn(), onSteerPop: vi.fn(),
      steerQueueSize: 1, history: [], busy: true,
      steerQueueItems: [{ value: '只看 src 目录就行', priority: 'next' }],
    }))
    await delay()
    expect(lastFrame()).toContain('⏵ 排队')
    expect(lastFrame()).toContain('只看 src 目录就行')
  })

  it('steerQueueItems 空时不渲染排队预览', async () => {
    const { lastFrame } = render(React.createElement(InputBox, {
      onSubmit: vi.fn(), onInterrupt: () => {}, onSteer: vi.fn(), onSteerPop: vi.fn(),
      steerQueueSize: 0, history: [], busy: true,
      steerQueueItems: [],
    }))
    await delay()
    expect(lastFrame()).not.toContain('⏵ 排队')
  })

  it('steerQueueItems 值超 60 字时截断并加省略号', async () => {
    const longText = 'A'.repeat(70)
    const { lastFrame } = render(React.createElement(InputBox, {
      onSubmit: vi.fn(), onInterrupt: () => {}, onSteer: vi.fn(), onSteerPop: vi.fn(),
      steerQueueSize: 1, history: [], busy: true,
      steerQueueItems: [{ value: longText }],
    }))
    await delay()
    expect(lastFrame()).toContain('⏵ 排队')
    expect(lastFrame()).toContain('…')
    expect(lastFrame()).not.toContain(longText)
  })

  it('busy 时 ESC 在队列非空时调 onSteerPop、空时调 onInterrupt', async () => {
    const onInterrupt = vi.fn(), onSteerPop = vi.fn()
    const r1 = render(React.createElement(InputBox, {
      onSubmit: vi.fn(), onInterrupt, onSteer: vi.fn(), onSteerPop,
      steerQueueSize: 2, history: [], busy: true,
    }))
    await delay()
    r1.stdin.write('\x1b')        // ESC
    expect(onSteerPop).toHaveBeenCalled()
    expect(onInterrupt).not.toHaveBeenCalled()

    const r2 = render(React.createElement(InputBox, {
      onSubmit: vi.fn(), onInterrupt, onSteer: vi.fn(), onSteerPop: vi.fn(),
      steerQueueSize: 0, history: [], busy: true,
    }))
    await delay()
    r2.stdin.write('\x1b')
    expect(onInterrupt).toHaveBeenCalled()
  })
})
