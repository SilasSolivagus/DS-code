# TUI 批 · 计划 1：权限集成架构（1.4 Plan mode + 5.9 工作目录围栏）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 deepcode 加 plan 只读权限模式（1.4，含 ExitPlanMode 工具 + 写盘计划底座 + 审批 + allowedPrompts→规则）与工作目录围栏（5.9，cwd∪白名单外路径降级 ask + /add-dir），两者共享 `checkPermission` 同一段门序。

**Architecture:** 在 `checkPermission`（permissions.ts:192-258）的 deny 门（:201-215，不动）之后、isReadOnly 早返（:216）之前，插入两道新门：plan 门（plan 模式非只读一律拒）、围栏门（路径在外→ask）。围栏判定抽到新纯函数模块 `src/workspace.ts`；ExitPlanMode 为新工具；plan 文件路径复用 memdir 的 projectKey 机制。deny 始终最高优先、绝不被围栏/plan 凌驾。

**Tech Stack:** TypeScript/ESM、zod、vitest、ink5（TUI 部分）。

## Global Constraints
- 语言/运行时：TypeScript + ESM（import 带 `.js` 扩展名）。
- 测试：vitest，命令 `npm test`（全量）/ `npx vitest run <file>`（单文件）。类型检查 `npx tsc --noEmit`，构建 `npm run build`。
- **deny 不可击穿（红线）**：禁止任何改动触碰 permissions.ts:201-215 deny 早返段；围栏/plan 门只放宽「问不问」，deny 决定「能不能」，两套正交。
- **门序**：deny 门(201-215) → [新] plan 门 → [新] 围栏门 → isReadOnly 早返(216) → 原链不变。
- **新写工具同步**：ExitPlanMode 加入 `GLOBAL_SUBAGENT_DENY`（agentTypes.ts:19）+ 更新 `agent.test`/`tools.registry.test` 工具计数断言。
- 中文注释/文案风格对齐现有代码。
- 架构件：本计划完成后整体 opus 终审（新权限门 + deny 正交性 + :219 短路绕过 + plan×forceAsk）。

---

## 文件结构
- 新建 `src/workspace.ts`：`isInsideWorkspace(p, roots)` 纯函数（围栏判定核心）。
- 新建 `src/tools/exitPlanMode.ts`：ExitPlanMode 工具。
- 修改 `src/permissions.ts`：`PermissionMode` 加 `'plan'`；`PermissionContext` 加 `additionalDirs`；`Tool` 无关；`checkPermission` 插 plan 门 + 围栏门。
- 修改 `src/tools/types.ts`：`Tool` 加可选 `workspacePaths(input, cwd)`。
- 修改 `src/tools/{read,edit,write,glob,grep}.ts`：各加 `workspacePaths`。
- 修改 `src/memdir/paths.ts`：加 `planDirFor(cwd, home)`。
- 修改 `src/tools/agentTypes.ts`：`GLOBAL_SUBAGENT_DENY` 加 `'ExitPlanMode'`。
- 修改 `src/tools/index.ts`：注册 `exitPlanModeTool`。
- 修改 `src/prompt.ts`：plan 模式系统提示段（按需，见 Task 8）。
- 修改 `src/tui/useChat.ts`：`/plan` 命令 + Shift+Tab 三态 + `/add-dir` 命令 + additionalDirs 会话状态 + ExitPlanMode 审批接线（pc 构造注入 additionalDirs/plan mode）。
- 测试：`test/workspace.test.ts`、`test/permissions.plan.test.ts`、`test/permissions.fence.test.ts`、`test/tools/exitPlanMode.test.ts`、`test/memdir.plandir.test.ts`、既有 `test/agent.test.ts`/`test/tools.registry.test.ts` 更新。

---

## Task 1：PermissionMode 加 'plan' + plan 门

**Files:**
- Modify: `src/permissions.ts:70`（PermissionMode）、`:215-216`（插 plan 门）
- Test: `test/permissions.plan.test.ts`

**Interfaces:**
- Produces: `PermissionMode = 'default'|'acceptEdits'|'yolo'|'plan'`；`checkPermission` 在 plan 模式对非只读工具返回 `{ok:false, reason}`。

