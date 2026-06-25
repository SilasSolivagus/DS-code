# TUI 权限可见性收口小批 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 deepcode 已有的权限来源层级 + deny 内核能力暴露到 UI——`/permissions` 合并多层视图（allow+deny+来源+按值删），权限弹窗「总是允许」内嵌将保存的规则文本。

**Architecture:** 抽 `suggestRule` 纯函数让规则在 `pc.ask` 前算出、经 `PendingAsk.previewRule` 传入弹窗并在 always label 内嵌（保存复用同一字符串）。`/permissions` 命令重写为合并视图，显示/删除逻辑抽成纯函数（`formatPermissionRules` / `resolveRuleRemoval`）独立测试，config 新增按值删 helper。`ask` 返回值保持 `Decision` 不变→零调用点破坏、双组件接线不触发。

**Tech Stack:** TypeScript/ESM、ink5 TUI、vitest（`npm test` = `vitest run`）、ink-testing-library。

## Global Constraints

- 测试框架 vitest，命令 `npm test`（= `vitest run --passWithNoTests`）；类型检查 `npm run typecheck`；构建 `npm run build`。
- config 测试必须 hermetic：mock `node:os` homedir 到临时目录，**严禁污染真实 `~/.deepcode`**（沿用 test/config.test.ts 模式）。
- `ask` 返回值保持 `Promise<Decision>`，新增参数一律可选——**不得**破坏既有 ask 调用点（permissions.ts:233 围栏 `=== 'no'`）。
- `onDecide` 签名不变——本批**不触发** App.tsx/FullscreenApp.tsx 双组件接线。
- deepcode 既有约定保持不动：规则格式 `Tool(content)`、写 user 层、prefix 前 2 词。
- 提交 trailer：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

---

## File Structure

- `src/permissions.ts`（改）：新增导出 `suggestRule`；主路径用 previewRule；`PermissionContext.ask` 类型加可选第 4 参。
- `src/config.ts`（改）：新增 `listUserDenyRules` / `removeUserAllowRuleByValue` / `removeUserDenyRuleByValue`。
- `src/permissionsView.ts`（新）：纯函数 `formatPermissionRules` + `resolveRuleRemoval`（`/permissions` 显示与删除决策，无 React、可独立测试）。
- `src/tui/useChat.ts`（改）：`/permissions` 命令重写；`PendingAsk` 加 `previewRule`；`ask` 实现加 previewRule 形参。
- `src/tui/components/PermissionDialog.tsx`（改）：always 选项 label 内嵌 previewRule。
- 测试：`test/permissions.suggestRule.test.ts`（新）、`test/config.denyRules.test.ts`（新）、`test/permissionsView.test.ts`（新）、`test/tui.permission.test.tsx`（增）。

---

### Task 1: `suggestRule` 纯函数 + permissions 主路径复用

**Files:**
- Modify: `src/permissions.ts`（抽出 269-278 行规则生成逻辑；改 `ask` 类型 104 行）
- Test: `test/permissions.suggestRule.test.ts`（新）

**Interfaces:**
- Produces: `export function suggestRule(toolName: string, desc: string): string` — Bash 普通命令→`Bash(<前2词>:*)`，高危/复合→`Bash(<整行>)`，非 Bash→`Tool(<整行>)`。
- Produces: `PermissionContext.ask` 类型新增可选第 4 参 `previewRule?: string`，返回值仍 `Promise<Decision>`。

- [ ] **Step 1: 写失败测试**

`test/permissions.suggestRule.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { suggestRule } from '../src/permissions.js'

describe('suggestRule', () => {
  it('Bash 普通命令：前 2 词 + :*', () => {
    expect(suggestRule('Bash', 'npm test -- --watch')).toBe('Bash(npm test:*)')
  })
  it('Bash 高危命令：精确整行', () => {
    expect(suggestRule('Bash', 'rm -rf /tmp/x')).toBe('Bash(rm -rf /tmp/x)')
  })
  it('Bash 复合命令：精确整行', () => {
    expect(suggestRule('Bash', 'npm test && echo done')).toBe('Bash(npm test && echo done)')
  })
  it('非 Bash 工具：精确整行', () => {
    expect(suggestRule('Edit', './src/a.ts')).toBe('Edit(./src/a.ts)')
  })
  it('多行 desc：换行替换为空格', () => {
    expect(suggestRule('Write', 'a\nb')).toBe('Write(a b)')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- permissions.suggestRule`
