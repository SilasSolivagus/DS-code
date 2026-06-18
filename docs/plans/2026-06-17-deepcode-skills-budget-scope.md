# deepcode Skills 清单预算 + scope 配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Skills 清单加 token 预算截断（对齐 CC `formatCommandsWithinBudget`）+ opt-in 的来源/排除配置，默认行为字节级对齐 CC（全扫、双可调用、无静默截断）。

**Architecture:** 三块纯逻辑改动 + 接线。`config.ts` 新增 `SkillsConfig` 配置 + 宽松解析；`skillsLoader.ts` 给 `loadSkills` 加 `config` 参（sources 过滤目录 / deny 过滤结果 / priority 字段）+ 新纯函数 `formatSkillListing`（per-entry 250 字符截断 + 总预算 8000 字符 + 优先级排序 + 末尾省略行）；`prompt.ts` 与 `tools/skill.ts` 两处清单复用 `formatSkillListing`；`useChat.ts`/`headless.ts` 把 `settings.skills` 传进去。无 TUI 改动。

**Tech Stack:** TypeScript/ESM、vitest、zod（本特性不直接用）。纯函数为主，依赖 `node:fs`/`node:path`/`node:os`。

## Global Constraints

- 对齐依据 spec：`docs/specs/2026-06-17-deepcode-skills-budget-scope-design.md`。
- **默认行为字节级对齐 CC / 现状**：无 config 时 `loadSkills(cwd, home)` 的发现/合并语义不变；预算缺省 `DEFAULT_LISTING_BUDGET_CHARS = 8000`、per-entry 缺省 `MAX_LISTING_DESC_CHARS = 250`。
- **不做（YAGNI）**：allow 白名单、glob/正则 deny、按来源设 modelInvocable 默认、token 精确计量。
- 测试用 vitest（`describe/it/expect`），临时目录用 `fs.mkdtempSync(path.join(os.tmpdir(), ...))`，与现有 `test/skillsLoader.test.ts`/`test/config.mcp.test.ts` 风格一致。
- 每任务合并前：`npm test` 全绿 + `npm run typecheck` + `npm run build` 干净（已知 EPIPE flaky 不计失败）。
- 纯逻辑无 TUI，免真机冒烟。

---

## File Structure

- **Modify** `src/config.ts`：新增 `SkillsConfig` 接口 + `Settings.skills` 字段 + `parseSkillsConfig` 函数 + `loadSettings` 接入。
- **Modify** `src/skillsLoader.ts`：`SkillDefinition.priority` 字段 + `loadSkills` 加 `config?: SkillsConfig` 参（sources/deny/priority）+ 纯函数 `formatSkillListing` + 常量 `MAX_LISTING_DESC_CHARS`/`DEFAULT_LISTING_BUDGET_CHARS`。
- **Modify** `src/prompt.ts`：`buildSystemPrompt` 加第 4 参 `budgetChars?` + 清单改用 `formatSkillListing`。
- **Modify** `src/tools/skill.ts`：`makeSkillTool` deps 加 `listingBudgetChars?` + description 清单改用 `formatSkillListing`。
- **Modify** `src/tui/useChat.ts` + `src/headless.ts`：把 `settings.skills` 传给 loadSkills / buildSystemPrompt / makeSkillTool。
- **Create** `test/config.skills.test.ts`：`parseSkillsConfig` 单测。
- **Modify** `test/skillsLoader.test.ts`：`loadSkills` config 行为 + `formatSkillListing` 单测。
- **Modify** `test/prompt.test.ts`：清单经 formatSkillListing（截断/省略行）。
- **Modify** `test/tools.skill.test.ts`：description 清单经 formatSkillListing（deny 既不在清单也不可调用）。

为避免循环依赖：`SkillsConfig` 定义在 `config.ts`，`skillsLoader.ts` 通过 `import type` 引用它（`config.ts` 已 import `skillsLoader`? 否——`config.ts` 当前不 import skillsLoader，无环；`skillsLoader.ts` 只 `import type` 不引入运行时依赖）。

---

## Task 1: `SkillsConfig` 配置 + 宽松解析（config.ts）

**Files:**
- Modify: `src/config.ts`（`Settings` 接口约 13-31 行、`loadSettings` 约 47-65 行、`parseMcpServers` 之后约 99 行追加）
- Test: `test/config.skills.test.ts`（新建）

