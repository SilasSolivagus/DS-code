// test/tui.planMode.test.ts
// Task 8 TUI 接线逻辑可单测部分：
//  1. additionalDirs 去重逻辑（纯函数模拟）
//  2. allowedPrompts → Bash 规则字符串生成（前缀机制）
//  3. PendingPlanApproval 类型形状验证（编译期 + 运行期）
//  4. /plan 命令交互（createChatCore 冒烟）
import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

// ─── provider 隔离 ────────────────────────────────────────────────────────────
vi.mock('../src/providers.js', async orig => {
  const actual = await orig() as any
  const deepseekPreset = actual.BUILTIN_PROVIDERS.deepseek
  return {
    ...actual,
    activeProvider: () => deepseekPreset,
    activeFastModel: () => 'deepseek-v4-flash',
    activeSmartModel: () => 'deepseek-v4-pro',
    belongsToProvider: (preset: any, modelId: string) => actual.belongsToProvider(deepseekPreset, modelId),
  }
})

// ─── API mock ─────────────────────────────────────────────────────────────────
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

import { createChatCore, type PendingPlanApproval } from '../src/tui/useChat.js'
import { matchRule } from '../src/permissions.js'
import type { AllowedPrompt } from '../src/tools/exitPlanMode.js'

const usage = { prompt_tokens: 50, completion_tokens: 20, prompt_cache_hit_tokens: 0 }

let sessionDir: string
let cwd: string
beforeEach(() => {
  script.length = 0
  vi.clearAllMocks()
  sessionDir = mkdtempSync(path.join(tmpdir(), 'deepcode-plan-test-'))
  cwd = sessionDir
})

// ─── 1. additionalDirs 去重 ───────────────────────────────────────────────────

describe('additionalDirs 去重逻辑', () => {
  it('同路径不重复添加（纯逻辑模拟）', () => {
    // 模拟 /add-dir 去重：additionalDirs.includes(resolved) 守卫
    const additionalDirs: string[] = []
    const add = (p: string) => {
      if (!additionalDirs.includes(p)) additionalDirs.push(p)
    }
    add('/workspace/a')
    add('/workspace/b')
    add('/workspace/a') // 重复
    expect(additionalDirs).toEqual(['/workspace/a', '/workspace/b'])
    expect(additionalDirs.length).toBe(2)
  })
})

// ─── 2. allowedPrompts → Bash 规则字符串 ────────────────────────────────────

describe('allowedPrompts → Bash 前缀规则', () => {
  it('Bash(<prompt>:*) 规则格式正确并能精确匹配', () => {
    // matchRule 前缀语义：normDesc === prefix 或 normDesc.startsWith(prefix + ' ')
    // prompt = 'run tests' → rule = 'Bash(run tests:*)' → 精确 'run tests' 或前缀 'run tests foo'
    const ap: AllowedPrompt = { tool: 'Bash', prompt: 'run tests' }
    const rule = `Bash(${ap.prompt}:*)`
    expect(rule).toBe('Bash(run tests:*)')
    expect(matchRule(rule, 'Bash', 'run tests')).toBe(true)          // 精确命中
    expect(matchRule(rule, 'Bash', 'run tests --coverage')).toBe(true) // 前缀命中（带空格）
    expect(matchRule(rule, 'Bash', 'other command')).toBe(false)       // 不命中
  })

  it('npm install 规则命中同前缀命令', () => {
    const ap: AllowedPrompt = { tool: 'Bash', prompt: 'npm install' }
    const rule = `Bash(${ap.prompt}:*)`
    expect(matchRule(rule, 'Bash', 'npm install')).toBe(true)
    expect(matchRule(rule, 'Bash', 'npm install --save-dev')).toBe(true)
    expect(matchRule(rule, 'Bash', 'npm run build')).toBe(false)
  })

  it('allowedPrompts 生成的规则字符串格式符合 matchRule 期望', () => {
    const allowedPrompts: AllowedPrompt[] = [
      { tool: 'Bash', prompt: 'npm test' },
      { tool: 'Bash', prompt: 'make build' },
    ]
    for (const ap of allowedPrompts) {
      const rule = `Bash(${ap.prompt}:*)`
      // 格式验证：Bash(xxx:*) 形式
      expect(rule).toMatch(/^Bash\(.+:\*\)$/)
      // 精确命中
      expect(matchRule(rule, 'Bash', ap.prompt)).toBe(true)
    }
  })
})