Expected: FAIL（`suggestRule` is not exported / not a function）

- [ ] **Step 3: 抽出 `suggestRule`**

在 `src/permissions.ts`（紧邻现有 `permissionSourceName` 之后，约 98 行后）新增导出：
```ts
/** 生成「总是允许」将保存的规则（预览与保存共用，单一来源）。deepcode 既有粒度：Bash 普通=前 2 词+:*，高危/复合=精确，非 Bash=精确。 */
export function suggestRule(toolName: string, desc: string): string {
  const firstLine = desc.split('\n')[0]
  const compound = toolName === 'Bash' && splitBashCommand(desc).commands.length > 1
  const pat = toolName === 'Bash'
    ? (isDangerous(desc) || compound)
      ? desc.replace(/\n/g, ' ')
      : firstLine.split(' ').slice(0, 2).join(' ') + ':*'
    : desc.replace(/\n/g, ' ')
  return `${toolName}(${pat})`
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- permissions.suggestRule`
Expected: PASS（5 passed）

- [ ] **Step 5: 主路径复用 + ask 类型加参**

`src/permissions.ts` 改 `PermissionContext.ask` 类型（约 104 行）：
```ts
ask: (toolName: string, desc: string, reason?: PermissionDecisionReason, previewRule?: string) => Promise<Decision>
```
改主路径（现 268-279 行）为：
```ts
  const previewRule = suggestRule(tool.name, desc)
  const decision = await pc.ask(tool.name, desc, askReason, previewRule)
  if (decision === 'always') {
    pc.saveRule(previewRule)
    return { ok: true }
  }
```
（删掉原 269-277 行重算 `firstLine`/`compound`/`pat` 的内联块——逻辑已搬进 `suggestRule`。）

- [ ] **Step 6: 跑全量权限测试 + 类型检查确认无回归**

Run: `npm test -- permissions && npm run typecheck`
Expected: PASS（含既有 permissions.test.ts / permissions.fence.test.ts / permissions.plan.test.ts 全绿；typecheck 无错——3 参 ask 实现仍可赋值给 4 参类型）

- [ ] **Step 7: Commit**

```bash
git add src/permissions.ts test/permissions.suggestRule.test.ts
git commit -m "feat(permissions): 抽 suggestRule 纯函数, 主路径预览复用

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: config.ts 按值删 helper

**Files:**
- Modify: `src/config.ts`（紧邻 `listUserAllowRules` 之后，约 286 行后新增）
- Test: `test/config.denyRules.test.ts`（新，hermetic）

**Interfaces:**
- Produces: `export function listUserDenyRules(): string[]`
- Produces: `export function removeUserAllowRuleByValue(value: string): boolean`（删到返 true，未命中返 false）
- Produces: `export function removeUserDenyRuleByValue(value: string): boolean`

- [ ] **Step 1: 写失败测试**

`test/config.denyRules.test.ts`（照搬 test/config.test.ts 的 node:os mock 头）:
```ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>()
  const { mkdtempSync } = await import('node:fs')
  const path = await import('node:path')
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'dc-deny-'))
  const homedir = () => fakeHome
  return { ...os, homedir, default: { ...os, homedir } }
})

import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { saveRawUserSettings, loadRawUserSettings, listUserDenyRules, removeUserAllowRuleByValue, removeUserDenyRuleByValue } from '../src/config.js'

const settingsFile = path.join(os.homedir(), '.deepcode', 'settings.json')

