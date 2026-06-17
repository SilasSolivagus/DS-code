# L-040 B 用户自定义子代理（CC 生态兼容）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户/项目用 `.claude/agents/*.md`（CC 生态兼容）+ `.deepcode/agents/*.md`（原生）markdown 文件自定义专才子代理，无需改代码。

**Architecture:** 新模块 `src/agentsLoader.ts` 解析 CC frontmatter（用 `yaml` 包）→ `AgentDefinition`，扫四目录（builtin<user<project，同级 .deepcode>.claude）合并（custom 覆盖同名 builtin）。CC 生态兼容 = 容忍解析全 CC 键集，honor deepcode 支持的子集（name/description/tools/disallowedTools/model/body），其余进阶字段解析忽略（no-op，随子系统落地）。model 别名加载时映射到 deepcode 词汇（haiku→flash、sonnet/opus/claude-*→inherit）。接线把模块级 `BUILTIN_AGENTS` 硬引用改为「启动解析合并注册表贯穿传递」。

**Tech Stack:** TypeScript / ESM / yaml / vitest。

**Spec:** `docs/specs/2026-06-17-deepcode-l040b-custom-agents-design.md`。

**对齐源：** CC `loadAgentsDir.ts` + `markdownConfigLoader.ts`（实读报告存档）。

**不做（YAGNI）：** managed/policy 层、plugin agents、进阶字段落地（memory/isolation/mcpServers/hooks/skills/permissionMode/effort/background/initialPrompt——解析忽略不报错）、递归子目录、agent 管理 UI/color 渲染、安全边界改动（GLOBAL_SUBAGENT_DENY 仍兜底 Edit/Write/Agent）。非 TUI 纯逻辑免冒烟。

**测试基线命令：** 单测 `npm test -- <file>`；全量 `npm test`；类型 `npm run typecheck`；构建 `npm run build`。

---

### Task 1: `yaml` 依赖 + 纯解析函数

frontmatter / tools / model 别名解析（纯函数）。

**Files:**
- Modify: `package.json`（加 `yaml`）
- Create: `src/agentsLoader.ts`（本任务先放 3 个纯函数）
- Test: `test/agentsLoader.test.ts`

- [ ] **Step 1: 装 yaml**

Run: `npm install yaml`
Expected: `package.json` deps 出现 `"yaml"`，lockfile 更新。

- [ ] **Step 2: 写失败测试**

Create `test/agentsLoader.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { parseFrontmatter, parseToolList, resolveAgentModelAlias } from '../src/agentsLoader.js'

describe('parseFrontmatter', () => {
  it('提取 frontmatter + body', () => {
    const { data, body } = parseFrontmatter('---\nname: r\ndescription: d\n---\n正文内容')
    expect(data).toEqual({ name: 'r', description: 'd' })
    expect(body).toBe('正文内容')
  })
  it('YAML 数组', () => {
    const { data } = parseFrontmatter('---\ntools: [Read, Grep]\n---\nx')
    expect(data.tools).toEqual(['Read', 'Grep'])
  })
  it('无 frontmatter → data 空、body 原文', () => {
    expect(parseFrontmatter('就是正文')).toEqual({ data: {}, body: '就是正文' })
  })
  it('坏 YAML → data 空（容错）', () => {
    const { data } = parseFrontmatter('---\n: : bad\n  - [\n---\nb')
    expect(data).toEqual({})
  })
})

describe('parseToolList', () => {
  it('逗号串', () => { expect(parseToolList('Read, Grep, Bash')).toEqual(['Read', 'Grep', 'Bash']) })
  it('数组', () => { expect(parseToolList(['Read', 'Grep'])).toEqual(['Read', 'Grep']) })
  it('* → undefined（全部）', () => { expect(parseToolList('*')).toBeUndefined() })
  it('省略 → undefined（全部）', () => { expect(parseToolList(undefined)).toBeUndefined() })
  it('空串 → []（无工具）', () => { expect(parseToolList('')).toEqual([]) })
})

describe('resolveAgentModelAlias', () => {
  it('inherit', () => { expect(resolveAgentModelAlias('inherit')).toBe('inherit') })
  it('haiku → flash', () => { expect(resolveAgentModelAlias('haiku')).toBe('flash') })
  it('sonnet/opus → inherit', () => {
    expect(resolveAgentModelAlias('sonnet')).toBe('inherit')
    expect(resolveAgentModelAlias('Opus')).toBe('inherit')
  })
  it('未知 claude-* id → inherit 兜底', () => { expect(resolveAgentModelAlias('claude-opus-4-1')).toBe('inherit') })
  it('deepcode 原生透传', () => {
    expect(resolveAgentModelAlias('flash')).toBe('flash')
    expect(resolveAgentModelAlias('deepseek-v4-pro')).toBe('deepseek-v4-pro')
  })
  it('空/非字符串 → undefined', () => {
    expect(resolveAgentModelAlias('')).toBeUndefined()
    expect(resolveAgentModelAlias(undefined)).toBeUndefined()
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test -- test/agentsLoader.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现**

Create `src/agentsLoader.ts`（本任务仅这 3 个纯函数 + import；loadCustomAgents/mergeAgents/parseAgentFile 在 Task 2）：

```ts
// src/agentsLoader.ts —— L-040 B 用户自定义子代理加载（CC 生态兼容）。
// 解析 CC frontmatter（yaml）→ AgentDefinition，扫 .claude/agents + .deepcode/agents 合并。
import { parse as parseYaml } from 'yaml'