// ─── 3. PendingPlanApproval 类型形状 ─────────────────────────────────────────

describe('PendingPlanApproval 类型', () => {
  it('类型形状正确（编译期 + 运行期）', () => {
    let resolved: boolean | undefined
    const ppa: PendingPlanApproval = {
      plan: '## 计划\n1. Read\n2. Edit',
      allowedPrompts: [{ tool: 'Bash', prompt: 'npm test' }],
      resolve: (approved: boolean) => { resolved = approved },
    }
    ppa.resolve(true)
    expect(resolved).toBe(true)
    expect(ppa.plan).toContain('## 计划')
    expect(ppa.allowedPrompts?.[0].tool).toBe('Bash')
  })

  it('allowedPrompts 可选', () => {
    const ppa: PendingPlanApproval = {
      plan: 'simple plan',
      resolve: () => {},
    }
    expect(ppa.allowedPrompts).toBeUndefined()
  })
})

// ─── 4. /plan 命令冒烟（createChatCore）──────────────────────────────────────

describe('/plan 命令', () => {
  const makeCore = () => createChatCore({
    client: {} as any,
    yolo: false,
    cwd,
    sessionDir,
    onState: () => {},
  })

  it('/plan 进入 plan 模式 → permMode === plan', async () => {
    const core = makeCore()
    expect(core.state.permMode).toBe('default')
    await core.send('/plan')
    expect(core.state.permMode).toBe('plan')
    core.dispose()
  })

  it('/plan 再次执行退出 plan 模式 → permMode 回到之前', async () => {
    const core = makeCore()
    await core.send('/plan')
    expect(core.state.permMode).toBe('plan')
    await core.send('/plan')
    expect(core.state.permMode).toBe('default')
    core.dispose()
  })

  it('/plan 从 acceptEdits 进入后退出应恢复 acceptEdits', async () => {
    const core = makeCore()
    await core.send('/accept') // 进入 acceptEdits
    expect(core.state.permMode).toBe('acceptEdits')
    await core.send('/plan')   // 进入 plan（记住 acceptEdits）
    expect(core.state.permMode).toBe('plan')
    await core.send('/plan')   // 退出 plan → 恢复 acceptEdits
    expect(core.state.permMode).toBe('acceptEdits')
    core.dispose()
  })

  it('yolo 模式下 /plan 不切换并给提示', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd, sessionDir, onState: () => {} })
    expect(core.state.permMode).toBe('yolo')
    await core.send('/plan')
    expect(core.state.permMode).toBe('yolo') // 未切换
    core.dispose()
  })
})

// ─── 5. /add-dir 命令冒烟 ────────────────────────────────────────────────────

describe('/add-dir 命令', () => {
  const makeCore = () => createChatCore({
    client: {} as any,
    yolo: false,
    cwd,
    sessionDir,
    onState: () => {},
  })

  it('/add-dir 添加存在目录 → 不报错（notice info）', async () => {
    const core = makeCore()
    // cwd（sessionDir）本身是存在的目录
    await core.send(`/add-dir ${cwd}`)
    // 无法直接断言 notice，但不应抛异常，且 permMode 未变
    expect(core.state.permMode).toBe('default')
    core.dispose()
  })

  it('/add-dir 空参 → 打印当前目录列表（不报错）', async () => {
    const core = makeCore()
    await core.send('/add-dir')
    expect(core.state.permMode).toBe('default')
    core.dispose()
  })
})
