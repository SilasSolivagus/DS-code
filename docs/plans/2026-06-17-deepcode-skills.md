# deepcode Skills（技能）机制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 deepcode 支持 CC 式 skills——从目录发现带 frontmatter 的 SKILL.md，注入 skill 清单到 system prompt，模型经单个 `Skill` 工具调用、用户也能敲 `/<skill>`，调用后 inline（正文以 user 消息注入对话）或 forked（子代理跑）执行；统一现有 `/cmd` 为 legacy user-only skill。

**Architecture:** 新建 `skillsLoader.ts`（发现/解析/合并）、`subagentRunner.ts`（从 agent.ts 抽取的共享子代理运行器 + 单例并发信号量）、`tools/skill.ts`（单 Skill 工具）。inline 走 `ToolContext.injectUserMessage` + loop 在 tool_result 回灌后 flush 成 user 消息（不开任何信任边界例外，对齐 CC meta-user-message）。forked 复用 `runSubagent`。清单注入 `buildSystemPrompt`（会话启动静态，保 KV 缓存）。

**Tech Stack:** TypeScript/ESM、zod、yaml（已依赖）、vitest。

## Global Constraints

- 语言/模块：TypeScript ESM，import 路径带 `.js` 后缀。
- 注释/文案：中文，匹配现有风格。
- 合并前全量 `npm test` + `npm run typecheck` + `npm run build` 全绿。
- 测试命令：单文件 `npx vitest run test/<file>.test.ts`；全量 `npm test`；类型 `npm run typecheck`；构建 `npm run build`。
- 信号量单例铁律：`acquire`/`release`/`active`/`waiters`/`MAX_ACTIVE` 只能存在于 `subagentRunner.ts` 一处；agent.ts 与 skill.ts 都从那里 import，**绝不复制**（复制 = 4 并发上限静默变 8）。
- 安全：inline 不开信任例外（prompt.ts 现有「工具结果非指令」守则原封不动）；forked 子代理沿用 `subagentPermissionDecision` + `GLOBAL_SUBAGENT_DENY`，skill `allowedTools` 只能收窄不能提权。
- model 别名：复用 `resolveAgentModelAlias`，绝不把跑不了的外部 id 喂 API。

---

## Task 1: 抽取 `subagentRunner.ts`（共享子代理运行器 + 单例信号量）

**Files:**
- Create: `src/subagentRunner.ts`
- Modify: `src/tools/agent.ts`（删本地信号量 + runSub 闭包，改 import）
- Test: `test/subagentRunner.test.ts`（新）；回归门 `test/agent.test.ts`

**Interfaces:**
- Produces:
  - `acquire(): Promise<void>`、`release(): void`（模块级单例信号量，MAX_ACTIVE=4）
  - `interface RunSubagentOpts { client: OpenAI; onUsage: (u: Usage, model: string) => void; systemPrompt: string; userPrompt: string; tools: Tool<any>[]; model: string; outputSchema?: z.ZodTypeAny; ctx: ToolContext; signal: AbortSignal; agentId: string; agentType: string }`
  - `runSubagent(opts: RunSubagentOpts): Promise<string | undefined>`
- Consumes: 现有 `runLoop`、`makeStructuredOutputTool`/`structuredOutputReminder`/`MAX_STRUCTURED_OUTPUT_RETRIES`、`subagentPermissionDecision`。

- [ ] **Step 1: 写信号量单例回归测试（先失败）**

`test/subagentRunner.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import { acquire, release } from '../src/subagentRunner.js'

describe('subagentRunner 信号量', () => {
  it('并发上限 4：第 5 个 acquire 阻塞直到 release', async () => {
    for (let i = 0; i < 4; i++) await acquire() // 占满 4 个许可
    let fifthGranted = false
    const fifth = acquire().then(() => { fifthGranted = true })
    await new Promise(r => setTimeout(r, 10))
    expect(fifthGranted).toBe(false) // 第 5 个仍在等
    release()                        // 释放一个许可
    await fifth
    expect(fifthGranted).toBe(true)  // 第 5 个拿到
    for (let i = 0; i < 4; i++) release() // 收尾归还（4 占用 -1 释放 +1 第五占用 = 净占用 4）
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/subagentRunner.test.ts`
Expected: FAIL（`src/subagentRunner.js` 不存在）

- [ ] **Step 3: 新建 `src/subagentRunner.ts`（搬运信号量 + runSub）**