- [ ] **Step 1: 写失败测试**

```ts
// test/permissions.plan.test.ts
import { describe, it, expect } from 'vitest'
import { checkPermission, type PermissionContext } from '../src/permissions.js'
import { writeTool } from '../src/tools/write.js'
import { readTool } from '../src/tools/read.js'
import { bashTool } from '../src/tools/bash.js'

const basePc = (over: Partial<PermissionContext> = {}): PermissionContext => ({
  mode: 'plan', rules: [], saveRule: () => {}, ask: async () => 'no', ...over,
})

describe('plan 门', () => {
  it('plan 模式拒绝非只读工具（Write）', async () => {
    const r = await checkPermission(writeTool, { file_path: 'a.txt', content: 'x' }, basePc())
    expect(r.ok).toBe(false)
  })
  it('plan 模式放行只读工具（Read）', async () => {
    const r = await checkPermission(readTool, { file_path: 'a.txt' }, basePc({ cwd: process.cwd() }))
    expect(r.ok).toBe(true)
  })
  it('plan 模式 + 触发 deny 的非只读 Bash → 拒，不落 ask', async () => {
    let asked = false
    const r = await checkPermission(
      bashTool, { command: 'cat ~/.ssh/id_rsa' },
      basePc({ deny: ['**/id_rsa'], ask: async () => { asked = true; return 'yes' } }),
    )
    expect(r.ok).toBe(false)
    expect(asked).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run test/permissions.plan.test.ts`
Expected: FAIL（plan 模式 Write 当前会落到 ask 返回 'no' 巧合 ok:false，但 Read 在 plan 模式应 ok:true 已过；关键 `cat ~/.ssh/id_rsa` 在 plan 模式当前 forceAsk→落 ask→asked=true，断言 `asked===false` FAIL）

- [ ] **Step 3: 实现 PermissionMode + plan 门**

`src/permissions.ts:70` 改：
```ts
export type PermissionMode = 'default' | 'acceptEdits' | 'yolo' | 'plan'
```
在 deny 门块之后（permissions.ts:215 `}` 之后、:216 `if (tool.isReadOnly ...` 之前）插入：
```ts
  // [新] plan 门：plan 模式非只读一律拒（不带 !forceAsk——严于 deny 降级 ask；deny 已在上方优先处理）
  if (pc.mode === 'plan' && !tool.isReadOnly) {
    const reason = 'plan 模式为只读，需先退出 plan 模式（ExitPlanMode）'
    await hooks?.onDenied?.(tool.name, tool.needsPermission(input) || tool.name, reason)
    return { ok: false, reason, decisionReason: { type: 'other', reason: 'plan 模式只读' } }
  }
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run test/permissions.plan.test.ts`
Expected: PASS（3 测试）

- [ ] **Step 5: 提交**

```bash
git add src/permissions.ts test/permissions.plan.test.ts
git commit -m "feat(1.4): PermissionMode 加 plan + checkPermission plan 只读门"
```

---

## Task 2：workspace.ts 围栏判定纯函数

**Files:**
- Create: `src/workspace.ts`
- Test: `test/workspace.test.ts`

**Interfaces:**
- Produces: `isInsideWorkspace(p: string, roots: string[]): boolean` —— p 为绝对路径；roots 为绝对根目录列表；p 是某 root 自身或后代（无 `..` 逃逸）返回 true。

- [ ] **Step 1: 写失败测试**