**Interfaces:**
- Produces:
  - `export interface SkillsConfig { sources?: Array<'claude' | 'deepcode'>; deny?: string[]; listingBudgetChars?: number }`
  - `export function parseSkillsConfig(raw: unknown): SkillsConfig | undefined`
  - `Settings.skills?: SkillsConfig`

- [ ] **Step 1: 写失败测试**

新建 `test/config.skills.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { parseSkillsConfig } from '../src/config.js'

describe('parseSkillsConfig', () => {
  it('合法 sources：只留 claude/deepcode', () => {
    expect(parseSkillsConfig({ sources: ['deepcode', 'bogus', 'claude'] }))
      .toEqual({ sources: ['deepcode', 'claude'] })
  })
  it('sources 全非法 → 不带 sources（落默认全扫）', () => {
    expect(parseSkillsConfig({ sources: ['bogus', 123] })).toEqual({})
  })
  it('deny：留非空 string 并 trim', () => {
    expect(parseSkillsConfig({ deny: ['  cso ', '', 'ship', 7] }))
      .toEqual({ deny: ['cso', 'ship'] })
  })
  it('listingBudgetChars：正整数才取', () => {
    expect(parseSkillsConfig({ listingBudgetChars: 4000 })).toEqual({ listingBudgetChars: 4000 })
    expect(parseSkillsConfig({ listingBudgetChars: 0 })).toEqual({})
    expect(parseSkillsConfig({ listingBudgetChars: -5 })).toEqual({})
    expect(parseSkillsConfig({ listingBudgetChars: 1.5 })).toEqual({})
    expect(parseSkillsConfig({ listingBudgetChars: 'big' })).toEqual({})
  })
  it('整个对象非法 → undefined', () => {
    expect(parseSkillsConfig(undefined)).toBeUndefined()
    expect(parseSkillsConfig(null)).toBeUndefined()
    expect(parseSkillsConfig('x')).toBeUndefined()
    expect(parseSkillsConfig([1, 2])).toBeUndefined()
  })
  it('空对象 → 空 SkillsConfig（不是 undefined；用于表达「有 skills 配置但全用默认」）', () => {
    expect(parseSkillsConfig({})).toEqual({})
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/config.skills.test.ts`
Expected: FAIL —— `parseSkillsConfig is not a function`（config.ts 尚未导出）。

- [ ] **Step 3: 实现 SkillsConfig + parseSkillsConfig + 接线**

在 `src/config.ts` 的 `Settings` 接口前（约第 12 行 `export interface Settings` 之前）新增：

```ts
export interface SkillsConfig {
  /** 扫哪些目录家族；缺省 = 两者都扫（对齐 CC 全扫）。
   *  'claude' = <home|proj>/.claude/skills；'deepcode' = <home|proj>/.deepcode/{skills,commands}。
   *  ['deepcode'] 一刀切跳过所有 .claude 源（干掉 ~/.claude 的 gstack 灌入）。 */
  sources?: Array<'claude' | 'deepcode'>
  /** 按精确 skill 名排除（不加载→不在任何清单、不可调用）。 */
  deny?: string[]
  /** 模型清单 + Skill 工具 description 的总字符预算；缺省 8000（对齐 CC）。 */
  listingBudgetChars?: number
}
```

在 `Settings` 接口里 `mcpServers?: ...` 之后新增字段：

```ts
  /** Skills 发现范围 + 清单预算配置（opt-in；缺省对齐 CC 全扫全可调用）。 */
  skills?: SkillsConfig
```

在 `parseMcpServers`（约第 99 行结束）之后新增：

```ts
/** 宽松解析 settings.skills：sources 仅留 'claude'|'deepcode'；deny 留 trim 后非空 string；
 *  listingBudgetChars 须正整数。任一字段非法即丢弃该字段（落默认）。非对象 → undefined。 */
export function parseSkillsConfig(raw: unknown): SkillsConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const out: SkillsConfig = {}
  if (Array.isArray(r.sources)) {
    const valid = r.sources.filter((s): s is 'claude' | 'deepcode' => s === 'claude' || s === 'deepcode')
    if (valid.length) out.sources = valid
  }
  if (Array.isArray(r.deny)) {
    const valid = r.deny.filter((d): d is string => typeof d === 'string').map(d => d.trim()).filter(d => d.length > 0)
    if (valid.length) out.deny = valid
  }
  if (typeof r.listingBudgetChars === 'number' && Number.isInteger(r.listingBudgetChars) && r.listingBudgetChars > 0) {
    out.listingBudgetChars = r.listingBudgetChars
  }
  return out
}
```