把 `agent.ts` 现有 `MAX_ACTIVE`/`active`/`waiters`/`acquire`/`release`（agent.ts:30-42）与 runSub 函数体（agent.ts:67-137）搬到此，闭包捕获改显式参数：
```ts
// src/subagentRunner.ts —— Agent 工具与 forked skill 共用的子代理运行器 + 单例并发信号量。
// 铁律：信号量只此一份，外部都 import 这里（复制 = 4 并发上限静默翻倍）。
import type OpenAI from 'openai'
import type { z } from 'zod'
import type { Tool, ToolContext } from './tools/types.js'
import type { Usage } from './api.js'
import { runLoop } from './loop.js'
import { makeStructuredOutputTool, structuredOutputReminder, MAX_STRUCTURED_OUTPUT_RETRIES } from './tools/structuredOutput.js'
import { subagentPermissionDecision } from './tools/agent.js'

const MAX_ACTIVE = 4
let active = 0
const waiters: Array<() => void> = []
export async function acquire(): Promise<void> {
  if (active < MAX_ACTIVE) { active++; return }
  await new Promise<void>(r => waiters.push(r))
}
export function release(): void {
  const next = waiters.shift()
  if (next) next()
  else active--
}

export interface RunSubagentOpts {
  client: OpenAI
  onUsage: (u: Usage, model: string) => void
  systemPrompt: string
  userPrompt: string
  tools: Tool<any>[]
  model: string
  outputSchema?: z.ZodTypeAny
  ctx: ToolContext
  signal: AbortSignal
  agentId: string
  agentType: string
}

/** 跑子代理子循环，返回最后一条 assistant 文本或结构化 JSON。SubagentStart/Stop hook + L-044 结构化输出。
 *  acquire/release 由调用方在外层管（agent.ts 前后台、skill.ts forked），本函数不碰信号量。 */
export async function runSubagent(opts: RunSubagentOpts): Promise<string | undefined> {
  const { ctx, signal, agentId, agentType: type } = opts
  const messages: any[] = [
    { role: 'system', content: opts.systemPrompt },
    { role: 'user', content: opts.userPrompt },
  ]
  if (ctx.hookDispatch) {
    const startOut = await ctx.hookDispatch('SubagentStart', {
      hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: type, cwd: ctx.cwd(),
    })
    if (startOut.additionalContext) {
      messages.push({ role: 'user', content: `<hook-context>\n${startOut.additionalContext}\n</hook-context>` })
    }
  }
  const subCtx: ToolContext = {
    cwd: ctx.cwd,
    setCwd: () => { /* 子代理只读，不许漂移主 cwd */ },
    get signal() { return signal },
    fileState: new Map(),
    isSubagent: true,
  }
  let subStopFired = false
  let captured: unknown
  let structuredRetries = 0
  const subTools = opts.outputSchema
    ? [...opts.tools, makeStructuredOutputTool(opts.outputSchema, v => { captured = v })]
    : opts.tools
  while (true) {
    const gen = runLoop(messages, {
      client: opts.client,
      tools: subTools,
      model: opts.model,
      thinking: false,
      permission: { mode: 'default', rules: [], saveRule: () => {}, ask: async (_n, desc) => subagentPermissionDecision(desc) },
      ctx: subCtx,
      maxTurns: 30,
    })
    let step
    while (!(step = await gen.next()).done) {
      if (step.value.type === 'turn_end') opts.onUsage(step.value.usage, opts.model)
    }
    const final = [...messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content)
    if (opts.outputSchema && captured === undefined) {
      if (structuredRetries < MAX_STRUCTURED_OUTPUT_RETRIES) {
        structuredRetries++
        messages.push({ role: 'user', content: structuredOutputReminder() })
        continue
      }
    }
    const result = captured !== undefined ? JSON.stringify(captured) : final?.content
    if (ctx.hookDispatch && !signal.aborted) {
      const stopOut = await ctx.hookDispatch('SubagentStop', {
        hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: type, cwd: ctx.cwd(),
        stop_hook_active: subStopFired,
        last_assistant_message: final?.content ?? '',
      })
      if (stopOut.stop) return result
      if (stopOut.preventContinuation && !subStopFired) {
        subStopFired = true
        messages.push({ role: 'user', content: stopOut.blockReason ?? '（SubagentStop 要求继续未尽事项）' })
        continue
      }
    }
    return result
  }
}
```

- [ ] **Step 4: 改 `src/tools/agent.ts` 用共享 runner**

删掉 agent.ts 的本地 `MAX_ACTIVE`/`active`/`waiters`/`acquire`/`release`（:30-42）和 `runSub` 闭包（:65-137）。`subagentPermissionDecision`（:18-21）**保留在 agent.ts 导出**（subagentRunner 反向 import 它，避免循环：subagentRunner→agent 只取这一个纯函数；agent→subagentRunner 取 runner/信号量）。改 import 与调用：
```ts
import { acquire, release, runSubagent } from '../subagentRunner.js'
```
`makeAgentTool` 内 `call`：保留 def 查找、`resolveAgentTools`、subModel 计算；把原 `runSub(signal, id)` 调用替换为 `runSubagent({...})`。后台路径（原 :140-173）与前台路径（原 :175-184）的 `acquire()`/`release()` 不变（仍 import 自 subagentRunner），把内部对 `runSub(ac.signal, id)` / `runSub(ctx.signal, ...)` 改为：
```ts
const final = await runSubagent({
  client: deps.client, onUsage: deps.onUsage,
  systemPrompt: def.getSystemPrompt(), userPrompt: input.prompt,
  tools, model: subModel, outputSchema: def.outputSchema,
  ctx, signal: ac.signal /* 或 ctx.signal */, agentId: id, agentType: type,
})
```
（后台用 `ac.signal` + `id`；前台用 `ctx.signal` + `generateTaskId('local_agent')`。）

- [ ] **Step 5: 跑回归 + 新测试确认通过**

Run: `npx vitest run test/agent.test.ts test/subagentRunner.test.ts`
Expected: PASS（agent 现有测试零回归 = 抽取正确；信号量单例测试通过）

- [ ] **Step 6: typecheck + 提交**

Run: `npm run typecheck`
```bash
git add src/subagentRunner.ts src/tools/agent.ts test/subagentRunner.test.ts
git commit -m "refactor: 抽取 subagentRunner（共享子代理运行器+单例信号量），agent.ts 复用"
```

---

## Task 2: `skillsLoader.ts` — `SkillDefinition` + 解析 + 发现

**Files:**
- Create: `src/skillsLoader.ts`
- Test: `test/skillsLoader.test.ts`（新）

**Interfaces:**
- Produces:
  - `interface SkillDefinition { name; description; whenToUse?; context: 'inline'|'fork'; agent?; allowedTools?; model?; userInvocable; modelInvocable; argNames?; skillDir; isLegacy; body }`
  - `parseSkillFile(raw: string, skillDir: string, fallbackName: string, isLegacy?: boolean): SkillDefinition | null`
  - `loadSkills(cwd: string, home?: string): SkillDefinition[]`
- Consumes: agentsLoader 的 `parseFrontmatter`、`parseToolList`、`resolveAgentModelAlias`。

- [ ] **Step 1: 写解析测试（先失败）**

`test/skillsLoader.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import { parseSkillFile } from '../src/skillsLoader.js'

describe('parseSkillFile', () => {
  it('解析 frontmatter 全字段', () => {
    const raw = `---
name: review-pr
description: 审查 PR
when-to-use: 用户要审查代码改动时
context: fork
agent: general-purpose
allowed-tools: Read, Grep
arguments: target
disable-model-invocation: false
---
请审查 $ARG1 的改动。`
    const s = parseSkillFile(raw, '/skills/review-pr', 'review-pr')!
    expect(s.name).toBe('review-pr')
    expect(s.description).toBe('审查 PR')
    expect(s.whenToUse).toBe('用户要审查代码改动时')
    expect(s.context).toBe('fork')
    expect(s.agent).toBe('general-purpose')
    expect(s.allowedTools).toEqual(['Read', 'Grep'])
    expect(s.argNames).toEqual(['target'])
    expect(s.userInvocable).toBe(true)
    expect(s.modelInvocable).toBe(true)
    expect(s.isLegacy).toBe(false)
    expect(s.body).toBe('请审查 $ARG1 的改动。')
  })

  it('默认值：无 frontmatter context→inline，可见性双开，name 取 fallback，description 取正文首非空行', () => {
    const s = parseSkillFile('\n做一件事\n更多内容', '/skills/x', 'do-thing')!
    expect(s.name).toBe('do-thing')
    expect(s.description).toBe('做一件事')
    expect(s.context).toBe('inline')
    expect(s.userInvocable).toBe(true)
    expect(s.modelInvocable).toBe(true)
  })

  it('可见性字段：user-invocable:false 关用户路径；disable-model-invocation:true 关模型路径', () => {
    const raw = `---