```ts
// test/workspace.test.ts
import { describe, it, expect } from 'vitest'
import { isInsideWorkspace } from '../src/workspace.js'

describe('isInsideWorkspace', () => {
  it('cwd 内的文件 → true', () => {
    expect(isInsideWorkspace('/proj/src/a.ts', ['/proj'])).toBe(true)
  })
  it('root 自身 → true', () => {
    expect(isInsideWorkspace('/proj', ['/proj'])).toBe(true)
  })
  it('cwd 外 → false', () => {
    expect(isInsideWorkspace('/etc/passwd', ['/proj'])).toBe(false)
  })
  it('命中白名单第二个 root → true', () => {
    expect(isInsideWorkspace('/extra/x.ts', ['/proj', '/extra'])).toBe(true)
  })
  it('前缀相同但非子目录（/proj-evil）→ false', () => {
    expect(isInsideWorkspace('/proj-evil/x', ['/proj'])).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run test/workspace.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/workspace.ts
import path from 'node:path'

/** p（绝对路径）是否在某个 root（绝对目录）之内（含 root 自身、后代；无 .. 逃逸）。 */
export function isInsideWorkspace(p: string, roots: string[]): boolean {
  const abs = path.resolve(p)
  return roots.some(root => {
    const rel = path.relative(path.resolve(root), abs)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run test/workspace.test.ts`
Expected: PASS（5 测试）

- [ ] **Step 5: 提交**

```bash
git add src/workspace.ts test/workspace.test.ts
git commit -m "feat(5.9): workspace.ts isInsideWorkspace 围栏判定纯函数"
```

---

## Task 3：Tool.workspacePaths 接口 + 文件工具实现

**Files:**
- Modify: `src/tools/types.ts:44-45`（Tool 加 workspacePaths）
- Modify: `src/tools/{read,edit,write,glob,grep}.ts`（各加 workspacePaths）
- Test: `test/workspace.tools.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `Tool.workspacePaths?(input, cwd): string[]` —— 返回本次调用要访问的绝对路径集（围栏门用）。Read/Edit/Write 返回 `[resolve(cwd, file_path)]`；Glob/Grep 返回 `[resolve(cwd, input.path ?? '')]`（搜索根）。

- [ ] **Step 1: 写失败测试**

```ts
// test/workspace.tools.test.ts
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { writeTool } from '../src/tools/write.js'
import { readTool } from '../src/tools/read.js'
import { globTool } from '../src/tools/glob.js'

