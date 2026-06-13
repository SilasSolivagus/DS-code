// test/tui.app.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'

const script: Array<{ deltas?: any[]; result: any }> = []
vi.mock('../src/api.js', async orig => ({
  ...(await orig() as any),
  chatStream: vi.fn(() =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      for (const d of scene.deltas ?? []) yield typeof d === 'string' ? { type: 'text', delta: d } : d
      return scene.result
    })(),
  ),
}))

import React from 'react'
import { render } from 'ink-testing-library'
import { App } from '../src/tui/App.js'
import { runBang, expandAtRefs } from '../src/tui/useChat.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const usage = { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0 }
beforeEach(() => {
  script.length = 0
  vi.clearAllMocks()  // 重置 chatStream.mock.calls 计数
})

describe('runBang', () => {
  it('执行命令返回输出与退出码，超时/失败不抛', () => {
    const r = runBang('echo hi', '/tmp')
    expect(r.output).toContain('hi')
    expect(r.code).toBe(0)
    expect(runBang('exit 3', '/tmp').code).toBe(3)
  })
})

describe('expandAtRefs', () => {
  it('@路径 展开为文件内容块，缺失文件标注读取失败', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'at-'))
    writeFileSync(path.join(dir, 'x.ts'), 'export const x = 1')
    const out = expandAtRefs('看看 @x.ts 怎么写的', dir)
    expect(out).toContain('export const x = 1')
    expect(out).toContain('<file path=')
    expect(expandAtRefs('@不存在.ts', dir)).toContain('读取失败')
  })
})

describe('App 集成', () => {
  it('启动渲染 banner+输入框；输入一句话回车后出现回复与 usage 行', async () => {
    const sessionDir = mkdtempSync(path.join(tmpdir(), 'dc-app-test-'))
    script.push({ deltas: ['答'], result: { content: '答', toolCalls: [], usage, finishReason: 'stop' } })
    const r = render(<App client={{} as any} yolo={true} cwd={process.cwd()} sessionDir={sessionDir} />)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(r.lastFrame()).toContain('🐳')
    r.stdin.write('问')
    r.stdin.write('\r')
    await vi.waitFor(() => expect(r.lastFrame()).toContain('答'), { timeout: 5000 })
    expect(r.lastFrame()).toContain('缓存命中')
  })

  it('输入 "/" 浮出补全菜单', async () => {
    const sessionDir = mkdtempSync(path.join(tmpdir(), 'dc-app-test-'))
    const r = render(<App client={{} as any} yolo={true} cwd={process.cwd()} sessionDir={sessionDir} />)
    await new Promise(resolve => setTimeout(resolve, 0))
    r.stdin.write('/')
    expect(r.lastFrame()).toContain('/model')
  })

  it('"!ls" 直跑：结果以 bang 块呈现，不发 API 请求', async () => {
    const sessionDir = mkdtempSync(path.join(tmpdir(), 'dc-app-test-'))
    const r = render(<App client={{} as any} yolo={true} cwd={process.cwd()} sessionDir={sessionDir} />)
    await new Promise(resolve => setTimeout(resolve, 0))
    r.stdin.write('!echo bang测试')
    r.stdin.write('\r')
    await vi.waitFor(() => expect(r.lastFrame()).toContain('bang测试'), { timeout: 5000 })
    const { chatStream } = await import('../src/api.js') as any
    expect(chatStream.mock.calls.length).toBe(0)
  })
})