function seed(allow: string[], deny: string[]) {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
  const s = loadRawUserSettings()
  s.permissions.allow = [...allow]
  s.permissions.deny = [...deny]
  saveRawUserSettings(s)
}

describe('config 按值删 helper（hermetic）', () => {
  it('listUserDenyRules 读 user deny；缺失返回 []', () => {
    seed([], [])
    expect(listUserDenyRules()).toEqual([])
    seed([], ['Bash(rm -rf:*)'])
    expect(listUserDenyRules()).toEqual(['Bash(rm -rf:*)'])
  })
  it('removeUserAllowRuleByValue 命中删返 true, 不误删其它值', () => {
    seed(['Bash(npm test:*)', 'Read(./a)'], [])
    expect(removeUserAllowRuleByValue('Bash(npm test:*)')).toBe(true)
    expect(loadRawUserSettings().permissions.allow).toEqual(['Read(./a)'])
  })
  it('removeUserAllowRuleByValue 未命中返 false', () => {
    seed(['Read(./a)'], [])
    expect(removeUserAllowRuleByValue('Bash(nope)')).toBe(false)
    expect(loadRawUserSettings().permissions.allow).toEqual(['Read(./a)'])
  })
  it('removeUserDenyRuleByValue 命中删返 true；deny 缺失返 false', () => {
    seed([], ['Bash(rm -rf:*)'])
    expect(removeUserDenyRuleByValue('Bash(rm -rf:*)')).toBe(true)
    expect(loadRawUserSettings().permissions.deny ?? []).toEqual([])
    seed([], [])
    expect(removeUserDenyRuleByValue('Bash(x)')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- config.denyRules`
Expected: FAIL（函数未导出）

- [ ] **Step 3: 实现 helper**

`src/config.ts` 在 286 行（`listUserAllowRules` 之后）新增：
```ts
/** 读 user scope deny 列表（/permissions 显示用）。 */
export function listUserDenyRules(): string[] {
  return loadRawUserSettings().permissions.deny ?? []
}

/** 按值从 user scope allow 删除（合并视图索引不对应 user 文件行，故按值）。删到返 true。 */
export function removeUserAllowRuleByValue(value: string): boolean {
  const s = loadRawUserSettings()
  const i = s.permissions.allow.indexOf(value)
  if (i < 0) return false
  s.permissions.allow.splice(i, 1)
  saveRawUserSettings(s)
  return true
}

/** 按值从 user scope deny 删除。删到返 true。 */
export function removeUserDenyRuleByValue(value: string): boolean {
  const s = loadRawUserSettings()
  const deny = s.permissions.deny
  if (!deny) return false
  const i = deny.indexOf(value)
  if (i < 0) return false
  deny.splice(i, 1)
  saveRawUserSettings(s)
  return true
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- config.denyRules`
Expected: PASS（4 passed）

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.denyRules.test.ts
git commit -m "feat(config): 按值删 user allow/deny + listUserDenyRules

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `permissionsView.ts` 纯函数（格式化 + 删除决策）

**Files:**
- Create: `src/permissionsView.ts`
- Test: `test/permissionsView.test.ts`（新）

**Interfaces:**
- Consumes: `PermissionRuleSource`、`permissionSourceName`（from `src/permissions.js`）。
- Produces: `export function formatPermissionRules(allow: string[], ruleSources: Record<string, PermissionRuleSource>, deny: string[], denySources: Record<string, PermissionRuleSource>): string`
- Produces: `export function resolveRuleRemoval(list: string[], index1Based: number, sources: Record<string, PermissionRuleSource>, defaultSource: PermissionRuleSource): { ok: true; value: string } | { ok: false; reason: string }`

- [ ] **Step 1: 写失败测试**

`test/permissionsView.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { formatPermissionRules, resolveRuleRemoval } from '../src/permissionsView.js'

describe('formatPermissionRules', () => {
  it('两段渲染含来源标签 + 操作提示', () => {
    const out = formatPermissionRules(
      ['Bash(npm test:*)', 'Read(./src)'], { 'Bash(npm test:*)': 'user', 'Read(./src)': 'project' },
      ['**/id_rsa', 'Bash(rm -rf:*)'], { '**/id_rsa': 'builtin', 'Bash(rm -rf:*)': 'user' },
    )
    expect(out).toContain('允许规则（Allow）')
    expect(out).toContain('1. Bash(npm test:*) [用户]')
    expect(out).toContain('2. Read(./src) [项目]')
    expect(out).toContain('拒绝规则（Deny）')
    expect(out).toContain('1. **/id_rsa [内置]')
    expect(out).toContain('2. Bash(rm -rf:*) [用户]')
    expect(out).toContain('/permissions rm <编号>')
    expect(out).toContain('deny-rm <编号>')
  })
  it('全空 → 没有已保存的权限规则', () => {
    expect(formatPermissionRules([], {}, [], {})).toContain('没有已保存的权限规则')
  })
  it('来源缺失兜底：allow→用户, deny→内置', () => {
    const out = formatPermissionRules(['Bash(x)'], {}, ['**/y'], {})
    expect(out).toContain('1. Bash(x) [用户]')
    expect(out).toContain('1. **/y [内置]')
  })
})

describe('resolveRuleRemoval', () => {
  const list = ['Bash(a)', 'Read(b)']
  it('用户层规则 → ok + value', () => {
    expect(resolveRuleRemoval(list, 1, { 'Bash(a)': 'user' }, 'user')).toEqual({ ok: true, value: 'Bash(a)' })
  })
  it('非用户层 → 友好提示带来源', () => {
    const r = resolveRuleRemoval(list, 2, { 'Read(b)': 'project' }, 'user')
    expect(r.ok).toBe(false)
    expect((r as any).reason).toContain('项目')
  })
  it('来源缺失走默认 source', () => {
    expect(resolveRuleRemoval(['**/x'], 1, {}, 'builtin').ok).toBe(false)
    expect(resolveRuleRemoval(['Bash(a)'], 1, {}, 'user')).toEqual({ ok: true, value: 'Bash(a)' })
  })
  it('编号越界 → 无效', () => {
    expect(resolveRuleRemoval(list, 0, {}, 'user')).toEqual({ ok: false, reason: '编号无效' })
    expect(resolveRuleRemoval(list, 3, {}, 'user')).toEqual({ ok: false, reason: '编号无效' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- permissionsView`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/permissionsView.ts`**

```ts
// src/permissionsView.ts
// /permissions 命令的显示格式化 + 删除决策（纯函数，无 React，独立可测）。
import { type PermissionRuleSource, permissionSourceName } from './permissions.js'

/** 渲染合并 allow + deny 两段，每行带来源标签 + 操作提示。 */
export function formatPermissionRules(
  allow: string[], ruleSources: Record<string, PermissionRuleSource>,
  deny: string[], denySources: Record<string, PermissionRuleSource>,
): string {
  if (allow.length === 0 && deny.length === 0) return '没有已保存的权限规则'
  const lines: string[] = []
  if (allow.length) {
    lines.push('允许规则（Allow）：')
    allow.forEach((r, i) => lines.push(`  ${i + 1}. ${r} [${permissionSourceName(ruleSources[r] ?? 'user')}]`))
  }
  if (deny.length) {
    if (lines.length) lines.push('')
    lines.push('拒绝规则（Deny）：')
    deny.forEach((p, i) => lines.push(`  ${i + 1}. ${p} [${permissionSourceName(denySources[p] ?? 'builtin')}]`))
  }
  lines.push('')
  lines.push('（/permissions rm <编号> 删 Allow · /permissions deny-rm <编号> 删 Deny；仅能删用户层规则）')
  return lines.join('\n')
}

/** 把「显示编号 → 删除动作」的决策抽成纯函数：仅用户层可删，非用户层返回友好提示。 */
export function resolveRuleRemoval(
  list: string[], index1Based: number,
  sources: Record<string, PermissionRuleSource>, defaultSource: PermissionRuleSource,
): { ok: true; value: string } | { ok: false; reason: string } {
  const value = list[index1Based - 1]
  if (value === undefined) return { ok: false, reason: '编号无效' }
  const src = sources[value] ?? defaultSource
  if (src !== 'user') return { ok: false, reason: `该规则来自${permissionSourceName(src)}，请在对应配置文件修改` }
  return { ok: true, value }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- permissionsView`
Expected: PASS（7 passed）

- [ ] **Step 5: Commit**

```bash
git add src/permissionsView.ts test/permissionsView.test.ts
git commit -m "feat(permissions): permissionsView 纯函数 (格式化+删除决策)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `/permissions` 命令重写（useChat 接线）

**Files:**
- Modify: `src/tui/useChat.ts`（命令处理 1123-1140；import 行 25；孤儿清理）
- 验证：`npm run typecheck` + 真机冒烟（见 Task 6）

**Interfaces:**
- Consumes: `formatPermissionRules`/`resolveRuleRemoval`（Task 3）、`listUserDenyRules`/`removeUserAllowRuleByValue`/`removeUserDenyRuleByValue`（Task 2）、既有 `settings.permissions.allow`/`ruleSources`/`denySources`/`resolveDenyList`。

> 本任务主要是 TUI 命令接线（难纯单测），逻辑已在 Task 2/3 测过。无新单测，靠 typecheck + Task 6 冒烟把关。

- [ ] **Step 1: 改 import（useChat.ts:25-26 区域）**

把 `removeUserAllowRule` 从 `../config.js` 的 import 中**删除**（将被孤儿清理），新增 `listUserDenyRules, removeUserAllowRuleByValue, removeUserDenyRuleByValue`：
```ts
import { loadSettings, loadRawUserSettings, saveRawUserSettings, addUserAllowRule, listUserAllowRules, listUserDenyRules, removeUserAllowRuleByValue, removeUserDenyRuleByValue, SETTINGS_FILE } from '../config.js'
```
顶部新增（与其它 import 同区）：
```ts
import { formatPermissionRules, resolveRuleRemoval } from '../permissionsView.js'
import { resolveDenyList } from '../deny.js'
```
> 注：`resolveDenyList` 若已在 useChat 顶部 import（permission ctx 构造处用过），勿重复；用前 grep `resolveDenyList` 确认。

- [ ] **Step 2: 重写 `/permissions` 命令块（现 useChat.ts:1123-1140）**

替换为：
```ts
    if (line === '/permissions' || line.startsWith('/permissions ')) {
      const arg = line.slice('/permissions'.length).trim()
      const allowList = settings.permissions.allow
      const denyList = resolveDenyList(settings.permissions.deny)
      const rmMatch = arg.match(/^rm\s+(\d+)$/)
      const denyRmMatch = arg.match(/^deny-rm\s+(\d+)$/)
      if (rmMatch) {
        const r = resolveRuleRemoval(allowList, Number(rmMatch[1]), ruleSources, 'user')
        if (r.ok) {
          removeUserAllowRuleByValue(r.value)
          const mem = settings.permissions.allow.indexOf(r.value)
          if (mem >= 0) settings.permissions.allow.splice(mem, 1)
          notice('info', `已删除：${r.value}`)
          fireConfigChange()
        } else notice('warn', r.reason)
      } else if (denyRmMatch) {
        const r = resolveRuleRemoval(denyList, Number(denyRmMatch[1]), denySources, 'builtin')
        if (r.ok) {
          removeUserDenyRuleByValue(r.value)
          if (settings.permissions.deny) {
            const mem = settings.permissions.deny.indexOf(r.value)
            if (mem >= 0) settings.permissions.deny.splice(mem, 1)
          }
          notice('info', `已删除 Deny：${r.value}`)
          fireConfigChange()
        } else notice('warn', r.reason)
      } else {
        notice('info', formatPermissionRules(allowList, ruleSources, denyList, denySources))
      }
      return
    }
```

- [ ] **Step 3: 孤儿清理**

Run: `grep -rn 'removeUserAllowRule\b' src/ test/`
若 `removeUserAllowRule`（index 版，config.ts:275）除其定义+其自身测试外**无其它引用**，则：
- 从 `src/config.ts` 删除 `removeUserAllowRule`（275-281）及其 JSDoc。
- 若 `test/config.test.ts` 仍 import/用它，保留该函数（说明仍被测试引用，非孤儿）——以 grep 结果为准，**不删有引用的函数**。
（`listUserAllowRules` 仍被 Step 2 的展示/其它处使用，保留。）

- [ ] **Step 4: 类型检查 + 全量测试**

Run: `npm run typecheck && npm test`
Expected: PASS（无类型错误；若删了 removeUserAllowRule 则其旧测试也应已随之处理——若 config.test.ts 引用它就别删，见 Step 3）

- [ ] **Step 5: Commit**

```bash
git add src/tui/useChat.ts src/config.ts
git commit -m "feat(permissions): /permissions 合并视图 + deny-rm 按值删

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 弹窗 always label 内嵌规则（PendingAsk + ask 实现 + Dialog）

**Files:**
- Modify: `src/tui/useChat.ts`（`PendingAsk` 接口 166；`ask` 实现 601-610）
- Modify: `src/tui/components/PermissionDialog.tsx`（OPTIONS → 组件内构建）
- Test: `test/tui.permission.test.tsx`（增）

**Interfaces:**
- Consumes: `PendingAsk.previewRule?: string`（ask 实现写入，Task 1 主路径经第 4 参传入）。

- [ ] **Step 1: 写失败测试（增到 test/tui.permission.test.tsx 末尾）**

```tsx
import { PermissionDialog } from '../src/tui/components/PermissionDialog.js'
import { render } from 'ink-testing-library'

describe('PermissionDialog always label 内嵌规则', () => {
  const base = { toolName: 'Bash', desc: 'npm test', dangerous: false, resolve: () => {} }
  it('有 previewRule → always 行显示 "总是允许 — <rule>"', () => {
    const { lastFrame } = render(
      <PermissionDialog ask={{ ...base, previewRule: 'Bash(npm test:*)' } as any} onDecide={() => {}} />,
    )
    expect(lastFrame()).toContain('总是允许 — Bash(npm test:*)')
  })
  it('无 previewRule → 回退原文案', () => {
    const { lastFrame } = render(
      <PermissionDialog ask={base as any} onDecide={() => {}} />,
    )
    expect(lastFrame()).toContain('总是允许（本会话不再询问）')
  })
})
```
> 注：`test/tui.permission.test.tsx` 顶部若已 import `React`/`render`/`PermissionDialog` 则勿重复 import（用前看文件头）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tui.permission`
Expected: FAIL（previewRule 未渲染 / `总是允许 — ` 文案不存在）

- [ ] **Step 3: `PendingAsk` 加字段（useChat.ts:166）**

```ts
export interface PendingAsk { toolName: string; desc: string; dangerous: boolean; reason?: PermissionDecisionReason; previewRule?: string; resolve: (d: Decision) => void }
```

- [ ] **Step 4: `ask` 实现加形参 + 写入（useChat.ts:601 + 610）**

601 行签名改：
```ts
  const ask = (toolName: string, desc: string, reason?: PermissionDecisionReason, previewRule?: string): Promise<Decision> =>
```
610 行 pendingAsk 赋值加 `previewRule`：
```ts
      pendingAsk = { toolName, desc, dangerous: isDangerous(desc), reason, previewRule, resolve: res }
```

- [ ] **Step 5: PermissionDialog 组件内构建 options（PermissionDialog.tsx）**

删模块级 `const OPTIONS = [...]`（10-14 行），在组件内 `preview` 之后构建：
```tsx
  const alwaysLabel = ask.previewRule ? `总是允许 — ${ask.previewRule}` : '总是允许（本会话不再询问）'
  const options: Array<{ label: string; decision: Decision }> = [
    { label: '允许', decision: 'yes' },
    { label: alwaysLabel, decision: 'always' },
    { label: '拒绝', decision: 'no' },
  ]
```
把原 3 处 `OPTIONS` 引用（useInput 的 31/32 行 + 渲染 62 行 map）改为 `options`：
- `setIdx(i => Math.min(options.length - 1, i + 1))`
- `onDecide(options[idx].decision)`
- `{options.map((opt, i) => (`

- [ ] **Step 6: 跑测试确认通过 + 全量**

Run: `npm test -- tui.permission && npm run typecheck`
Expected: PASS（含原 buildPreview 测试 + 2 新用例）

- [ ] **Step 7: Commit**

```bash
git add src/tui/useChat.ts src/tui/components/PermissionDialog.tsx test/tui.permission.test.tsx
git commit -m "feat(permissions): 弹窗 always label 内嵌将保存的规则

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 全量回归 + 真机冒烟

**Files:** 无代码改动（除冒烟揪出的修复）

- [ ] **Step 1: 全量测试 + 构建**

Run: `npm test && npm run typecheck && npm run build`
Expected: 全绿（测试数 = 原基线 + suggestRule 5 + denyRules 4 + permissionsView 7 + dialog 2）

- [ ] **Step 2: 真机冒烟准备**

构建后用真实 TUI（默认全屏 FullscreenApp）。冒烟配置文件**放家目录**（如 `~/dc-smoke-settings.json`），**勿放 harness scratchpad**（沙箱私有，终端读不到）。预置一条 user allow + 一条 project allow（经 `--settings` flag 或 `~/.deepcode`）+ 默认内置 deny。

- [ ] **Step 3: 冒烟用例**

1. `/permissions` → 显示 Allow 段（用户/项目规则带 `[用户]`/`[项目]`）+ Deny 段（内置规则带 `[内置]`）。
2. `/permissions rm <用户 allow 编号>` → `已删除：...`，再 `/permissions` 确认消失。
3. `/permissions rm <项目 allow 编号>` → `该规则来自项目设置，请在对应配置文件修改`（不删）。
4. `/permissions deny-rm <内置 deny 编号>` → 走警告（内置不可删）。
5. 触发一个需确认的普通工具（如 Bash `npm test`）→ 弹窗「总是允许」行显示 `总是允许 — Bash(npm test:*)`。

- [ ] **Step 4: 冒烟通过后无需额外提交**（除非揪出修复，则单独 commit）

---

## Self-Review

**1. Spec coverage（2 件）：**
- §3.1 suggestRule → Task 1 ✓；§3.2 ask previewRule 通道 + 主路径 → Task 1（类型/主路径）+ Task 5（PendingAsk/ask 实现）✓；§3.3 弹窗 always label → Task 5 ✓；§3.4 /permissions 合并视图 → Task 3（格式化/删除决策）+ Task 4（命令接线）✓；§3.5 config helper → Task 2 ✓。§5 测试策略 → 各 Task 的 TDD + Task 6 冒烟 ✓。
- 砍掉的 item 3（forceAsk allow 来源行）：plan 无对应 Task ✓（一致）。

**2. Placeholder scan：** 无 TBD/TODO；每个代码 step 含完整代码；每个测试 step 含完整断言。✓

**3. Type consistency：**
- `suggestRule(toolName, desc): string` — Task 1 定义、Task 1 主路径调用一致。
- `PermissionContext.ask` 4 参 `previewRule?` — Task 1 改类型、Task 5 改实现签名一致。
- `formatPermissionRules` / `resolveRuleRemoval` 签名 — Task 3 定义、Task 4 调用参数一致（allowList/ruleSources/denyList/denySources、index 为 1-based、defaultSource 'user'/'builtin'）。
- config helper 名 `listUserDenyRules`/`removeUserAllowRuleByValue`/`removeUserDenyRuleByValue` — Task 2 定义、Task 4 import 一致。
- `PendingAsk.previewRule?` — Task 5 接口、ask 实现、Dialog 消费一致。