description: x
user-invocable: false
disable-model-invocation: true
---
body`
    const s = parseSkillFile(raw, '/d', 'x')!
    expect(s.userInvocable).toBe(false)
    expect(s.modelInvocable).toBe(false)
  })

  it('legacy 命令：isLegacy=true → user-only, inline, body=全文', () => {
    const s = parseSkillFile('回顾 $ARGUMENTS', '/cmds', 'recap', true)!
    expect(s.isLegacy).toBe(true)
    expect(s.userInvocable).toBe(true)
    expect(s.modelInvocable).toBe(false)
    expect(s.context).toBe('inline')
    expect(s.body).toBe('回顾 $ARGUMENTS')
  })

  it('正文为空 → null（无内容的 skill 无意义）', () => {
    expect(parseSkillFile('---\ndescription: x\n---\n', '/d', 'x')).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/skillsLoader.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写 `src/skillsLoader.ts` 解析部分**

```ts
// src/skillsLoader.ts —— CC 式 skills 发现/解析（复用 agentsLoader 的 frontmatter/工具/模型解析）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parseFrontmatter, parseToolList, resolveAgentModelAlias } from './agentsLoader.js'

export interface SkillDefinition {
  name: string
  description: string
  whenToUse?: string
  context: 'inline' | 'fork'
  agent?: string
  allowedTools?: string[]
  model?: string
  userInvocable: boolean
  modelInvocable: boolean
  argNames?: string[]
  skillDir: string
  isLegacy: boolean
  body: string
}

const firstNonEmptyLine = (s: string): string =>
  s.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''