describe('workspacePaths', () => {
  it('Write 返回解析后的 file_path', () => {
    expect(writeTool.workspacePaths!({ file_path: 'a.txt', content: '' }, '/proj')).toEqual([path.resolve('/proj', 'a.txt')])
  })
  it('Read 返回解析后的 file_path', () => {
    expect(readTool.workspacePaths!({ file_path: 'b.ts' }, '/proj')).toEqual([path.resolve('/proj', 'b.ts')])
  })
  it('Glob 返回搜索根（默认 cwd）', () => {
    expect(globTool.workspacePaths!({ pattern: '**/*.ts' }, '/proj')).toEqual([path.resolve('/proj')])
  })
  it('Glob 返回搜索根（指定 path）', () => {
    expect(globTool.workspacePaths!({ pattern: '*', path: 'sub' }, '/proj')).toEqual([path.resolve('/proj', 'sub')])
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run test/workspace.tools.test.ts`
Expected: FAIL（workspacePaths 未定义）

- [ ] **Step 3: 实现**

`src/tools/types.ts` 在 `deniablePaths?` 之后加：
```ts
  /** 本次调用会访问的绝对路径集（工作目录围栏用）。文件工具实现之；无则不参与围栏。 */
  workspacePaths?(input: z.infer<S>, cwd: string): string[]
```
`src/tools/write.ts` 在 `deniablePaths` 后加：
```ts
  workspacePaths: (input, cwd) => [path.resolve(cwd, input.file_path)],
```
`src/tools/read.ts`、`src/tools/edit.ts`：同款（用各自 input 的 file_path 字段；`import path` 若缺则补）：
```ts
  workspacePaths: (input, cwd) => [path.resolve(cwd, input.file_path)],
```
`src/tools/glob.ts`、`src/tools/grep.ts`：用搜索根：
```ts
  workspacePaths: (input, cwd) => [input.path ? path.resolve(cwd, input.path) : path.resolve(cwd)],
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run test/workspace.tools.test.ts`
Expected: PASS（4 测试）

- [ ] **Step 5: 提交**

```bash
git add src/tools/types.ts src/tools/read.ts src/tools/edit.ts src/tools/write.ts src/tools/glob.ts src/tools/grep.ts test/workspace.tools.test.ts
git commit -m "feat(5.9): Tool.workspacePaths 接口 + 文件工具实现"
```

---

## Task 4：checkPermission 围栏门 + PermissionContext.additionalDirs

**Files:**
- Modify: `src/permissions.ts:99-108`（PermissionContext 加 additionalDirs）、plan 门之后插围栏门
- Test: `test/permissions.fence.test.ts`

**Interfaces:**
- Consumes: `isInsideWorkspace`（Task 2）、`Tool.workspacePaths`（Task 3）
- Produces: `PermissionContext.additionalDirs?: string[]`；围栏门：路径在 cwd∪additionalDirs 外 → `pc.ask`（yolo 旁路；只读工具也走此 ask，不被 :216/:219 短路；deny 仍最优先）。

- [ ] **Step 1: 写失败测试**

```ts
// test/permissions.fence.test.ts
import { describe, it, expect } from 'vitest'
import { checkPermission, type PermissionContext } from '../src/permissions.js'
import { readTool } from '../src/tools/read.js'
import { writeTool } from '../src/tools/write.js'

const pc = (over: Partial<PermissionContext> = {}): PermissionContext => ({
  mode: 'default', rules: [], saveRule: () => {}, ask: async () => 'no', cwd: '/proj', ...over,
})

describe('工作目录围栏', () => {
  it('cwd 内只读放行，不问', async () => {
    let asked = false
    const r = await checkPermission(readTool, { file_path: '/proj/a.ts' }, pc({ ask: async () => { asked = true; return 'yes' } }))
    expect(r.ok).toBe(true); expect(asked).toBe(false)
  })
  it('cwd 外只读 → 问（绕过 isReadOnly/desc===false 短路）', async () => {
    let asked = false
    const r = await checkPermission(readTool, { file_path: '/etc/passwd' }, pc({ ask: async () => { asked = true; return 'no' } }))
    expect(asked).toBe(true); expect(r.ok).toBe(false)
  })
  it('cwd 外但在白名单内 → 放行', async () => {
    const r = await checkPermission(readTool, { file_path: '/extra/x.ts' }, pc({ additionalDirs: ['/extra'] }))
    expect(r.ok).toBe(true)
  })
  it('yolo 旁路围栏', async () => {
    let asked = false
    const r = await checkPermission(readTool, { file_path: '/etc/passwd' }, pc({ mode: 'yolo', ask: async () => { asked = true; return 'no' } }))
    expect(r.ok).toBe(true); expect(asked).toBe(false)
  })
  it('deny 路径即便在白名单内仍硬拒（deny 不可击穿）', async () => {
    const r = await checkPermission(writeTool, { file_path: '/proj/.ssh/id_rsa', content: 'x' }, pc({ deny: ['**/id_rsa'] }))
    expect(r.ok).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run test/permissions.fence.test.ts`
Expected: FAIL（cwd 外只读当前 :216/:219 直接 ok:true，asked=false → 第二测试 FAIL）

- [ ] **Step 3: 实现**

`src/permissions.ts` PermissionContext 加字段（:108 前）：
```ts
  /** 工作目录围栏白名单（/add-dir 注入，会话内）。cwd 与这些目录之外的路径触发 ask。 */
  additionalDirs?: string[]
```
顶部 import：
```ts
import { isInsideWorkspace } from './workspace.js'
```
在 plan 门之后、`if (tool.isReadOnly ...` (:216) 之前插围栏门：
```ts
  // [新] 工作目录围栏：tool 工作路径在 cwd∪白名单外 → 问用户。
  // 必须在 isReadOnly 早返(下一行)之前——否则 Read/Glob/Grep 被 :219 desc===false 短路放行，围栏失效。
  // yolo 旁路；deny 已在最上方优先处理（围栏不凌驾 deny）。
  if (pc.mode !== 'yolo' && tool.workspacePaths) {
    const roots = [pc.cwd ?? process.cwd(), ...(pc.additionalDirs ?? [])]
    const outside = tool.workspacePaths(input as any, pc.cwd ?? process.cwd()).find(p => !isInsideWorkspace(p, roots))
    if (outside) {
      const fenceDesc = tool.needsPermission(input) || `访问工作目录外的路径：${outside}`
      const d = await pc.ask(tool.name, fenceDesc)
      if (d === 'no') {
        await hooks?.onDenied?.(tool.name, fenceDesc, '路径在工作目录外，用户拒绝')
        return { ok: false, reason: '路径在工作目录外，用户拒绝', decisionReason: { type: 'other', reason: '工作目录围栏' } }
      }
      return { ok: true } // yes/always：放行本次（围栏是路径维度，不写规则）
    }
  }
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run test/permissions.fence.test.ts`
Expected: PASS（5 测试）。再跑 `npx vitest run test/permissions.plan.test.ts` 确认 plan 门仍过。

- [ ] **Step 5: 提交**

```bash
git add src/permissions.ts test/permissions.fence.test.ts
git commit -m "feat(5.9): checkPermission 工作目录围栏门 + additionalDirs"
```

---

## Task 5：planDirFor 路径助手

**Files:**
- Modify: `src/memdir/paths.ts`（加 planDirFor）
- Test: `test/memdir.plandir.test.ts`

**Interfaces:**
- Produces: `planDirFor(cwd: string, home?: string): string` —— 返回 `<home>/.deepcode/projects/<sanitizeProjectKey(gitRoot??cwd)>/plans`。

- [ ] **Step 1: 写失败测试**

```ts
// test/memdir.plandir.test.ts
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { planDirFor } from '../src/memdir/paths.js'

describe('planDirFor', () => {
  it('非 git 目录用 cwd 键 + plans 子目录', () => {
    const d = planDirFor('/tmp/nogit-xyz', '/home/u')
    expect(d).toBe(path.join('/home/u', '.deepcode', 'projects', 'tmp-nogit-xyz', 'plans'))
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run test/memdir.plandir.test.ts`
Expected: FAIL（planDirFor 未导出）

- [ ] **Step 3: 实现**

`src/memdir/paths.ts` 末尾加：
```ts
/** plan 文件目录：项目键同 memdir（git root，非 git fallback cwd）+ plans 子目录。 */
export function planDirFor(cwd: string, home: string = os.homedir()): string {
  const key = sanitizeProjectKey(findGitRoot(cwd) ?? path.resolve(cwd))
  return path.join(projectsBase(home), key, 'plans')
}
```
（`projectsBase`/`sanitizeProjectKey`/`findGitRoot` 已在同文件，无需 import。）

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run test/memdir.plandir.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/memdir/paths.ts test/memdir.plandir.test.ts
git commit -m "feat(1.4): planDirFor 计划文件目录助手"
```

---

## Task 6：ExitPlanMode 工具（写盘底座 + 输出 filePath）

**Files:**
- Create: `src/tools/exitPlanMode.ts`
- Modify: `src/tools/agentTypes.ts:19`（GLOBAL_SUBAGENT_DENY 加 'ExitPlanMode'）、`src/tools/index.ts`（注册）
- Test: `test/tools/exitPlanMode.test.ts`、更新 `test/agent.test.ts`/`test/tools.registry.test.ts`

**Interfaces:**
- Consumes: `planDirFor`（Task 5）
- Produces: `exitPlanModeTool: Tool`（`isReadOnly:true`）。输入 `{ plan: string; allowedPrompts?: {tool:'Bash'; prompt:string}[] }`。`call` 写盘 `planDirFor(cwd)/<sessionId??'plan'>.md`，返回 JSON 字符串 `{plan, isAgent:false, filePath}`。批准/setMode/allowedPrompts→规则由 TUI 层接（Task 9），工具本身只持久化 + 透传 plan。

- [ ] **Step 1: 写失败测试**

```ts
// test/tools/exitPlanMode.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exitPlanModeTool } from '../../src/tools/exitPlanMode.js'
import type { ToolContext } from '../../src/tools/types.js'

let home: string
const ctx = (cwd: string, sessionId?: string): ToolContext => ({
  cwd: () => cwd, setCwd: () => {}, signal: new AbortController().signal,
  fileState: new Map(), sessionId: () => sessionId,
} as unknown as ToolContext)

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-plan-')) })
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

describe('ExitPlanMode', () => {
  it('isReadOnly + needsPermission false', () => {
    expect(exitPlanModeTool.isReadOnly).toBe(true)
    expect(exitPlanModeTool.needsPermission({ plan: 'x' })).toBe(false)
  })
  it('写盘计划文件并返回含 filePath 的 JSON', async () => {
    const cwd = fs.mkdtempSync(path.join(home, 'proj-'))
    // 用 HOME 覆盖让 planDirFor 落到临时目录
    const orig = process.env.HOME; process.env.HOME = home
    try {
      const out = await exitPlanModeTool.call({ plan: '# 计划\n步骤一' }, ctx(cwd, 'sess1'))
      const parsed = JSON.parse(out)
      expect(parsed.plan).toBe('# 计划\n步骤一')
      expect(parsed.isAgent).toBe(false)
      expect(fs.existsSync(parsed.filePath)).toBe(true)
      expect(fs.readFileSync(parsed.filePath, 'utf8')).toBe('# 计划\n步骤一')
      expect(parsed.filePath.endsWith(path.join('plans', 'sess1.md'))).toBe(true)
    } finally { process.env.HOME = orig }
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run test/tools/exitPlanMode.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/tools/exitPlanMode.ts
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import type { Tool } from './types.js'
import { planDirFor } from '../memdir/paths.js'

const schema = z.object({
  plan: z.string().describe('给用户审批的实施计划（markdown）'),
  allowedPrompts: z.array(z.object({
    tool: z.literal('Bash'),
    prompt: z.string(),
  })).optional().describe('批准计划时一并放行的 Bash 语义操作（如 "run tests"）'),
})

export const exitPlanModeTool: Tool<typeof schema> = {
  name: 'ExitPlanMode',
  description:
    '在 plan 模式下写完计划、准备请用户批准时调用此工具。会把计划展示给用户审批；批准后退出 plan 模式开始执行。只在 plan 模式可用。',
  inputSchema: schema,
  isReadOnly: true,
  needsPermission: () => false,
  async call(input, ctx) {
    // 写盘计划作团队/云前向底座（未来 leader 审批 / cloud resume 回填的接入点）；当前仅持久化。
    const dir = planDirFor(ctx.cwd())
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, `${ctx.sessionId?.() ?? 'plan'}.md`)
    fs.writeFileSync(filePath, input.plan)
    return JSON.stringify({ plan: input.plan, isAgent: false, filePath })
  },
}
```
`src/tools/agentTypes.ts:19` 改：
```ts
export const GLOBAL_SUBAGENT_DENY = ['Edit', 'Write', 'Agent', 'NotebookEdit', 'ExitPlanMode']
```
`src/tools/index.ts`：import + 加入 allTools：
```ts
import { exitPlanModeTool } from './exitPlanMode.js'
export const allTools: Tool<any>[] = [readTool, globTool, grepTool, bashTool, editTool, writeTool, notebookEditTool, configTool, exitPlanModeTool]
```

- [ ] **Step 4: 运行测试，确认通过 + 更新计数断言**

Run: `npx vitest run test/tools/exitPlanMode.test.ts`
Expected: PASS（2 测试）
然后跑全量找出被工具计数/列表断言卡住的测试：
Run: `npx vitest run test/tools.registry.test.ts test/agent.test.ts`
Expected: 可能 FAIL（allTools 从 8→9；子代理工具集断言）。按实际把期望计数 +1、断言 `GLOBAL_SUBAGENT_DENY` 含 'ExitPlanMode'、子代理工具列表不含 ExitPlanMode。改完重跑至 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/tools/exitPlanMode.ts src/tools/agentTypes.ts src/tools/index.ts test/tools/exitPlanMode.test.ts test/tools.registry.test.ts test/agent.test.ts
git commit -m "feat(1.4): ExitPlanMode 工具（写盘底座）+ GLOBAL_SUBAGENT_DENY + 注册"
```

---

## Task 7：plan 模式系统提示段

**Files:**
- Modify: `src/prompt.ts`（plan 模式指引——见说明）
- Test: `test/prompt.plan.test.ts`

**说明：** `buildSystemPrompt`（prompt.ts:34）整会话静态、不随 mode 变。plan 指引不能塞进静态 system prompt（会污染非 plan 会话 + 破缓存）。改为**导出一个常量字符串** `PLAN_MODE_GUIDANCE`，由 loop/useChat 在进入 plan 模式时作为 `<system-reminder>` 注入（与现有 reminder 注入机制一致），退出时不再注入。本 Task 只产出常量 + 单测；注入接线在 Task 9（TUI）。

**Interfaces:**
- Produces: `export const PLAN_MODE_GUIDANCE: string`（prompt.ts）。

- [ ] **Step 1: 写失败测试**

```ts
// test/prompt.plan.test.ts
import { describe, it, expect } from 'vitest'
import { PLAN_MODE_GUIDANCE } from '../src/prompt.js'

describe('PLAN_MODE_GUIDANCE', () => {
  it('包含 plan 模式核心指引', () => {
    expect(PLAN_MODE_GUIDANCE).toContain('plan')
    expect(PLAN_MODE_GUIDANCE).toContain('ExitPlanMode')
    expect(PLAN_MODE_GUIDANCE.length).toBeGreaterThan(40)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run test/prompt.plan.test.ts`
Expected: FAIL（未导出）

- [ ] **Step 3: 实现**

`src/prompt.ts` 加导出：
```ts
/** plan 模式指引：进入 plan 模式时由 TUI 作为 <system-reminder> 注入，退出时停注。 */
export const PLAN_MODE_GUIDANCE = `你当前处于 plan（计划）模式：只读。先用 Read/Glob/Grep 探索代码、理解现状与约束，写出一份可执行的实施计划；此模式下禁止任何落地修改（不写文件、不跑改动性命令）。计划写好后调用 ExitPlanMode 工具把计划交给用户审批；用户批准后才会退出 plan 模式开始执行。`
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run test/prompt.plan.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/prompt.ts test/prompt.plan.test.ts
git commit -m "feat(1.4): PLAN_MODE_GUIDANCE 计划模式指引常量"
```

---

## Task 8：TUI 接线 —— /plan、/add-dir、Shift+Tab、additionalDirs、ExitPlanMode 审批

**Files:**
- Modify: `src/tui/useChat.ts`（命令分发 + permMode 状态 + additionalDirs 会话状态 + pc 构造注入 + ExitPlanMode 审批 + plan 指引注入）
- Modify: `src/tui/App.tsx`（Shift+Tab 三态键，**先验可达性**）
- Test: 纯逻辑可测处加单测；TUI 交互留真机冒烟（本批统一冒烟）

**说明（实施者必读现有模式）：** useChat.ts 现有：`permMode`（:236 `opts.yolo ? 'yolo' : 'default'`）、`/accept`（:877 default↔acceptEdits toggle）、`/model`（:836-852 命令解析样例）、pc 构造（grep `mode:` / `saveRule` / `additionalDirs` 注入点——pc 在工具执行处构造，把 `permMode` 和新的 `additionalDirs` 状态传进去）。按这些既有样式接线。

- [ ] **Step 1: `/plan` 命令 + permMode 支持 'plan'**
  - `permMode` 状态类型扩到含 `'plan'`（与 PermissionMode 对齐）。
  - 加 `/plan` 命令（仿 :877 `/accept`）：toggle 进/出 plan 模式（进：记 prePlanMode=当前；出：回 prePlanMode）。
  - 进入 plan 模式时把 `PLAN_MODE_GUIDANCE` 作为 `<system-reminder>` 注入（仿现有 reminder 注入），退出停注。

- [ ] **Step 2: pc 构造注入 additionalDirs**
  - 加会话状态 `additionalDirs: string[]`（useState，初始 `[]`）。
  - 在构造 `PermissionContext` 处加 `additionalDirs`，并确认 `mode: permMode` 透传 plan。

- [ ] **Step 3: `/add-dir` 命令**
  - 加 `/add-dir <path>`（仿 :836 `/model` 取参样式）：`path.resolve(cwd, arg)` 加进 `additionalDirs`（去重）；空参或无效路径给提示。不落盘 settings。

- [ ] **Step 4: ExitPlanMode 审批接线**
  - 工具调用返回的是 JSON `{plan,isAgent,filePath}`；loop/useChat 检测 `tool==='ExitPlanMode'` 时：解析 plan → 复用 5.6 `PermissionDialog`（或现有 ask 弹窗）展示计划请求批准。
  - 批准：`setMode` 回 prePlanMode/default；把 `allowedPrompts` 每条 `prompt` 注入 Bash 规则（仿 saveRule，`Bash(<prompt>:*)` 或语义规则——复用现有 saveRule/matchRule 前缀机制）。
  - 拒绝：留在 plan 模式，把拒绝作为反馈消息回灌。

- [ ] **Step 5: App.tsx Shift+Tab 三态（先验可达性）**
  - **第一步写一次性探针**确认 ink `useInput`/`parse-keypress` 能收到 shift+tab（`\x1b[Z`）：临时在 App 的 useInput 里 `if (key.shift && key.tab) log('SHIFTTAB OK')`，真机敲一次确认收到。
  - 可达 → 实现 default→acceptEdits→plan→default 循环（设 permMode）。
  - **不可达 → 删探针、降级仅保留 `/plan` 命令**，本 Task 标注「Shift+Tab 不可达已降级」。

- [ ] **Step 6: 类型检查 + 构建 + 提交**

Run: `npx tsc --noEmit && npm run build`
Expected: 干净
```bash
git add src/tui/useChat.ts src/tui/App.tsx
git commit -m "feat(1.4/5.9): TUI 接线 /plan /add-dir Shift+Tab additionalDirs ExitPlanMode 审批"
```

---

## Task 9：全量回归 + 整体类型检查/构建

**Files:** 无新增
- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全绿（新增 ~20 测试，既有不回归）

- [ ] **Step 2: 类型检查 + 构建**

Run: `npx tsc --noEmit && npm run build`
Expected: 干净

- [ ] **Step 3: 提交（若有收尾修改）**

```bash
git add -A && git commit -m "test(1.4/5.9): 权限集成全量回归绿"
```

---

## 真机冒烟（本计划部分，与计划 2/3 合并一次冒烟）
1. 进 plan 模式（`/plan` 或 Shift+Tab）→ 让模型试图写文件 → 应被拒（plan 只读门）。
2. 模型调 ExitPlanMode → 审批弹窗显示计划 → 批准 → 退出 plan 模式 + 计划落盘 `~/.deepcode/projects/<key>/plans/<sessionId>.md`。
3. allowedPrompts：批准带 `{tool:'Bash',prompt:'run tests'}` 的计划 → 后续 `npm test` 类命令被放行。
4. 围栏：cwd 外 `Read /etc/hosts` → 触发 ask；`/add-dir /etc` 后再 Read → 放行。
5. **deny 不可击穿**：`/add-dir ~` 后让模型 `Read ~/.ssh/id_rsa` → 仍被 deny 硬拒（红线验证）。
6. yolo 模式下围栏旁路。

## Self-Review（写完核对）
- **spec 覆盖**：1.4（plan 门 T1 / ExitPlanMode T6 / 写盘 T6 / allowedPrompts T8 / 系统提示 T7 / Shift+Tab T8）✓；5.9（围栏纯函数 T2 / workspacePaths T3 / 围栏门 T4 / /add-dir T8 / deny 正交 T4）✓。
- **占位扫描**：无 TBD；T8 TUI 步骤给了精确现有样式引用（:236/:877/:836）而非伪代码——TUI 接线依赖读 useChat.ts 现状，属合理。
- **类型一致**：`isInsideWorkspace(p, roots)`、`workspacePaths(input,cwd)`、`additionalDirs`、`PermissionMode 'plan'`、`PLAN_MODE_GUIDANCE`、`planDirFor` 全程一致。
- **门序一致**：deny(201-215)→plan 门→围栏门→isReadOnly(216)，T1/T4 注释一致。