/** 切 frontmatter（`---\n…\n---`）+ body。无 frontmatter 或坏 YAML → data 空、body 原文（容错对齐 CC）。 */
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { data: {}, body: raw }
  let data: Record<string, unknown> = {}
  try {
    const parsed = parseYaml(m[1])
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>
  } catch { /* 坏 YAML → 空（容错） */ }
  return { data, body: raw.slice(m[0].length) }
}

/** tools/disallowedTools 解析（对齐 CC）：逗号串/YAML 数组；`*`→undefined(全部)；省略→undefined；空→[]。 */
export function parseToolList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  let arr: string[]
  if (typeof value === 'string') arr = value.split(',').map(s => s.trim()).filter(Boolean)
  else if (Array.isArray(value)) arr = value.filter((x): x is string => typeof x === 'string').flatMap(s => s.split(',')).map(s => s.trim()).filter(Boolean)
  else return undefined
  if (arr.includes('*')) return undefined
  return arr
}

/** CC Anthropic 模型档 → deepcode 词汇（inherit/flash/字面）。加载时归一，agent.ts model 解析零改。 */
export function resolveAgentModelAlias(model: unknown): string | undefined {
  if (typeof model !== 'string' || !model.trim()) return undefined
  const t = model.trim()
  const lower = t.toLowerCase()
  if (lower === 'inherit') return 'inherit'
  if (lower === 'haiku') return 'flash'                                    // 弱档 → deepcode cheap 档
  if (lower === 'sonnet' || lower === 'opus') return 'inherit'             // 强档 deepcode 无对应 → 落父模型
  if (lower.startsWith('claude-') || lower.startsWith('claude ')) return 'inherit' // 未知 Anthropic id → 兜底父模型
  return t                                                                 // flash / deepseek-… / 其它 deepcode 原生透传
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test -- test/agentsLoader.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add package.json package-lock.json src/agentsLoader.ts test/agentsLoader.test.ts
git commit -m "feat(agents): yaml 依赖 + frontmatter/tools/model 别名纯解析 (L-040 B)"
```

---

### Task 2: parseAgentFile + loadCustomAgents + mergeAgents + resolveAgents

单文件解析 + 四目录扫描合并。

**Files:**
- Modify: `src/agentsLoader.ts`（追加 4 个函数 + import）
- Test: `test/agentsLoader.test.ts`

- [ ] **Step 1: 写失败测试**

`test/agentsLoader.test.ts` 追加（顶部 import 加 `parseAgentFile, loadCustomAgents, mergeAgents, resolveAgents`；并 import node fs/os/path + `BUILTIN_AGENTS`）：

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseAgentFile, loadCustomAgents, mergeAgents, resolveAgents } from '../src/agentsLoader.js'
import { BUILTIN_AGENTS } from '../src/tools/agentTypes.js'

const CC_FILE = `---
name: code-reviewer
description: Review code for bugs\\nand style
tools: Read, Grep
model: sonnet
color: blue
memory: project
---
你是代码审查专家。给出 file:line + 严重度 + 修复。`

describe('parseAgentFile', () => {
  it('完整 CC 文件 → AgentDefinition（进阶字段忽略不崩）', () => {
    const def = parseAgentFile(CC_FILE)!
    expect(def.agentType).toBe('code-reviewer')
    expect(def.whenToUse).toBe('Review code for bugs\nand style') // \n 反转义
    expect(def.tools).toEqual(['Read', 'Grep'])
    expect(def.model).toBe('inherit') // sonnet 映射
    expect(def.getSystemPrompt()).toContain('代码审查专家')
  })
  it('缺 name → null（静默）', () => {
    expect(parseAgentFile('---\ndescription: d\n---\nx')).toBeNull()
  })
  it('缺 description → null', () => {
    expect(parseAgentFile('---\nname: r\n---\nx')).toBeNull()
  })
})

describe('loadCustomAgents 目录优先级', () => {
  function setup(): { home: string; cwd: string } {
    const home = mkdtempSync(path.join(tmpdir(), 'dc-home-'))
    const cwd = mkdtempSync(path.join(tmpdir(), 'dc-cwd-'))
    return { home, cwd }
  }
  const mk = (dir: string, file: string, content: string) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, file), content)
  }
  const agentFile = (name: string, prompt: string) => `---\nname: ${name}\ndescription: d\n---\n${prompt}`

  it('扫四目录、project>user、同级 .deepcode>.claude', () => {
    const { home, cwd } = setup()
    mk(path.join(home, '.claude', 'agents'), 'a.md', agentFile('shared', 'user-claude'))
    mk(path.join(home, '.deepcode', 'agents'), 'a.md', agentFile('shared', 'user-deepcode'))
    mk(path.join(cwd, '.claude', 'agents'), 'a.md', agentFile('shared', 'project-claude'))
    mk(path.join(cwd, '.deepcode', 'agents'), 'a.md', agentFile('shared', 'project-deepcode'))
    const list = loadCustomAgents(cwd, home)
    // mergeAgents 后同名 last-wins；loadCustomAgents 返回顺序：user.claude < user.deepcode < project.claude < project.deepcode
    const merged = mergeAgents([], list).find(a => a.agentType === 'shared')!
    expect(merged.getSystemPrompt()).toBe('project-deepcode') // 最高优先级赢
  })

  it('目录不存在 → 跳过不崩', () => {
    const { home, cwd } = setup()
    expect(loadCustomAgents(cwd, home)).toEqual([])
  })
})

describe('mergeAgents / resolveAgents', () => {
  it('custom 覆盖同名 builtin、新增', () => {
    const custom = [parseAgentFile(agentFileFor('general-purpose', 'overridden'))!, parseAgentFile(agentFileFor('my-new', 'x'))!]
    const merged = mergeAgents(BUILTIN_AGENTS, custom)
    expect(merged.find(a => a.agentType === 'general-purpose')!.getSystemPrompt()).toBe('overridden')
    expect(merged.find(a => a.agentType === 'my-new')).toBeTruthy()
    expect(merged.length).toBe(BUILTIN_AGENTS.length + 1) // 覆盖不增、新增+1
  })
  it('resolveAgents 空目录 → 仅 builtin', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dc-h-'))
    const cwd = mkdtempSync(path.join(tmpdir(), 'dc-c-'))
    expect(resolveAgents(cwd, home).length).toBe(BUILTIN_AGENTS.length)
  })
})

function agentFileFor(name: string, prompt: string): string {
  return `---\nname: ${name}\ndescription: d\n---\n${prompt}`
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- test/agentsLoader.test.ts`
Expected: FAIL（4 函数未定义）

- [ ] **Step 3: 实现**

`src/agentsLoader.ts` 顶部 import 加：

```ts
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { AgentDefinition } from './tools/agentTypes.js'
import { BUILTIN_AGENTS } from './tools/agentTypes.js'
```

追加 4 个函数：

```ts
/** 单 agent markdown → AgentDefinition。缺 name/description → null（对齐 CC：静默/记错跳过）。
 *  进阶字段（memory/isolation/mcpServers/hooks/skills/permissionMode/effort/background/initialPrompt/color）解析层忽略。 */
export function parseAgentFile(raw: string): AgentDefinition | null {
  const { data, body } = parseFrontmatter(raw)
  const name = data.name
  if (typeof name !== 'string' || !name.trim()) return null
  const description = data.description
  if (typeof description !== 'string' || !description.trim()) return null
  const systemPrompt = body.trim()
  return {
    agentType: name.trim(),
    whenToUse: description.replace(/\\n/g, '\n'), // 对齐 CC YAML \n 反转义
    tools: parseToolList(data.tools),
    disallowedTools: parseToolList(data.disallowedTools),
    model: resolveAgentModelAlias(data.model),
    getSystemPrompt: () => systemPrompt,
  }
}

/** 扫四目录（builtin<user<project，同级 .deepcode>.claude）的 *.md，解析成 AgentDefinition 列表（低→高优先序）。
 *  目录不存在/单文件坏 → 跳过（容错，对齐 loadCustomCommands）。home 可注入便于测。 */
export function loadCustomAgents(cwd: string, home: string = os.homedir()): AgentDefinition[] {
  const dirs = [
    path.join(home, '.claude', 'agents'),
    path.join(home, '.deepcode', 'agents'),
    path.join(cwd, '.claude', 'agents'),
    path.join(cwd, '.deepcode', 'agents'),
  ]
  const out: AgentDefinition[] = []
  for (const dir of dirs) {
    let files: string[] = []
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')) } catch { continue }
    for (const f of files) {
      try {
        const def = parseAgentFile(fs.readFileSync(path.join(dir, f), 'utf8'))
        if (def) out.push(def)
      } catch { /* 单文件坏跳过 */ }
    }
  }
  return out
}

/** builtin + custom 合并：Map<agentType> 按序 set，custom 覆盖同名 builtin（last-wins）。 */
export function mergeAgents(builtin: AgentDefinition[], custom: AgentDefinition[]): AgentDefinition[] {
  const m = new Map<string, AgentDefinition>()
  for (const a of [...builtin, ...custom]) m.set(a.agentType, a)
  return [...m.values()]
}

/** 启动时解析最终 agent 注册表（内建 + 自定义合并）。 */
export function resolveAgents(cwd: string, home?: string): AgentDefinition[] {
  return mergeAgents(BUILTIN_AGENTS, loadCustomAgents(cwd, home))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- test/agentsLoader.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: 干净（注意 agentsLoader→agentTypes 单向 import，无环）

- [ ] **Step 6: 提交**

```bash
git add src/agentsLoader.ts test/agentsLoader.test.ts
git commit -m "feat(agents): parseAgentFile + loadCustomAgents 四目录合并 (L-040 B)"
```

---

### Task 3: 接线 —— 注册表贯穿 makeAgentTool

把模块级 `BUILTIN_AGENTS` 硬引用改为「解析后注册表贯穿传递」。

**Files:**
- Modify: `src/tools/agentTypes.ts`（`buildAgentDescription` 参数化）
- Modify: `src/tools/agent.ts`（makeAgentTool deps.agents）
- Modify: `src/tui/useChat.ts` + `src/headless.ts`（resolveAgents 传入）
- Test: `test/agent.test.ts`、`test/agentTypes.test.ts`

- [ ] **Step 1: 写失败测试**

`test/agent.test.ts` 追加（验证经 deps.agents 路由到自定义 agent；脚本驱动夹具已在文件顶部）：

```ts
import { parseAgentFile } from '../src/agentsLoader.js'

describe('Agent 自定义 agent 路由 (L-040 B)', () => {
  it('deps.agents 含自定义 agent → 可路由', async () => {
    const custom = parseAgentFile('---\nname: my-reviewer\ndescription: 审查\ntools: Read\n---\n你是审查员')!
    script.push({ result: { content: '审查完毕', toolCalls: [], usage, finishReason: 'stop' } })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash', agents: [...require('../src/tools/agentTypes.js').BUILTIN_AGENTS, custom] })
    const out = await tool.call({ description: 't', prompt: 'x', subagent_type: 'my-reviewer' }, ctx())
    expect(out).toBe('审查完毕')
  })

  it('无 deps.agents → 退回 BUILTIN_AGENTS（零回归）', async () => {
    script.push({ result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' } })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: 't', prompt: 'x', subagent_type: 'general-purpose' }, ctx())
    expect(out).toBe('ok')
  })
})
```

> 若文件用 ESM import 风格（无 `require`），改用顶部 `import { BUILTIN_AGENTS } from '../src/tools/agentTypes.js'` 并 `agents: [...BUILTIN_AGENTS, custom]`。按文件既有风格调整。

`test/agentTypes.test.ts` 给 `buildAgentDescription` 补一例（传自定义 agents 列表 → 描述含其行）：

```ts
it('buildAgentDescription 接受 agents 参数，含自定义行', () => {
  const custom = { agentType: 'x-agent', whenToUse: '干 X', disallowedTools: ['Edit', 'Write', 'Agent'], getSystemPrompt: () => 'p' }
  const desc = buildAgentDescription([custom as any])
  expect(desc).toContain('x-agent: 干 X')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- test/agent.test.ts test/agentTypes.test.ts`
Expected: 新用例 FAIL（makeAgentTool 不认 agents / buildAgentDescription 不收参）

- [ ] **Step 3a: `buildAgentDescription` 参数化（`src/tools/agentTypes.ts`）**

```ts
/** 把 agents 列表拼成完整 Agent 工具 description（缺省内建，保后向兼容）。 */
export function buildAgentDescription(agents: AgentDefinition[] = BUILTIN_AGENTS): string {
  const lines = agents.map(formatAgentLine).join('\n')
  return `派出一个专才子代理执行任务。子代理看不到当前对话，prompt 必须自包含。返回子代理的最终结论。可用类型：
${lines}
省略 subagent_type 则用 general-purpose。`
}
```

- [ ] **Step 3b: makeAgentTool deps.agents（`src/tools/agent.ts`）**

`makeAgentTool` 的 deps 类型加 `agents?: AgentDefinition[]`（需 `import type { AgentDefinition }`，若未 import）。函数体内开头解析：

```ts
export function makeAgentTool(deps: { client: OpenAI; onUsage: (u: Usage, model: string) => void; getModel: () => string; agents?: AgentDefinition[] }): Tool<typeof schema> {
  const agents = deps.agents ?? BUILTIN_AGENTS
  const pool: Tool<any>[] = [...allTools, makeWebFetchTool({ client: deps.client, onUsage: deps.onUsage })]
  return {
    name: 'Agent',
    description: buildAgentDescription(agents),
    // ...
    async call(input, ctx) {
      const type = input.subagent_type ?? 'general-purpose'
      const def = agents.find(a => a.agentType === type)
      // ...（其余不变）
```

把原 `const def = BUILTIN_AGENTS.find(...)` 改为 `agents.find(...)`，`description: buildAgentDescription()` 改为 `buildAgentDescription(agents)`。`AgentDefinition` 从 agentTypes import（agent.ts 已 import 该模块的 BUILTIN_AGENTS 等）。

- [ ] **Step 3c: useChat / headless 传 agents**

先 `grep -rn "makeAgentTool(" src/` 确认所有调用点（预期 `src/tui/useChat.ts` + `src/headless.ts`）。

`src/tui/useChat.ts`：import 加 `import { resolveAgents } from '../agentsLoader.js'`；在 `const customCommands = loadCustomCommands(cwd)`（约 226 行）旁加 `const customAgents = resolveAgents(cwd)`；makeAgentTool 调用（约 361 行）加 `agents: customAgents`。

`src/headless.ts`：import 加 `import { resolveAgents } from './agentsLoader.js'`；makeAgentTool 调用（约 89 行）前用 `cwd` 算 `const agents = resolveAgents(cwd)`，调用加 `agents`。

> 注：注册表在启动以初始 cwd 解析一次（对齐 loadCustomCommands 行为）；会话中途 /cd 不刷新（可接受，记为已知）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- test/agent.test.ts test/agentTypes.test.ts`
Expected: PASS（含原有用例无回归）

- [ ] **Step 5: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: 干净

- [ ] **Step 6: 提交**

```bash
git add src/tools/agentTypes.ts src/tools/agent.ts src/tui/useChat.ts src/headless.ts test/agent.test.ts test/agentTypes.test.ts
git commit -m "feat(agents): 自定义 agent 注册表贯穿 makeAgentTool (L-040 B)"
```

---

### Task 4: 全量闸门 + opus 终审 + 合并

**Files:** 无新增

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全绿（543 基线 + 本件新增）。注意：偶发 EPIPE/SessionStart 是预存 flaky（vitest exit 0、不计失败），非本件回归——确认测试文件全 passed 即可。

- [ ] **Step 2: 类型 + 构建**

Run: `npm run typecheck && npm run build`
Expected: 干净

- [ ] **Step 3: opus 全量终审**

派 opus 子代理审整个 L-040 B change set。重点：① CC 生态兼容（frontmatter 键集/目录/优先级/model 别名/tools 解析对齐 CC，进阶字段忽略不崩）；② 目录优先级正确（project>user、同级 .deepcode>.claude、custom 覆盖 builtin）；③ 接线零回归（无 deps.agents 退回 BUILTIN_AGENTS）；④ 无循环依赖（agentsLoader→agentTypes 单向）；⑤ 安全边界不变（GLOBAL_SUBAGENT_DENY 兜底，自定义 agent 写 Write 也解析不到）；⑥ model 别名映射不把坏 Anthropic id 喂 DeepSeek API。

- [ ] **Step 4: `finishing-a-development-branch` 合 main**

合 main（no-ff）→ push origin。

---

## Self-Review

**1. Spec coverage：** yaml 依赖(T1)；parseFrontmatter/parseToolList/resolveAgentModelAlias(T1)；parseAgentFile/loadCustomAgents/mergeAgents/resolveAgents(T2)；四目录优先级 + project>user + 同级 .deepcode>.claude(T2)；CC frontmatter 键集 honor 子集 + 进阶字段忽略(T2 parseAgentFile)；model 别名映射(T1)；接线注册表贯穿 + 零回归(T3)；闸门 + opus 终审 + 合并(T4)。YAGNI 边界（managed/plugin/进阶落地/递归/UI）在 spec/plan 头声明。✅

**2. Placeholder scan：** 各步含完整代码。T3 测试的 require/import 风格留「按文件既有风格调整」是适配既有测试的必要留白，非占位。

**3. Type consistency：**
- `AgentDefinition`（agentTypes.ts 现有，L-044 已加 outputSchema?）被 agentsLoader 产出，自定义 agent 不设 outputSchema（undefined，合法）。
- `parseToolList(): string[] | undefined`、`resolveAgentModelAlias(): string | undefined`、`parseAgentFile(): AgentDefinition | null`、`loadCustomAgents(cwd, home?)`、`mergeAgents(builtin, custom)`、`resolveAgents(cwd, home?)` 签名 T1/T2 定义、T2/T3 一致消费。
- `buildAgentDescription(agents = BUILTIN_AGENTS)`（T3）默认参数保后向兼容；`makeAgentTool` deps.agents 缺省 BUILTIN_AGENTS。