/** 单 skill 文本 → SkillDefinition。正文空 → null。legacy（commands/）：无 frontmatter、user-only、inline、body=全文。 */
export function parseSkillFile(raw: string, skillDir: string, fallbackName: string, isLegacy = false): SkillDefinition | null {
  if (isLegacy) {
    const body = raw.trim()
    if (!body) return null
    return {
      name: fallbackName, description: firstNonEmptyLine(body) || fallbackName,
      context: 'inline', userInvocable: true, modelInvocable: false,
      skillDir, isLegacy: true, body,
    }
  }
  const { data, body: rawBody } = parseFrontmatter(raw)
  const body = rawBody.trim()
  if (!body) return null
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : fallbackName
  const description = typeof data.description === 'string' && data.description.trim()
    ? data.description.trim() : firstNonEmptyLine(body)
  const isFalse = (v: unknown) => v === false || v === 'false'
  const isTrue = (v: unknown) => v === true || v === 'true'
  return {
    name,
    description,
    whenToUse: typeof data['when-to-use'] === 'string' ? (data['when-to-use'] as string).replace(/\\n/g, '\n') : undefined,
    context: data.context === 'fork' ? 'fork' : 'inline',
    agent: typeof data.agent === 'string' ? data.agent.trim() : undefined,
    allowedTools: parseToolList(data['allowed-tools']),
    model: resolveAgentModelAlias(data.model),
    userInvocable: !isFalse(data['user-invocable']),
    modelInvocable: !isTrue(data['disable-model-invocation']),
    argNames: parseToolList(data.arguments),
    skillDir,
    isLegacy: false,
    body,
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/skillsLoader.test.ts`
Expected: PASS

- [ ] **Step 5: 写发现测试（先失败）**

追加到 `test/skillsLoader.test.ts`：
```ts
import { loadSkills } from '../src/skillsLoader.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('loadSkills 发现 + 合并', () => {
  it('扫 skills 目录 + legacy commands；同名 skill 覆盖 legacy；缺目录跳过', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-home-'))
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-cwd-'))
    // 一个项目级 skill 目录
    fs.mkdirSync(path.join(cwd, '.deepcode', 'skills', 'greet'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.deepcode', 'skills', 'greet', 'SKILL.md'), '---\ndescription: 打招呼\n---\n说你好')
    // 一个 legacy 命令同名 greet（应被 skill 覆盖）+ 一个独有 legacy recap
    fs.mkdirSync(path.join(cwd, '.deepcode', 'commands'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.deepcode', 'commands', 'greet.md'), '旧打招呼')
    fs.writeFileSync(path.join(cwd, '.deepcode', 'commands', 'recap.md'), '回顾 $ARGUMENTS')

    const skills = loadSkills(cwd, home)
    const byName = Object.fromEntries(skills.map(s => [s.name, s]))
    expect(byName['greet'].isLegacy).toBe(false)     // skill 覆盖了 legacy
    expect(byName['greet'].body).toBe('说你好')
    expect(byName['recap'].isLegacy).toBe(true)      // 独有 legacy 保留
  })
})
```

- [ ] **Step 6: 跑测试确认失败**

Run: `npx vitest run test/skillsLoader.test.ts`
Expected: FAIL（`loadSkills` 未定义）

- [ ] **Step 7: 实现 `loadSkills`**

追加到 `src/skillsLoader.ts`：
```ts
function loadSkillsFromDir(dir: string): SkillDefinition[] {
  let names: string[] = []
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) } catch { return [] }
  const out: SkillDefinition[] = []
  for (const name of names) {
    const file = path.join(dir, name, 'SKILL.md')
    try {
      const def = parseSkillFile(fs.readFileSync(file, 'utf8'), path.join(dir, name), name, false)
      if (def) out.push(def)
    } catch { /* 缺 SKILL.md / 坏文件跳过 */ }
  }
  return out
}

function loadLegacyFromDir(dir: string): SkillDefinition[] {
  let files: string[] = []
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')) } catch { return [] }
  const out: SkillDefinition[] = []
  for (const f of files) {
    try {
      const def = parseSkillFile(fs.readFileSync(path.join(dir, f), 'utf8'), dir, path.basename(f, '.md'), true)
      if (def) out.push(def)
    } catch { /* 单文件坏跳过 */ }
  }
  return out
}

/** 发现序低→高优先（last-wins）：legacy commands < skills；home < project；.claude < .deepcode。 */
export function loadSkills(cwd: string, home: string = os.homedir()): SkillDefinition[] {
  const ordered: SkillDefinition[] = [
    ...loadLegacyFromDir(path.join(home, '.deepcode', 'commands')),
    ...loadLegacyFromDir(path.join(cwd, '.deepcode', 'commands')),
    ...loadSkillsFromDir(path.join(home, '.claude', 'skills')),
    ...loadSkillsFromDir(path.join(home, '.deepcode', 'skills')),
    ...loadSkillsFromDir(path.join(cwd, '.claude', 'skills')),
    ...loadSkillsFromDir(path.join(cwd, '.deepcode', 'skills')),
  ]
  const m = new Map<string, SkillDefinition>()
  for (const s of ordered) m.set(s.name, s) // last-wins
  return [...m.values()]
}
```

- [ ] **Step 8: 跑测试 + typecheck + 提交**

Run: `npx vitest run test/skillsLoader.test.ts && npm run typecheck`
Expected: PASS
```bash
git add src/skillsLoader.ts test/skillsLoader.test.ts
git commit -m "feat(skills): skillsLoader 解析 SKILL.md frontmatter + 四目录发现 + legacy commands 兼容"
```

---

## Task 3: `substituteSkillArgs` 参数替换

**Files:**
- Modify: `src/skillsLoader.ts`（追加导出纯函数）
- Test: `test/skillsLoader.test.ts`（追加）

**Interfaces:**
- Produces: `substituteSkillArgs(body: string, args: string, opts: { argNames?: string[]; skillDir: string; sessionId?: string }): string`
- Consumes: 无。

- [ ] **Step 1: 写测试（先失败）**

追加到 `test/skillsLoader.test.ts`：
```ts
import { substituteSkillArgs } from '../src/skillsLoader.js'

describe('substituteSkillArgs', () => {
  it('$ARGUMENTS 全文替换（legacy 向后兼容）', () => {
    expect(substituteSkillArgs('回顾 $ARGUMENTS', 'a b c', { skillDir: '/d' })).toBe('回顾 a b c')
  })
  it('$ARG1/$ARG2 按空白切分', () => {
    expect(substituteSkillArgs('$ARG1 then $ARG2', 'foo bar', { skillDir: '/d' })).toBe('foo then bar')
  })
  it('${DEEPCODE_SKILL_DIR} / ${DEEPCODE_SESSION_ID}', () => {
    expect(substituteSkillArgs('dir=${DEEPCODE_SKILL_DIR} sid=${DEEPCODE_SESSION_ID}', '', { skillDir: '/skills/x', sessionId: 'sess1' }))
      .toBe('dir=/skills/x sid=sess1')
  })
  it('缺参数的 $ARGn 替换成空串；无 sessionId → 空串', () => {
    expect(substituteSkillArgs('[$ARG1][$ARG2]', 'only', { skillDir: '/d' })).toBe('[only][]')
    expect(substituteSkillArgs('${DEEPCODE_SESSION_ID}', '', { skillDir: '/d' })).toBe('')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/skillsLoader.test.ts`
Expected: FAIL（`substituteSkillArgs` 未定义）

- [ ] **Step 3: 实现**

追加到 `src/skillsLoader.ts`：
```ts
/** skill 正文参数替换：$ARGUMENTS（全文）/ $ARG1.. （空白切分段）/ ${DEEPCODE_SKILL_DIR} / ${DEEPCODE_SESSION_ID}。 */
export function substituteSkillArgs(
  body: string,
  args: string,
  opts: { argNames?: string[]; skillDir: string; sessionId?: string },
): string {
  const parts = args.trim() ? args.trim().split(/\s+/) : []
  let out = body
    .replaceAll('${DEEPCODE_SKILL_DIR}', opts.skillDir)
    .replaceAll('${DEEPCODE_SESSION_ID}', opts.sessionId ?? '')
  out = out.replace(/\$ARG(\d+)/g, (_m, n) => parts[Number(n) - 1] ?? '')
  out = out.replaceAll('$ARGUMENTS', args)
  return out
}
```
（注意顺序：先 `$ARGn` 再 `$ARGUMENTS`，避免 `$ARGUMENTS` 的 `$ARG` 被数字正则误吞——正则要求 `$ARG` 后紧跟数字，`$ARGUMENTS` 的 `U` 不匹配，故安全；先做不影响。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/skillsLoader.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck + 提交**

Run: `npm run typecheck`
```bash
git add src/skillsLoader.ts test/skillsLoader.test.ts
git commit -m "feat(skills): substituteSkillArgs 参数/变量替换（\$ARGUMENTS/\$ARGn/SKILL_DIR/SESSION_ID）"
```

---

## Task 4: `ToolContext.injectUserMessage` + loop `drainInjections` flush

**Files:**
- Modify: `src/tools/types.ts`（ToolContext 加字段）
- Modify: `src/loop.ts`（LoopDeps 加 `drainInjections` + 回灌后 flush）
- Test: `test/loop.test.ts`（追加）

**Interfaces:**
- Produces:
  - `ToolContext.injectUserMessage?: (content: string) => void`
  - `LoopDeps.drainInjections?: () => string[]`
- Consumes: 无（caller 在 Task 7/8 把两者接到同一 buffer）。

- [ ] **Step 1: 写 loop 注入测试（先失败）**

先看 `test/loop.test.ts` 现有 helper 风格（mock client/tool），追加：
```ts
// 一个调用 ctx.injectUserMessage 的假工具，验证 loop 在 tool_result 回灌后追加 user 消息
it('drainInjections：工具经 injectUserMessage 注入的内容在 tool 结果后作为 user 消息入队', async () => {
  const buffer: string[] = []
  const ctx = makeCtx() // 现有 helper；补 injectUserMessage
  ctx.injectUserMessage = (c: string) => buffer.push(c)
  const injectTool = {
    name: 'Inject', description: '', inputSchema: z.object({}), isReadOnly: true,
    needsPermission: () => false as const,
    call: async (_i: any, c: any) => { c.injectUserMessage('注入的指令'); return '已激活' },
  }
  // mock client：第一轮调用 Inject，第二轮无工具结束
  const client = mockClientSequence([
    { toolCalls: [{ id: 't1', name: 'Inject', args: '{}' }] },
    { toolCalls: [] },
  ])
  const messages: any[] = [{ role: 'user', content: 'go' }]
  const gen = runLoop(messages, {
    client, tools: [injectTool], model: 'm', thinking: false,
    permission: { mode: 'yolo', rules: [], saveRule: () => {}, ask: async () => 'yes' },
    ctx, drainInjections: () => buffer.splice(0),
  })
  while (!(await gen.next()).done) {}
  // tool 结果后应有一条 user 消息 = 注入内容
  const toolIdx = messages.findIndex(m => m.role === 'tool')
  expect(messages[toolIdx].content).toBe('已激活')
  expect(messages[toolIdx + 1]).toEqual({ role: 'user', content: '注入的指令' })
})
```
（若 `test/loop.test.ts` 无 `makeCtx`/`mockClientSequence` helper，按该文件现有 mock 模式实现等价物——参考文件顶部既有工具/客户端 mock。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/loop.test.ts`
Expected: FAIL（`injectUserMessage` 未定义 / 注入消息未出现）

- [ ] **Step 3: types.ts 加字段**

`src/tools/types.ts` 的 `ToolContext` 末尾加：
```ts
  /** inline skill 注入：工具调用时把内容排进待注入队列，loop 在本轮 tool 结果回灌后作为 user 消息 flush。
   *  主会话/headless 顶层 ctx 注入；子代理子 ctx 不注入（forked skill 不嵌套注入）。 */
  injectUserMessage?: (content: string) => void
```

- [ ] **Step 4: loop.ts 加 drainInjections + flush**

`LoopDeps`（loop.ts:38 后）加：
```ts
  /** inline skill 注入队列 drain：每轮 tool 结果回灌后调用，返回的内容各作 user 消息追加。
   *  与 ctx.injectUserMessage 接同一 buffer（caller 在 useChat/headless 接线）。 */
  drainInjections?: () => string[]
```
在 loop.ts 工具结果回灌 + system-reminder 之后、`yield { type: 'turn_end' }`（:264）之前插入：
```ts
    // inline skill：把工具经 injectUserMessage 排入的内容作为 user 消息追加（在 tool 结果之后，下一轮模型可见）
    for (const inj of deps.drainInjections?.() ?? []) {
      messages.push({ role: 'user', content: inj })
    }
```

- [ ] **Step 5: 跑测试确认通过 + 回归**

Run: `npx vitest run test/loop.test.ts`
Expected: PASS

- [ ] **Step 6: typecheck + 提交**

Run: `npm run typecheck`
```bash
git add src/tools/types.ts src/loop.ts test/loop.test.ts
git commit -m "feat(skills): ToolContext.injectUserMessage + loop drainInjections（inline 走 user 通道注入，不开信任例外）"
```

---

## Task 5: `tools/skill.ts` — 单 `Skill` 工具（inline + forked）

**Files:**
- Create: `src/tools/skill.ts`
- Test: `test/tools.skill.test.ts`（新）

**Interfaces:**
- Consumes: `SkillDefinition`、`substituteSkillArgs`（Task 2/3）；`runSubagent`/`acquire`/`release`（Task 1）；`ToolContext.injectUserMessage`（Task 4）；`resolveAgentTools`/`AgentDefinition`/`GLOBAL_SUBAGENT_DENY`/`SUB_MODEL`。
- Produces: `makeSkillTool(skills: SkillDefinition[], deps: { client: OpenAI; onUsage: (u: Usage, model: string) => void; getModel: () => string; agents: AgentDefinition[]; skillPool: Tool<any>[] }): Tool`

- [ ] **Step 1: 写测试（先失败）**

`test/tools.skill.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { makeSkillTool } from '../src/tools/skill.js'
import type { SkillDefinition } from '../src/skillsLoader.js'

const baseDeps = { client: {} as any, onUsage: () => {}, getModel: () => 'm', agents: [], skillPool: [] }
const mkCtx = () => ({
  cwd: () => '/p', setCwd: () => {}, signal: new AbortController().signal,
  fileState: new Map(), injectUserMessage: vi.fn(), sessionId: () => 'sess1',
}) as any

const inlineSkill: SkillDefinition = {
  name: 'greet', description: '打招呼', context: 'inline',
  userInvocable: true, modelInvocable: true, skillDir: '/skills/greet', isLegacy: false,
  body: '对 $ARG1 说你好（dir=${DEEPCODE_SKILL_DIR}）',
}

describe('makeSkillTool', () => {
  it('inline：调 injectUserMessage 注入替换后正文，返回激活回执', async () => {
    const tool = makeSkillTool([inlineSkill], baseDeps)
    const ctx = mkCtx()
    const out = await tool.call({ skill: 'greet', args: 'Sam' }, ctx)
    expect(ctx.injectUserMessage).toHaveBeenCalledWith('对 Sam 说你好（dir=/skills/greet）')
    expect(out).toContain('greet') // 激活回执提到 skill 名
  })

  it('缺 skill → 抛错列出可用', async () => {
    const tool = makeSkillTool([inlineSkill], baseDeps)
    await expect(tool.call({ skill: 'nope' }, mkCtx())).rejects.toThrow(/greet/)
  })

  it('modelInvocable=false 的 skill 不可被模型调用', async () => {
    const userOnly = { ...inlineSkill, name: 'secret', modelInvocable: false }
    const tool = makeSkillTool([userOnly], baseDeps)
    await expect(tool.call({ skill: 'secret' }, mkCtx())).rejects.toThrow(/secret/)
  })

  it('forked：走 runSubagent（mock）返回其结果', async () => {
    vi.resetModules()
    vi.doMock('../src/subagentRunner.js', () => ({
      acquire: async () => {}, release: () => {},
      runSubagent: async () => '子代理结果',
    }))
    const { makeSkillTool: mk } = await import('../src/tools/skill.js')
    const forkSkill = { ...inlineSkill, name: 'audit', context: 'fork' as const }
    const tool = mk([forkSkill], baseDeps)
    const out = await tool.call({ skill: 'audit', args: 'x' }, mkCtx())
    expect(out).toBe('子代理结果')
    vi.doUnmock('../src/subagentRunner.js')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/tools.skill.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/tools/skill.ts`**

```ts
// src/tools/skill.ts —— 单个 Skill 工具：模型调用一个本地 skill。inline 经 injectUserMessage 走 user 通道；forked 走 runSubagent。
import { z } from 'zod'
import type OpenAI from 'openai'
import type { Tool, ToolContext } from './types.js'
import type { Usage } from '../api.js'
import type { SkillDefinition } from '../skillsLoader.js'
import { substituteSkillArgs } from '../skillsLoader.js'
import { acquire, release, runSubagent } from '../subagentRunner.js'
import { resolveAgentTools, GLOBAL_SUBAGENT_DENY, type AgentDefinition } from './agentTypes.js'
import { SUB_MODEL } from './constants.js'
import { generateTaskId } from '../tasks.js'

const schema = z.object({
  skill: z.string().describe('技能名'),
  args: z.string().optional().describe('传给技能的参数'),
})

export function makeSkillTool(
  skills: SkillDefinition[],
  deps: { client: OpenAI; onUsage: (u: Usage, model: string) => void; getModel: () => string; agents: AgentDefinition[]; skillPool: Tool<any>[] },
): Tool<typeof schema> {
  const callable = skills.filter(s => s.modelInvocable)
  const listing = callable.map(s => `- ${s.name}：${s.description}${s.whenToUse ? ` — ${s.whenToUse}` : ''}`).join('\n')
  return {
    name: 'Skill',
    description: `调用一个技能（skill）。调用后该技能的指令会以独立消息交付给你，按其执行。可用技能：\n${listing || '（无）'}`,
    inputSchema: schema,
    isReadOnly: true,
    needsPermission: () => false,
    async call(input, ctx: ToolContext) {
      const skill = callable.find(s => s.name === input.skill)
      if (!skill) {
        throw new Error(`技能 '${input.skill}' 不存在或不可由模型调用。可用：${callable.map(s => s.name).join(', ') || '（无）'}`)
      }
      const filled = substituteSkillArgs(skill.body, input.args ?? '', {
        argNames: skill.argNames, skillDir: skill.skillDir, sessionId: ctx.sessionId?.(),
      })
      if (skill.context === 'fork') {
        // forked：子代理工具集 = skillPool 经 agent def + skill.allowedTools 收窄（只能收窄不能提权）。
        const type = skill.agent ?? 'general-purpose'
        const def: AgentDefinition = deps.agents.find(a => a.agentType === type) ?? {
          agentType: type, whenToUse: '', getSystemPrompt: () => '',
        }
        const effectiveDef: AgentDefinition = skill.allowedTools ? { ...def, tools: skill.allowedTools } : def
        const tools = resolveAgentTools(effectiveDef, deps.skillPool, GLOBAL_SUBAGENT_DENY)
        const model = !skill.model || skill.model === 'inherit' ? deps.getModel() : skill.model === 'flash' ? SUB_MODEL : skill.model
        await acquire()
        try {
          const result = await runSubagent({
            client: deps.client, onUsage: deps.onUsage,
            systemPrompt: filled, userPrompt: input.args ?? '（无参数）',
            tools, model, ctx, signal: ctx.signal,
            agentId: generateTaskId('local_agent'), agentType: type,
          })
          return result ?? '（技能子代理无输出）'
        } finally { release() }
      }
      // inline：正文走 user 通道注入（无信任例外）；返回简短激活回执。
      if (!ctx.injectUserMessage) {
        // 兜底：宿主未接注入通道（不应发生于主会话/headless）。直接返回正文，附说明。
        return `技能 '${skill.name}' 指令：\n${filled}`
      }
      ctx.injectUserMessage(filled)
      return `已激活技能 '${skill.name}'，其指令见下一条消息，请按其执行。`
    },
  }
}
```
（注：`AgentDefinition` 的最小兜底对象字段需与 agentTypes.ts 的 `AgentDefinition` 必填项一致——实现时核对 `agentTypes.ts`，缺字段补上；`tools` 为可选才能这样覆盖。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/tools.skill.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck + 提交**

Run: `npm run typecheck`
```bash
git add src/tools/skill.ts test/tools.skill.test.ts
git commit -m "feat(skills): 单 Skill 工具（inline 经 injectUserMessage / forked 经 runSubagent，allowedTools 收窄）"
```

---

## Task 6: `prompt.ts` skill 清单注入

**Files:**
- Modify: `src/prompt.ts`（`buildSystemPrompt` 加可选 skills 参数 + 清单节）
- Test: `test/prompt.test.ts`（追加）

**Interfaces:**
- Produces: `buildSystemPrompt(cwd: string, home?: string, skills?: SkillDefinition[]): string`（新增第三参，缺省零行为变化）
- Consumes: `SkillDefinition`。

- [ ] **Step 1: 写测试（先失败）**

追加到 `test/prompt.test.ts`：
```ts
import { buildSystemPrompt } from '../src/prompt.js'
import type { SkillDefinition } from '../src/skillsLoader.js'

it('清单注入：只列 modelInvocable 的 skill；空/无 skills 不加节', () => {
  const cwd = process.cwd()
  expect(buildSystemPrompt(cwd, undefined, [])).not.toContain('可用技能')
  const skills: SkillDefinition[] = [
    { name: 'a', description: '甲', context: 'inline', userInvocable: true, modelInvocable: true, skillDir: '/d', isLegacy: false, body: 'x' },
    { name: 'b', description: '乙', context: 'inline', userInvocable: true, modelInvocable: false, skillDir: '/d', isLegacy: true, body: 'y' },
  ]
  const p = buildSystemPrompt(cwd, undefined, skills)
  expect(p).toContain('可用技能')
  expect(p).toContain('a：甲')
  expect(p).not.toContain('乙') // b 不可由模型调用，不列
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/prompt.test.ts`
Expected: FAIL（第三参未支持 / 无清单）

- [ ] **Step 3: 改 `buildSystemPrompt`**

`src/prompt.ts`：import 类型 + 改签名 + 末尾追加清单。
```ts
import type { SkillDefinition } from './skillsLoader.js'
```
签名改 `export function buildSystemPrompt(cwd: string, home: string = os.homedir(), skills?: SkillDefinition[]): string {`。
在 return 模板里 `${memory ? '\n' + memory : ''}` 之后追加 skills 清单（拼到模板末尾）：
```ts
  const callable = (skills ?? []).filter(s => s.modelInvocable)
  const skillBlock = callable.length
    ? `\n\n# 可用技能（Skills）\n你可以用 Skill 工具调用以下技能（也可在对话中按需触发）：\n` +
      callable.map(s => `- ${s.name}：${s.description}${s.whenToUse ? ` — ${s.whenToUse}` : ''}`).join('\n')
    : ''
```
把 `skillBlock` 拼到最终返回字符串末尾（在现有模板字符串后 `+ skillBlock`）。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx vitest run test/prompt.test.ts`
Expected: PASS（现有 prompt 测试不破——第三参缺省零变化）

- [ ] **Step 5: typecheck + 提交**

Run: `npm run typecheck`
```bash
git add src/prompt.ts test/prompt.test.ts
git commit -m "feat(skills): buildSystemPrompt 注入 skill 清单（仅 modelInvocable，会话静态保 KV 缓存）"
```

---

## Task 7: headless 接线

**Files:**
- Modify: `src/headless.ts`
- Test: `test/headless.skill.test.ts`（新）

**Interfaces:**
- Consumes: `loadSkills`、`makeSkillTool`、`buildSystemPrompt(三参)`、`ToolContext.injectUserMessage`、`LoopDeps.drainInjections`、`allTools`、`makeWebFetchTool`。

- [ ] **Step 1: 写接线测试（先失败）**

参考 `test/headless.mcp.test.ts` 的 mock 模式，`test/headless.skill.test.ts` 验证：注入一个本地 inline skill（临时目录），跑 headless，模型第一轮调 `Skill` → 第二轮正文以 user 消息出现并被据其作答。用 mock client 控制两轮：
```ts
// 断言：messages 中存在 role:'user' 且 content == 替换后 skill 正文（在 Skill 工具结果之后）
// 且最终回复反映模型读到了该指令。
```
（按 headless.mcp.test.ts 既有的 client mock + tmp settings/skill 目录写法实现。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/headless.skill.test.ts`
Expected: FAIL（headless 未注入 Skill 工具 / 未接 drainInjections）

- [ ] **Step 3: headless.ts 接线**

import 追加：
```ts
import { loadSkills } from './skillsLoader.js'
import { makeSkillTool } from './tools/skill.js'
```
`const agents = resolveAgents(cwd)` 后加：
```ts
const skills = loadSkills(cwd)
const injectionBuffer: string[] = []
ctx.injectUserMessage = (c: string) => injectionBuffer.push(c)
```
（`ctx` 此时已构造，追加属性即可。）
`buildSystemPrompt(cwd)` 两处（:61 initMsgs）改 `buildSystemPrompt(cwd, undefined, skills)`。
runLoop 的 `tools` 数组（:95）加 `makeSkillTool(skills, { client: opts.client, onUsage: (u, _m) => addUsage(u), getModel: () => model, agents, skillPool: [...allTools, makeWebFetchTool({ client: opts.client, onUsage: (u, _m) => addUsage(u) })] })`。
runLoop deps 加 `drainInjections: () => injectionBuffer.splice(0),`。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx vitest run test/headless.skill.test.ts test/headless.test.ts test/headless.mcp.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck + 提交**

Run: `npm run typecheck`
```bash
git add src/headless.ts test/headless.skill.test.ts
git commit -m "feat(skills): headless 接线（loadSkills + Skill 工具 + injectUserMessage/drainInjections + 清单）"
```

---

## Task 8: useChat 接线 + `/skill` 分发 + suggest 补全（TUI，末真机冒烟）

**Files:**
- Modify: `src/tui/useChat.ts`
- Modify: `src/tui/suggest.ts`
- Test: `test/suggest.test.ts`（若存在则追加；否则在本任务建最小用例）；useChat 接线靠真机冒烟 + typecheck

**Interfaces:**
- Consumes: `loadSkills`、`makeSkillTool`、`buildSystemPrompt(三参)`、`substituteSkillArgs`、`LoopDeps.drainInjections`、`ToolContext.injectUserMessage`。

- [ ] **Step 1: useChat 接线（注入 + 工具 + 清单）**

import 追加：
```ts
import { loadSkills, substituteSkillArgs } from '../skillsLoader.js'
import { makeSkillTool } from '../tools/skill.js'
```
`const agents = resolveAgents(cwd)`（:229）后加：
```ts
const skills = loadSkills(cwd)
const injectionBuffer: string[] = []
ctx.injectUserMessage = (c: string) => injectionBuffer.push(c)
```
`buildSystemPrompt(cwd)` 三处（:216、:288 restoreSession、:337 区域如有）改传 `buildSystemPrompt(cwd, undefined, skills)`。
`tools` 数组（:361-378）加（在 `makeAskUserQuestionTool` 后）：
```ts
    makeSkillTool(skills, {
      client: opts.client,
      onUsage: (u, m) => { usageLog.push({ usage: u, model: m }); session.appendUsage(u, m) },
      getModel: () => model, agents,
      skillPool: [...allTools, makeWebFetchTool({ client: opts.client, onUsage: (u, m) => { usageLog.push({ usage: u, model: m }); session.appendUsage(u, m) } })],
    }),
```
runTurn 的 `LoopDeps`（:485-505）加 `drainInjections: () => injectionBuffer.splice(0),`。

- [ ] **Step 2: `/skill` 用户斜杠分发改造**

useChat.ts:720-724 现有 `else if (line.startsWith('/'))` 分支：先查 skill（userInvocable），命中则按 inline/forked 处理；未命中再回落现有 customCommands。改为：
```ts
    } else if (line.startsWith('/')) {
      const [name, ...rest] = line.slice(1).split(' ')
      const skill = skills.find(s => s.name === name && s.userInvocable)
      if (skill) {
        const args = rest.join(' ')
        const filled = substituteSkillArgs(skill.body, args, {
          argNames: skill.argNames, skillDir: skill.skillDir, sessionId: ctx.sessionId?.(),
        })
        if (skill.context === 'fork') {
          // forked 用户技能：交给 Skill 工具同款路径不便（无 tool_call 上下文），直接把正文作为 user 指令发送，
          // 让模型据其行动（forked 隔离留 model 调用路径；用户敲斜杠的 fork 简化为 inline 注入，记偏离）。
          userText = filled
        } else {
          userText = filled
        }
      } else {
        const tpl = customCommands.get(name)
        if (!tpl) { notice('warn', `未知命令 /${name}，/help 查看可用命令`); return }
        userText = expandCommand(tpl, rest.join(' '))
      }
    } else {
```
（注：legacy command 同时也进了 `skills`（isLegacy，userInvocable=true），故 `skills.find` 会先命中 legacy；`customCommands` 回落保留作兜底，二者数据同源不冲突。inline 用户技能正文作为 user 消息经 runTurn 发送 = 天然对齐 CC。）

- [ ] **Step 3: suggest.ts 补全合并 skill 名**

`computeSuggestions` 的 env 加 `skills?: { name: string }[]`，slash 分支合并 skill 名候选：
```ts
export function computeSuggestions(input: string, env: { cwd: string; customCommands: Map<string, string>; skills?: { name: string; userInvocable: boolean }[] }): Suggestion[] {
  if (input.startsWith('/') && !input.includes(' ')) {
    const skillItems = (env.skills ?? []).filter(s => s.userInvocable).map(s => ({ value: `/${s.name}`, hint: '技能' }))
    const all = [...BUILTIN_COMMANDS, ...skillItems, ...[...env.customCommands.keys()].map(n => ({ value: `/${n}`, hint: '自定义命令' }))]
    // 去重（skill 覆盖同名 customCommand）
    const seen = new Set<string>(); const dedup = all.filter(s => !seen.has(s.value) && seen.add(s.value))
    const filtered = dedup.filter(s => s.value.startsWith(input))
    if (filtered.length === 1 && filtered[0].value === input) return []
    return input === '/' ? filtered : filtered.slice(0, 8)
  }
  // …@ 分支不变…
```
更新两个调用点 `computeSuggestions`（FullscreenApp.tsx:123、App.tsx:98）传入 `skills: core.skills`，并在 useChat 返回对象（:771 区域，与 `customCommands` 并列）导出 `skills`。

- [ ] **Step 4: suggest 单测（先失败→通过）**

`test/suggest.test.ts`（新或追加）：
```ts
import { describe, it, expect } from 'vitest'
import { computeSuggestions } from '../src/tui/suggest.js'
it('/ 补全合并 skill 名（userInvocable），与 customCommand 去重', () => {
  const out = computeSuggestions('/gr', {
    cwd: process.cwd(), customCommands: new Map(),
    skills: [{ name: 'greet', userInvocable: true }, { name: 'secret', userInvocable: false }],
  })
  expect(out.map(s => s.value)).toContain('/greet')
  expect(out.map(s => s.value)).not.toContain('/secret')
})
```
Run: `npx vitest run test/suggest.test.ts` → PASS

- [ ] **Step 5: 全量测试 + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: 全绿（含现有 useChat/suggest 相关测试零回归）

- [ ] **Step 6: 真机冒烟（用户执行）**

准备一个本地 skill：`mkdir -p ~/.deepcode/skills/hello && printf -- '---\ndescription: 打个招呼\n---\n用一句话热情地跟用户打招呼，提到今天是美好的一天。\n' > ~/.deepcode/skills/hello/SKILL.md`
然后 `npm start`，分别验证：
1. 敲 `/hello` → 正文作为指令、模型据其回应（user 路径 inline）。
2. 对模型说「调用 hello 技能」→ 模型调 `Skill` 工具 → 下一轮据注入正文回应（model 路径 inline）。
3. `/` 补全菜单出现 `/hello`（hint「技能」）。
Expected: 三项都正常。问题记录回本任务修复后再合并。

- [ ] **Step 7: 提交**

```bash
git add src/tui/useChat.ts src/tui/suggest.ts src/tui/FullscreenApp.tsx src/tui/App.tsx test/suggest.test.ts
git commit -m "feat(skills): useChat 接线 + /skill 用户分发统一 + suggest 补全 skill 名（真机冒烟过）"
```

---

## Self-Review（写完计划对照 spec 检查）

**1. Spec coverage：**
- §3.1 skillsLoader（发现/解析/合并）→ Task 2 ✓
- §3.2 subagentRunner 抽取 + 信号量下沉 → Task 1 ✓
- §3.3 makeSkillTool（inline/forked/allowedTools 收窄）→ Task 5 ✓
- §3.4 substituteSkillArgs → Task 3 ✓
- §3.5 prompt 清单注入 → Task 6 ✓
- §4 inline 方案 C（injectUserMessage + loop flush）→ Task 4（机制）+ Task 5（skill 调用）+ Task 7/8（接线）✓
- §5 接线地图（useChat/headless/agent/loop/types/prompt/suggest）→ Task 1/4/6/7/8 全覆盖 ✓
- §6 安全边界（inline 不开例外、forked 钳制、legacy user-only、model 白名单）→ Task 4/5（不开例外、收窄）+ Task 2（legacy modelInvocable=false）✓
- §1 不做清单（allowedTools inline 不收窄、内联 shell 砍、plugin/MCP/remote/paths/skill hooks/char 预算/compaction）→ 计划未实现，符合 ✓

**2. Placeholder scan：** 无 TBD/TODO；每个 code step 有真实代码。Task 7 Step 1 的 headless 测试体描述了断言但未贴完整 mock——已注明「参考 headless.mcp.test.ts 既有写法」，因 mock 客户端样板依赖该文件现有 helper，实现时照搬。可接受（非占位，是「复用既有模式」指引）。

**3. Type consistency：** `SkillDefinition` 字段在 Task 2 定义，Task 5/6/8 一致引用（name/description/whenToUse/context/agent/allowedTools/model/userInvocable/modelInvocable/argNames/skillDir/isLegacy/body）。`runSubagent`/`RunSubagentOpts` Task 1 定义，Task 5 一致调用。`injectUserMessage`/`drainInjections` Task 4 定义，Task 5/7/8 一致接线。✓

**4. 潜在循环依赖注意（实现时验证）：** subagentRunner.ts import agent.ts 的 `subagentPermissionDecision`，agent.ts import subagentRunner.ts 的 runner/信号量。ESM 下函数级互引可行（运行时调用，非顶层求值），但若 typecheck/运行报循环，把 `subagentPermissionDecision` 也下沉到 subagentRunner.ts（或独立 `permissions.ts` 已有 `isDangerous`，直接在 subagentRunner 内联该 1 行逻辑）。Task 1 Step 4 实现时确认。