在 `loadSettings` 的返回对象里（`mcpServers: parseMcpServers(raw?.mcpServers),` 之后）新增：

```ts
    skills: parseSkillsConfig(raw?.skills),
```

> 注：`parseSkillsConfig({})` 返回 `{}`（非 undefined）——空对象表示「显式存在 skills 配置但全用默认值」，与 `parseMcpServers`（空→undefined）不同是有意的：`loadSkills`/接线对 `{}` 和 `undefined` 等价处理，此差异不影响行为，仅简化解析（先建 out 再按字段填）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/config.skills.test.ts`
Expected: PASS（全部 6 个用例）。

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: 干净无错。

- [ ] **Step 6: 提交**

```bash
git add src/config.ts test/config.skills.test.ts
git commit -m "feat(skills): SkillsConfig 配置 + parseSkillsConfig 宽松解析"
```

---

## Task 2: `loadSkills` 加 config 参（sources/deny/priority）（skillsLoader.ts）

**Files:**
- Modify: `src/skillsLoader.ts`（`SkillDefinition` 接口约 7-21 行加 `priority`；`loadSkills` 约 89-102 行重写）
- Test: `test/skillsLoader.test.ts`（在 `loadSkills 发现 + 合并` describe 后追加 `loadSkills config` describe）

**Interfaces:**
- Consumes: `import type { SkillsConfig } from './config.js'`
- Produces:
  - `SkillDefinition.priority: number`（小=高优先；项目=0、user/home=1、legacy=2）
  - `export function loadSkills(cwd: string, home?: string, config?: SkillsConfig): SkillDefinition[]`

- [ ] **Step 1: 写失败测试**

在 `test/skillsLoader.test.ts` 顶部 import 处加 `SkillsConfig` 无需显式 import（config 以字面量传入）。在 `describe('loadSkills 发现 + 合并', ...)` 之后追加：

```ts
describe('loadSkills config（sources/deny/priority）', () => {
  function setup() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-home-'))
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-cwd-'))
    // home/.claude/skills/cso（模拟 gstack 灌入）
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'cso'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'skills', 'cso', 'SKILL.md'), '---\ndescription: 安全审计\n---\n审计')
    // home/.deepcode/skills/hello（user 级 deepcode 源）
    fs.mkdirSync(path.join(home, '.deepcode', 'skills', 'hello'), { recursive: true })
    fs.writeFileSync(path.join(home, '.deepcode', 'skills', 'hello', 'SKILL.md'), '---\ndescription: 问好\n---\n你好')
    // cwd/.deepcode/skills/proj（项目级）
    fs.mkdirSync(path.join(cwd, '.deepcode', 'skills', 'proj'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.deepcode', 'skills', 'proj', 'SKILL.md'), '---\ndescription: 项目技能\n---\n做事')
    // cwd/.deepcode/commands/recap.md（legacy）
    fs.mkdirSync(path.join(cwd, '.deepcode', 'commands'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.deepcode', 'commands', 'recap.md'), '回顾')
    return { home, cwd }
  }

  it('sources:["deepcode"] 跳过 .claude 源（干掉 cso 灌入）', () => {
    const { home, cwd } = setup()
    const names = loadSkills(cwd, home, { sources: ['deepcode'] }).map(s => s.name)
    expect(names).not.toContain('cso')
    expect(names).toEqual(expect.arrayContaining(['hello', 'proj', 'recap']))
  })

  it('deny 精确排除', () => {
    const { home, cwd } = setup()
    const names = loadSkills(cwd, home, { deny: ['cso', 'recap'] }).map(s => s.name)
    expect(names).not.toContain('cso')
    expect(names).not.toContain('recap')
    expect(names).toEqual(expect.arrayContaining(['hello', 'proj']))
  })

  it('priority 赋值：项目 0 / user(home) 1 / legacy 2', () => {
    const { home, cwd } = setup()
    const byName = Object.fromEntries(loadSkills(cwd, home).map(s => [s.name, s.priority]))
    expect(byName['proj']).toBe(0)   // 项目 skills
    expect(byName['hello']).toBe(1)  // home/.deepcode/skills
    expect(byName['cso']).toBe(1)    // home/.claude/skills
    expect(byName['recap']).toBe(2)  // legacy commands
  })

  it('无 config：发现/合并语义同现状（仅多了 priority 字段）', () => {
    const { home, cwd } = setup()
    const names = loadSkills(cwd, home).map(s => s.name).sort()
    expect(names).toEqual(['cso', 'hello', 'proj', 'recap'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/skillsLoader.test.ts -t "loadSkills config"`
Expected: FAIL —— `sources` 不被识别（cso 仍出现）/ `priority` undefined。

- [ ] **Step 3: 实现 priority 字段 + loadSkills 重写**

`src/skillsLoader.ts` 顶部 import 加：

```ts
import type { SkillsConfig } from './config.js'
```

在 `SkillDefinition` 接口里 `body: string` 之前加：

```ts
  /** 清单优先级（小=高）：项目=0、user/home=1、legacy=2。formatSkillListing 排序用。 */
  priority: number
```

`loadSkillsFromDir`/`loadLegacyFromDir` 产出的对象当前来自 `parseSkillFile`，它**不设** priority。改为：`loadSkills` 在装配时按目录给每条打 priority。修改 `loadSkillsFromDir`/`loadLegacyFromDir` 让其接收并标注 priority：

```ts
function loadSkillsFromDir(dir: string, priority: number): SkillDefinition[] {
  let names: string[] = []
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) } catch { return [] }
  const out: SkillDefinition[] = []
  for (const name of names) {
    const file = path.join(dir, name, 'SKILL.md')
    try {
      const def = parseSkillFile(fs.readFileSync(file, 'utf8'), path.join(dir, name), name, false)
      if (def) out.push({ ...def, priority })
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
      if (def) out.push({ ...def, priority: 2 }) // legacy = 2
    } catch { /* 单文件坏跳过 */ }
  }
  return out
}
```

> `parseSkillFile` 返回的 `SkillDefinition` 现在缺 `priority` 字段——会触发 typecheck 报错。解决：把 `parseSkillFile` 返回的两个对象字面量都补 `priority: 0`（占位默认，装配处统一覆写）。在 `parseSkillFile` 的 legacy 分支 return 对象加 `priority: 0,`，非 legacy 分支 return 对象也加 `priority: 0,`。

重写 `loadSkills`（替换约 89-102 行）：

```ts
/** 发现序低→高优先（last-wins）：legacy commands < skills；home < project；.claude < .deepcode。
 *  config.sources 给定时只扫选中家族；config.deny 精确名排除；每条带 priority（listing 排序用）。 */
export function loadSkills(cwd: string, home: string = os.homedir(), config?: SkillsConfig): SkillDefinition[] {
  const sources = config?.sources
  const useClaude = !sources || sources.includes('claude')
  const useDeepcode = !sources || sources.includes('deepcode')
  const ordered: SkillDefinition[] = []
  if (useDeepcode) {
    ordered.push(
      ...loadLegacyFromDir(path.join(home, '.deepcode', 'commands')),
      ...loadLegacyFromDir(path.join(cwd, '.deepcode', 'commands')),
    )
  }
  if (useClaude) ordered.push(...loadSkillsFromDir(path.join(home, '.claude', 'skills'), 1))   // home = 1
  if (useDeepcode) ordered.push(...loadSkillsFromDir(path.join(home, '.deepcode', 'skills'), 1)) // home = 1
  if (useClaude) ordered.push(...loadSkillsFromDir(path.join(cwd, '.claude', 'skills'), 0))     // 项目 = 0
  if (useDeepcode) ordered.push(...loadSkillsFromDir(path.join(cwd, '.deepcode', 'skills'), 0)) // 项目 = 0
  const m = new Map<string, SkillDefinition>()
  for (const s of ordered) m.set(s.name, s) // last-wins
  let result = [...m.values()]
  if (config?.deny && config.deny.length) {
    const deny = new Set(config.deny)
    result = result.filter(s => !deny.has(s.name))
  }
  return result
}
```

> **发现序保持不变**：原顺序是 legacy(home,cwd) → claude(home) → deepcode(home) → claude(cwd) → deepcode(cwd)。上面拆成条件 push 后顺序**完全一致**（无 sources 时按 useClaude/useDeepcode 全 true 走原序）。priority 仅是新增的标注字段，不改发现/合并/last-wins 语义。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/skillsLoader.test.ts`
Expected: PASS（含新 `loadSkills config` 4 用例 + 原 `发现 + 合并` 不回归）。

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: 干净（含 parseSkillFile 两处 priority 占位补齐后无报错）。

- [ ] **Step 6: 提交**

```bash
git add src/skillsLoader.ts test/skillsLoader.test.ts
git commit -m "feat(skills): loadSkills 加 config 参（sources/deny + priority 字段）"
```

---

## Task 3: `formatSkillListing` 预算截断（skillsLoader.ts）

**Files:**
- Modify: `src/skillsLoader.ts`（文件末尾追加常量 + 纯函数）
- Test: `test/skillsLoader.test.ts`（追加 `formatSkillListing` describe）

**Interfaces:**
- Consumes: `SkillDefinition`（含 Task 2 的 `priority`）
- Produces:
  - `export const MAX_LISTING_DESC_CHARS = 250`
  - `export const DEFAULT_LISTING_BUDGET_CHARS = 8000`
  - `export function formatSkillListing(skills: SkillDefinition[], opts?: { maxDescChars?: number; budgetChars?: number }): { text: string; shown: number; dropped: number }`

- [ ] **Step 1: 写失败测试**

在 `test/skillsLoader.test.ts` import 行补 `formatSkillListing`、`MAX_LISTING_DESC_CHARS`、`DEFAULT_LISTING_BUDGET_CHARS`：

```ts
import {
  parseSkillFile, loadSkills, substituteSkillArgs,
  formatSkillListing, MAX_LISTING_DESC_CHARS,
} from '../src/skillsLoader.js'
```

追加 describe：

```ts
describe('formatSkillListing', () => {
  const mk = (name: string, description: string, opts: Partial<{ whenToUse: string; priority: number }> = {}) => ({
    name, description, whenToUse: opts.whenToUse, context: 'inline' as const,
    userInvocable: true, modelInvocable: true, skillDir: '/x', isLegacy: false, body: 'b',
    priority: opts.priority ?? 0,
  })

  it('空集合 → 空串、计数 0', () => {
    expect(formatSkillListing([])).toEqual({ text: '', shown: 0, dropped: 0 })
  })

  it('预算够时全列、无省略行', () => {
    const r = formatSkillListing([mk('a', '甲'), mk('b', '乙')])
    expect(r.shown).toBe(2)
    expect(r.dropped).toBe(0)
    expect(r.text).toBe('- a：甲\n- b：乙')
    expect(r.text).not.toContain('省略')
  })

  it('whenToUse 拼到行尾', () => {
    const r = formatSkillListing([mk('a', '甲', { whenToUse: '用时' })])
    expect(r.text).toBe('- a：甲 — 用时')
  })

  it('per-entry 250 字符截断（description 与 whenToUse 各截）', () => {
    const long = 'x'.repeat(300)
    const r = formatSkillListing([mk('a', long, { whenToUse: long })])
    const descPart = 'x'.repeat(MAX_LISTING_DESC_CHARS) + '…'
    expect(r.text).toBe(`- a：${descPart} — ${descPart}`)
  })

  it('超总预算丢尾部 + 末尾省略行（含 dropped 计数）', () => {
    // 每行约 "- nN：" + 100 字符 ≈ 105；预算 250 只容得下约 2 行
    const skills = [0, 1, 2, 3, 4].map(i => mk('n' + i, 'd'.repeat(100)))
    const r = formatSkillListing(skills, { budgetChars: 250 })
    expect(r.shown).toBeLessThan(5)
    expect(r.dropped).toBe(5 - r.shown)
    expect(r.text).toContain(`另有 ${r.dropped} 个`)
  })

  it('按 priority 升序排（项目 0 先于 user 1 先于 legacy 2），同级保持发现序', () => {
    const skills = [
      mk('legacy', 'L', { priority: 2 }),
      mk('proj', 'P', { priority: 0 }),
      mk('user', 'U', { priority: 1 }),
    ]
    const r = formatSkillListing(skills)
    expect(r.text).toBe('- proj：P\n- user：U\n- legacy：L')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/skillsLoader.test.ts -t "formatSkillListing"`
Expected: FAIL —— `formatSkillListing is not a function`。

- [ ] **Step 3: 实现 formatSkillListing**

在 `src/skillsLoader.ts` 末尾（`substituteSkillArgs` 之后）追加：

```ts
export const MAX_LISTING_DESC_CHARS = 250
export const DEFAULT_LISTING_BUDGET_CHARS = 8000

const truncate = (s: string, max: number): string => (s.length > max ? s.slice(0, max) + '…' : s)

/** 把要列的 skills 渲染成清单文本，对齐 CC formatCommandsWithinBudget：
 *  per-entry description/whenToUse 各截 maxDescChars，总字符超 budgetChars 丢尾部并在末尾留省略行（不静默）。
 *  调用方需先按 modelInvocable/userInvocable 过滤；本函数只负责排序 + 截断 + 渲染。 */
export function formatSkillListing(
  skills: SkillDefinition[],
  opts?: { maxDescChars?: number; budgetChars?: number },
): { text: string; shown: number; dropped: number } {
  const maxDesc = opts?.maxDescChars ?? MAX_LISTING_DESC_CHARS
  const budget = opts?.budgetChars ?? DEFAULT_LISTING_BUDGET_CHARS
  // 稳定排序：priority 升序；同级保持原顺序（Array.prototype.sort 在 V8 是稳定的，但用 index 兜底显式稳定）
  const sorted = skills.map((s, i) => ({ s, i })).sort((a, b) => a.s.priority - b.s.priority || a.i - b.i).map(x => x.s)
  const lines: string[] = []
  let used = 0
  let shown = 0
  for (const s of sorted) {
    const line = `- ${s.name}：${truncate(s.description, maxDesc)}${s.whenToUse ? ` — ${truncate(s.whenToUse, maxDesc)}` : ''}`
    const add = line.length + (lines.length > 0 ? 1 : 0) // +1 为 join 的换行
    if (used + add > budget && shown > 0) break // 至少留一条（首条即使超预算也列，避免全空）
    lines.push(line)
    used += add
    shown++
  }
  const dropped = sorted.length - shown
  if (dropped > 0) {
    lines.push(`…（另有 ${dropped} 个技能因清单预算省略；用 settings.skills 的 deny / sources 收窄，或写更短的 description）`)
  }
  return { text: lines.join('\n'), shown, dropped }
}
```

> **首条保底**：`shown > 0` 守卫确保至少列一条（防 budget 极小导致全空 + 一行「另有 N 个」的退化）。测试 `budgetChars: 250` 每行 ~105 字符，会列 2 条（首条 105 ≤ 250；第二条 105+105+1=211 ≤ 250；第三条 316 > 250 → break），dropped=3，`shown=2`，符合 `shown < 5` 断言。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/skillsLoader.test.ts`
Expected: PASS（含 formatSkillListing 6 用例 + 前面任务用例不回归）。

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: 干净。

- [ ] **Step 6: 提交**

```bash
git add src/skillsLoader.ts test/skillsLoader.test.ts
git commit -m "feat(skills): formatSkillListing 预算截断（per-entry 250 + 总 8000 + 省略行）"
```

---

## Task 4: prompt.ts + skill.ts 改用 formatSkillListing

**Files:**
- Modify: `src/prompt.ts`（`buildSystemPrompt` 约 29-61 行）
- Modify: `src/tools/skill.ts`（`makeSkillTool` 约 18-26 行）
- Test: `test/prompt.test.ts`、`test/tools.skill.test.ts`

**Interfaces:**
- Consumes: `formatSkillListing`（Task 3）
- Produces:
  - `buildSystemPrompt(cwd: string, home?: string, skills?: SkillDefinition[], budgetChars?: number): string`
  - `makeSkillTool(skills, deps)`，`deps` 新增可选 `listingBudgetChars?: number`

- [ ] **Step 1: 写失败测试（prompt）**

在 `test/prompt.test.ts` 追加（import 处确保有 `buildSystemPrompt`）：

```ts
import { formatSkillListing } from '../src/skillsLoader.js'

describe('buildSystemPrompt skill 清单预算', () => {
  const mk = (name: string, description: string) => ({
    name, description, context: 'inline' as const,
    userInvocable: true, modelInvocable: true, skillDir: '/x', isLegacy: false, body: 'b', priority: 0,
  })
  it('小 budgetChars 触发截断 + 省略行进 system prompt', () => {
    const skills = [0, 1, 2, 3, 4].map(i => mk('n' + i, 'd'.repeat(100)))
    const p = buildSystemPrompt(process.cwd(), undefined, skills, 250)
    expect(p).toContain('# 可用技能（Skills）')
    expect(p).toMatch(/另有 \d+ 个技能/)
  })
  it('无 skills → 无技能节', () => {
    const p = buildSystemPrompt(process.cwd(), undefined, [])
    expect(p).not.toContain('# 可用技能（Skills）')
  })
})
```

- [ ] **Step 2: 写失败测试（skill 工具）**

在 `test/tools.skill.test.ts` 追加（沿用该文件已有的 makeSkillTool 构造方式；deps 里补 `listingBudgetChars`）：

```ts
describe('makeSkillTool 清单预算', () => {
  const mkSkill = (name: string, description: string) => ({
    name, description, context: 'inline' as const,
    userInvocable: true, modelInvocable: true, skillDir: '/x', isLegacy: false, body: 'b', priority: 0,
  })
  const deps = () => ({
    client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash',
    agents: [], skillPool: [], listingBudgetChars: 250,
  })
  it('超预算 description 含省略行', () => {
    const skills = [0, 1, 2, 3, 4].map(i => mkSkill('n' + i, 'd'.repeat(100)))
    const tool = makeSkillTool(skills, deps())
    expect(tool.description).toMatch(/另有 \d+ 个技能/)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run test/prompt.test.ts test/tools.skill.test.ts`
Expected: FAIL —— buildSystemPrompt 第 4 参未生效（无省略行）/ makeSkillTool deps `listingBudgetChars` 未被使用。

- [ ] **Step 4: 实现 prompt.ts**

`src/prompt.ts` 顶部 import 加 `formatSkillListing`（与现有 `import type { SkillDefinition }` 同行或新行；注意 `formatSkillListing` 是运行时值，须用普通 import）：

```ts
import { formatSkillListing } from './skillsLoader.js'
```

改 `buildSystemPrompt` 签名与清单块（约 29-39 行）：

```ts
export function buildSystemPrompt(cwd: string, home: string = os.homedir(), skills?: SkillDefinition[], budgetChars?: number): string {
  const memory = findMemoryFiles(cwd, home)
    .map(p => `## 项目记忆（来自 ${p}）\n${fs.readFileSync(p, 'utf8')}`)
    .join('\n\n')

  // 生成 skill 清单：只列 modelInvocable 的，经预算截断
  const callable = (skills ?? []).filter(s => s.modelInvocable)
  const { text: listing } = formatSkillListing(callable, { budgetChars })
  const skillBlock = listing
    ? `\n\n# 可用技能（Skills）\n你可以用 Skill 工具调用以下技能（也可在对话中按需触发）：\n${listing}`
    : ''
```

（`return` 段不变。）

- [ ] **Step 5: 实现 skill.ts**

`src/tools/skill.ts` import 加 `formatSkillListing`：

```ts
import { substituteSkillArgs, formatSkillListing } from '../skillsLoader.js'
```

改 `makeSkillTool` deps 类型 + listing 构造（约 18-23 行）：

```ts
export function makeSkillTool(
  skills: SkillDefinition[],
  deps: { client: OpenAI; onUsage: (u: Usage, model: string) => void; getModel: () => string; agents: AgentDefinition[]; skillPool: Tool<any>[]; listingBudgetChars?: number },
): Tool<typeof schema> {
  const callable = skills.filter(s => s.modelInvocable)
  const { text: listing } = formatSkillListing(callable, { budgetChars: deps.listingBudgetChars })
```

（`description` 里 `${listing || '（无）'}` 保持不变。）

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run test/prompt.test.ts test/tools.skill.test.ts`
Expected: PASS（新用例 + 原用例不回归）。

- [ ] **Step 7: typecheck**

Run: `npm run typecheck`
Expected: 干净。

- [ ] **Step 8: 提交**

```bash
git add src/prompt.ts src/tools/skill.ts test/prompt.test.ts test/tools.skill.test.ts
git commit -m "feat(skills): prompt + Skill 工具清单改用 formatSkillListing（预算截断）"
```

---

## Task 5: 接线 useChat.ts + headless.ts

**Files:**
- Modify: `src/tui/useChat.ts`（line 222 loadSkills、line 225/295 buildSystemPrompt、line 382 makeSkillTool deps）
- Modify: `src/headless.ts`（line 41 loadSkills、line 66 buildSystemPrompt、line 100 makeSkillTool deps）
- Test: 现有 `test/headless.skill.test.ts` 加一条 deny 端到端断言；其余靠全量套件不回归

**Interfaces:**
- Consumes: `parseSkillsConfig`/`Settings.skills`（Task 1）、`loadSkills` config 参（Task 2）、`buildSystemPrompt` budgetChars（Task 4）、`makeSkillTool` listingBudgetChars（Task 4）
- Produces: 无新接口（纯接线）

- [ ] **Step 1: 写失败测试（headless deny 端到端）**

在 `test/headless.skill.test.ts` 追加一条断言：当 `settings.skills.deny` 含某 skill 名时，该 skill 不被加载、不进 system prompt。沿用该文件已有的 settings mock 方式（若该文件 mock `loadSettings`，在 mock 返回值里加 `skills: { deny: ['<被测 skill 名>'] }`）。

```ts
// 在已有的 headless skill 测试块内，新增一个用例：
it('settings.skills.deny 排除的 skill 不出现在 system prompt', async () => {
  // 准备：临时 cwd 下放两个 skill（keep / drop），mock loadSettings 返回 skills.deny=['drop']
  // 断言：传给模型的 system message 含 'keep'、不含 'drop'
  // （具体 mock 形态对齐该文件现有 setup；若现有 setup 未 mock loadSettings，则在临时 ~/.deepcode/settings.json 写 { skills: { deny: ['drop'] } }）
})
```

> 实现者注：`test/headless.skill.test.ts` 的现有结构决定 mock 方式。优先复用其既有 `loadSettings` mock（在返回对象补 `skills`）；若无，则用 `config.test.ts` 同款 `vi.mock('node:os', ...)` 把 homedir 指到临时目录并写 `settings.json`。**保持与该文件现有约定一致，不引入新 mock 框架。**

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/headless.skill.test.ts`
Expected: FAIL —— deny 未接线，'drop' 仍出现在 system prompt。

- [ ] **Step 3: 实现 useChat.ts 接线**

- line 222：`const skills = loadSkills(cwd)` → `const skills = loadSkills(cwd, undefined, settings.skills)`
- line 225：`buildSystemPrompt(cwd, undefined, skills)` → `buildSystemPrompt(cwd, undefined, skills, settings.skills?.listingBudgetChars)`
- line 295：同 line 225 改法
- line 382 起 `makeSkillTool(skills, { ... })` 的 deps 对象末尾加：`listingBudgetChars: settings.skills?.listingBudgetChars,`

（`settings` 在 useChat line 195 `const settings = loadSettings()` 已可用。）

- [ ] **Step 4: 实现 headless.ts 接线**

- line 41：`const skills = loadSkills(cwd)` → `const skills = loadSkills(cwd, undefined, settings.skills)`
- line 66：`buildSystemPrompt(cwd, undefined, skills)` → `buildSystemPrompt(cwd, undefined, skills, settings.skills?.listingBudgetChars)`
- line 100：`makeSkillTool(skills, { ... })` 的 deps 对象末尾加：`listingBudgetChars: settings.skills?.listingBudgetChars,`

（`settings` 在 headless line 37 `const settings = loadSettings()` 已可用。）

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/headless.skill.test.ts`
Expected: PASS。

- [ ] **Step 6: 全量测试 + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: 全绿（已知 EPIPE flaky 不计失败、vitest exit 0）；typecheck/build 干净。

- [ ] **Step 7: 提交**

```bash
git add src/tui/useChat.ts src/headless.ts test/headless.skill.test.ts
git commit -m "feat(skills): useChat/headless 接线 settings.skills（sources/deny/预算）"
```

---

## Self-Review

**1. Spec coverage：**
- spec §2 `Settings.skills` + `parseSkillsConfig` → Task 1 ✓
- spec §3 `loadSkills` sources/deny/priority → Task 2 ✓
- spec §4 `formatSkillListing` 预算截断 → Task 3 ✓
- spec §5 接线（prompt/skill 两处复用 + useChat/headless 传参）→ Task 4（prompt/skill）+ Task 5（useChat/headless）✓
- spec §6 测试计划逐条覆盖：parseSkillsConfig（T1）、loadSkills config（T2）、formatSkillListing（T3）、prompt（T4）、skill（T4）、deny 端到端（T5）✓

**2. Placeholder scan：** Task 5 Step 1 的 headless 测试因依赖该文件现有 mock 结构，给了「对齐现有约定」的实现者注记而非僵化代码——这是有意的（该测试文件的 mock 形态需实现者按现状选择），其余步骤均含完整代码。

**3. Type consistency：**
- `SkillsConfig`（config.ts，T1）↔ `loadSkills(cwd, home?, config?: SkillsConfig)`（T2）↔ useChat/headless 传 `settings.skills`（T5）✓
- `SkillDefinition.priority: number`（T2）↔ `formatSkillListing` 排序读 `priority`（T3）✓
- `formatSkillListing(skills, { budgetChars })`（T3）↔ prompt/skill 调用（T4）✓
- `buildSystemPrompt(..., budgetChars?)`（T4）↔ useChat/headless 传 `settings.skills?.listingBudgetChars`（T5）✓
- `makeSkillTool` deps `listingBudgetChars?`（T4）↔ useChat/headless 传参（T5）✓

无遗漏、无类型漂移。
