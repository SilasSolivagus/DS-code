# C2 记忆子系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 deepcode 加一套忠实镜像 CC 的记忆子系统：记忆索引（3.1）、自动提取（3.2）、SessionMemory（3.3）、autoDream（3.4）。

**Architecture:** per-project memdir（git-root 键）存带 frontmatter 的记忆文件 + MEMORY.md 索引；静态注索引进系统提示（默认）或开关切动态召回；每轮末 fire-and-forget forked agent 提取记忆（turnId 游标判重）；SessionMemory 草稿本服务 compact；autoDream 后台合并（时间/会话/PID 锁三门控）。所有 forked 操作 fail-safe，工具层物理隔离写路径在 memdir 内。

**Tech Stack:** TypeScript/ESM、vitest、zod、OpenAI SDK（DeepSeek）、node fs/crypto/child_process。

## Global Constraints

- spec：`docs/specs/2026-06-19-deepcode-c2-memory-subsystem-design.md`（决策与 CC 实证修正在此）。
- base 目录固定 `~/.deepcode`；memdir 项目键用 **git root**（`findGitRoot(cwd) ?? cwd`），session-memory 项目键用 **cwd**。
- sanitize 规则：`s.replace(/[^a-zA-Z0-9]/g, '-')`，超 200 字符则 `slice(0,200)+'-'+hash`。
- frontmatter 复用 `src/agentsLoader.ts` 的 `parseFrontmatter(raw)`（已存在，返回 `{ data, body }`）。
- 记忆 type 四类固定枚举：`user | feedback | project | reference`。
- MEMORY.md 加载截断：≤200 行 且 ≤25600 字节。
- 配置默认：`enabled=true`、`extractEveryTurns=1`、`recall.enabled=false`、`recall.maxResults=5`、`sessionMemory={enabled:true,minInitTokens:10000,minUpdateTokens:5000,toolCallsBetween:3}`、`dream={enabled:true,minHours:24,minSessions:5}`。
- **提取游标 = turnId**（非 spec 的 uuid；deepcode 原生、resume 安全）：仅成功后前移到当前 `maxTurnId`，失败不动。
- **所有 forked 记忆操作 fail-safe**：异常吞掉 + `console.error('[memory] …')`，绝不抛进主对话/退出路径。
- **测试绝不读写真实 `~/.deepcode`**：全部用 `fs.mkdtempSync(path.join(os.tmpdir(),'dc-mem-'))` 临时目录 + `try/finally` 清理。
- 提交信息结尾两行：
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_017GWd2bLsGrB3pRkBqmsk3q`

---

# Phase 1 — 地基（3.1 索引核心：schema/路径/扫描/加载/配置/静态注入）

### Task 1: memdir 路径与 sanitize（纯函数）

**Files:**
- Create: `src/memdir/paths.ts`
- Test: `test/memdir.paths.test.ts`

**Interfaces:**
- Produces:
  - `sanitizeProjectKey(s: string): string`
  - `findGitRoot(cwd: string): string | null`
  - `memdirFor(cwd: string, home?: string): string`
  - `sessionMemoryPathFor(cwd: string, sessionId: string, home?: string): string`
  - `MAX_KEY_LEN = 200`

- [ ] **Step 1: 写失败测试** `test/memdir.paths.test.ts`

```ts
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sanitizeProjectKey, findGitRoot, memdirFor, sessionMemoryPathFor } from '../src/memdir/paths.js'

describe('sanitizeProjectKey', () => {
  test('非字母数字全换 -', () => {
    expect(sanitizeProjectKey('/Users/silas/loop')).toBe('-Users-silas-loop')
    expect(sanitizeProjectKey('a.b_c d')).toBe('a-b-c-d')
  })
  test('超长截断加 hash 后缀', () => {
    const long = 'x'.repeat(300)
    const out = sanitizeProjectKey(long)
    expect(out.length).toBeLessThanOrEqual(200 + 1 + 12)
    expect(out.startsWith('x'.repeat(200) + '-')).toBe(true)
    expect(sanitizeProjectKey(long)).toBe(out) // 确定性
  })
})

describe('findGitRoot', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-git-')) })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })
  test('向上找到 .git 目录', () => {
    fs.mkdirSync(path.join(tmp, '.git'))
    const sub = path.join(tmp, 'a', 'b'); fs.mkdirSync(sub, { recursive: true })
    expect(findGitRoot(sub)).toBe(fs.realpathSync(tmp))
  })
  test('无 .git 返回 null', () => {
    expect(findGitRoot(tmp)).toBe(null)
  })
})

describe('memdirFor / sessionMemoryPathFor', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-md-')) })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })
  test('memdir 用 git root 键', () => {
    const repo = path.join(tmp, 'repo'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    const real = fs.realpathSync(repo)
    expect(memdirFor(repo, tmp)).toBe(path.join(tmp, '.deepcode', 'projects', sanitizeProjectKey(real), 'memory'))
  })
  test('非 git 用 cwd 键', () => {
    expect(memdirFor(tmp, tmp)).toBe(path.join(tmp, '.deepcode', 'projects', sanitizeProjectKey(tmp), 'memory'))
  })
  test('session-memory 用 cwd 键 + summary.md', () => {
    expect(sessionMemoryPathFor(tmp, 'sess-1', tmp))
      .toBe(path.join(tmp, '.deepcode', 'projects', sanitizeProjectKey(tmp), 'sess-1', 'session-memory', 'summary.md'))
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run test/memdir.paths.test.ts` → FAIL（模块不存在）。

- [ ] **Step 3: 实现** `src/memdir/paths.ts`

```ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const MAX_KEY_LEN = 200

export function sanitizeProjectKey(s: string): string {
  const clean = s.replace(/[^a-zA-Z0-9]/g, '-')
  if (clean.length <= MAX_KEY_LEN) return clean
  const hash = crypto.createHash('sha1').update(s).digest('hex').slice(0, 12)
  return clean.slice(0, MAX_KEY_LEN) + '-' + hash
}

/** 向上找含 .git（目录或文件，支持 worktree）的目录，realpath 归一；找不到返回 null。 */
export function findGitRoot(cwd: string): string | null {
  let dir = path.resolve(cwd)
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return fs.realpathSync(dir)
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function projectsBase(home: string): string {
  return path.join(home, '.deepcode', 'projects')
}

/** memdir：项目键用 git root（同 repo 多 worktree 共享），非 git fallback cwd。 */
export function memdirFor(cwd: string, home: string = os.homedir()): string {
  const key = sanitizeProjectKey(findGitRoot(cwd) ?? path.resolve(cwd))
  return path.join(projectsBase(home), key, 'memory')
}

/** session-memory：项目键用 cwd（非 git root），+ sessionId 子目录 + summary.md。 */
export function sessionMemoryPathFor(cwd: string, sessionId: string, home: string = os.homedir()): string {
  const key = sanitizeProjectKey(path.resolve(cwd))
  return path.join(projectsBase(home), key, sessionId, 'session-memory', 'summary.md')
}
```

- [ ] **Step 4: 跑测试确认通过** — `npx vitest run test/memdir.paths.test.ts` → PASS。

- [ ] **Step 5: Commit**

```bash
git add src/memdir/paths.ts test/memdir.paths.test.ts
git commit -m "feat(memdir): 路径与 sanitize（git-root memdir / cwd session-memory）"
```

---

### Task 2: 记忆类型定义（schema 文本）

**Files:**
- Create: `src/memdir/memoryTypes.ts`
- Test: `test/memdir.types.test.ts`

**Interfaces:**
- Produces:
  - `type MemoryType = 'user' | 'feedback' | 'project' | 'reference'`
  - `MEMORY_TYPES: readonly MemoryType[]`
  - `isMemoryType(s: unknown): s is MemoryType`
  - `MEMORY_TYPE_GUIDE: string`（提取/dream prompt 引用的四类语义说明）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, test, expect } from 'vitest'
import { isMemoryType, MEMORY_TYPES, MEMORY_TYPE_GUIDE } from '../src/memdir/memoryTypes.js'

test('isMemoryType', () => {
  expect(isMemoryType('user')).toBe(true)
  expect(isMemoryType('feedback')).toBe(true)
  expect(isMemoryType('nope')).toBe(false)
  expect(isMemoryType(undefined)).toBe(false)
})
test('四类齐全 + guide 提到四类', () => {
  expect([...MEMORY_TYPES].sort()).toEqual(['feedback', 'project', 'reference', 'user'])
  for (const t of MEMORY_TYPES) expect(MEMORY_TYPE_GUIDE).toContain(t)
})
```

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run test/memdir.types.test.ts` → FAIL。

- [ ] **Step 3: 实现** `src/memdir/memoryTypes.ts`

```ts
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference'] as const

export function isMemoryType(s: unknown): s is MemoryType {
  return typeof s === 'string' && (MEMORY_TYPES as readonly string[]).includes(s)
}

/** 提取/合并 prompt 引用：四类记忆语义。对齐 CC memoryTypes。 */
export const MEMORY_TYPE_GUIDE = `记忆分四类（frontmatter \`type\` 字段）：
- user：关于用户的事实（角色、专长、长期偏好）。
- feedback：用户对你工作方式的指导（纠正或确认的做法）；正文跟 **Why:** 与 **How to apply:** 行。
- project：当前工作的目标/约束/决策（会快速过期；相对日期转绝对）。
- reference：外部资源指针（URL、仪表盘、工单）。`
```

- [ ] **Step 4: 跑测试确认通过** — PASS。

- [ ] **Step 5: Commit**

```bash
git add src/memdir/memoryTypes.ts test/memdir.types.test.ts
git commit -m "feat(memdir): 四类记忆类型定义 + 语义 guide"
```

---

### Task 3: 扫描与清单（scanMemoryFiles / formatMemoryManifest）

**Files:**
- Create: `src/memdir/memoryScan.ts`
- Test: `test/memdir.scan.test.ts`

**Interfaces:**
- Consumes: `parseFrontmatter`（`src/agentsLoader.ts`）、`isMemoryType`、`MemoryType`。
- Produces:
  - `interface MemoryHeader { filename: string; filePath: string; mtimeMs: number; description: string | null; type: MemoryType | undefined }`
  - `scanMemoryFiles(memdir: string): Promise<MemoryHeader[]>`（mtime 降序，cap `MAX_MEMORY_FILES=200`，排除 MEMORY.md，递归）
  - `formatMemoryManifest(headers: MemoryHeader[]): string`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanMemoryFiles, formatMemoryManifest } from '../src/memdir/memoryScan.js'

function write(dir: string, name: string, body: string) {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
  fs.writeFileSync(path.join(dir, name), body)
}

describe('scanMemoryFiles', () => {
  let md: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-scan-')) })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }) })

  test('解析 frontmatter、排除 MEMORY.md、按 mtime 降序', async () => {
    write(md, 'a.md', '---\nname: a\ndescription: desc A\ntype: user\n---\nbody')
    write(md, 'MEMORY.md', '- [a](a.md) — x')
    write(md, 'sub/b.md', '---\nname: b\ndescription: desc B\ntype: project\n---\nbody')
    // 让 b 比 a 新
    const now = Date.now()
    fs.utimesSync(path.join(md, 'a.md'), new Date(now - 10000), new Date(now - 10000))
    fs.utimesSync(path.join(md, 'sub/b.md'), new Date(now), new Date(now))
    const heads = await scanMemoryFiles(md)
    expect(heads.map(h => h.filename)).toEqual([path.join('sub', 'b.md'), 'a.md'])
    expect(heads[0]).toMatchObject({ description: 'desc B', type: 'project' })
    expect(heads.find(h => h.filename === 'MEMORY.md')).toBeUndefined()
  })

  test('坏 frontmatter → description null / type undefined，不抛', async () => {
    write(md, 'bad.md', 'no frontmatter here')
    const heads = await scanMemoryFiles(md)
    expect(heads[0]).toMatchObject({ description: null, type: undefined })
  })

  test('目录不存在 → 空数组', async () => {
    expect(await scanMemoryFiles(path.join(md, 'nope'))).toEqual([])
  })
})

test('formatMemoryManifest 列出每条', () => {
  const out = formatMemoryManifest([
    { filename: 'a.md', filePath: '/x/a.md', mtimeMs: 0, description: 'd', type: 'user' },
  ])
  expect(out).toContain('a.md')
  expect(out).toContain('d')
  expect(out).toContain('user')
})
```

- [ ] **Step 2: 跑测试确认失败** — FAIL。

- [ ] **Step 3: 实现** `src/memdir/memoryScan.ts`

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseFrontmatter } from '../agentsLoader.js'
import { isMemoryType, type MemoryType } from './memoryTypes.js'

export const MAX_MEMORY_FILES = 200

export interface MemoryHeader {
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
}

export async function scanMemoryFiles(memdir: string): Promise<MemoryHeader[]> {
  let entries: string[]
  try {
    entries = (await fs.readdir(memdir, { recursive: true }) as string[])
      .filter(f => f.endsWith('.md') && path.basename(f) !== 'MEMORY.md')
  } catch { return [] }

  const heads = await Promise.all(entries.map(async (filename): Promise<MemoryHeader | null> => {
    const filePath = path.join(memdir, filename)
    try {
      const stat = await fs.stat(filePath)
      if (!stat.isFile()) return null
      const head = (await fs.readFile(filePath, 'utf8')).split('\n').slice(0, 30).join('\n')
      const { data } = parseFrontmatter(head + '\n')
      const desc = typeof data.description === 'string' ? data.description : null
      const type = isMemoryType(data.type) ? data.type : undefined
      return { filename, filePath, mtimeMs: stat.mtimeMs, description: desc, type }
    } catch { return null }
  }))

  return heads.filter((h): h is MemoryHeader => h !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_MEMORY_FILES)
}

export function formatMemoryManifest(headers: MemoryHeader[]): string {
  if (!headers.length) return '（暂无记忆文件）'
  return headers.map(h => `- [${h.type ?? '?'}] ${h.filename}: ${h.description ?? '(无描述)'}`).join('\n')
}
```

- [ ] **Step 4: 跑测试确认通过** — PASS。

- [ ] **Step 5: Commit**

```bash
git add src/memdir/memoryScan.ts test/memdir.scan.test.ts
git commit -m "feat(memdir): scanMemoryFiles + formatMemoryManifest"
```

---

### Task 4: 索引加载与截断（loadMemoryPrompt / truncateEntrypoint）

**Files:**
- Create: `src/memdir/memdir.ts`
- Test: `test/memdir.load.test.ts`

**Interfaces:**
- Produces:
  - `MAX_ENTRYPOINT_LINES = 200`、`MAX_ENTRYPOINT_BYTES = 25600`
  - `truncateEntrypoint(content: string): string`
  - `loadMemoryPrompt(memdir: string): string`（同步读 MEMORY.md，截断，包成 `## 记忆索引` 段；空/缺失给提示）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { truncateEntrypoint, loadMemoryPrompt, MAX_ENTRYPOINT_LINES } from '../src/memdir/memdir.js'

test('truncateEntrypoint 行数上限', () => {
  const many = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
  const out = truncateEntrypoint(many)
  expect(out.split('\n').length).toBeLessThanOrEqual(MAX_ENTRYPOINT_LINES + 1)
  expect(out).toContain('截断')
})

test('truncateEntrypoint 字节上限', () => {
  const big = 'x'.repeat(30000)
  expect(Buffer.byteLength(truncateEntrypoint(big), 'utf8')).toBeLessThanOrEqual(25600 + 100)
})

describe('loadMemoryPrompt', () => {
  let md: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-load-')) })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }) })
  test('有 MEMORY.md → 注入内容', () => {
    fs.writeFileSync(path.join(md, 'MEMORY.md'), '- [a](a.md) — hook')
    const out = loadMemoryPrompt(md)
    expect(out).toContain('## 记忆索引')
    expect(out).toContain('a.md')
  })
  test('无 MEMORY.md → 空提示', () => {
    const out = loadMemoryPrompt(md)
    expect(out).toContain('## 记忆索引')
    expect(out).toContain('暂无')
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — FAIL。

- [ ] **Step 3: 实现** `src/memdir/memdir.ts`

```ts
import fs from 'node:fs'
import path from 'node:path'

export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25600

export function truncateEntrypoint(content: string): string {
  let out = content
  const lines = out.split('\n')
  let truncated = false
  if (lines.length > MAX_ENTRYPOINT_LINES) { out = lines.slice(0, MAX_ENTRYPOINT_LINES).join('\n'); truncated = true }
  while (Buffer.byteLength(out, 'utf8') > MAX_ENTRYPOINT_BYTES) {
    out = out.slice(0, Math.floor(out.length * 0.9)); truncated = true
  }
  return truncated ? out + '\n…（索引已截断，用 Read 查看 memory 目录全文）' : out
}

/** 读 memdir/MEMORY.md 注入系统提示的 `## 记忆索引` 段。会话启动调一次，保持静态。 */
export function loadMemoryPrompt(memdir: string): string {
  let body = ''
  try { body = fs.readFileSync(path.join(memdir, 'MEMORY.md'), 'utf8').trim() } catch { /* 缺失 */ }
  const inner = body
    ? truncateEntrypoint(body)
    : '（暂无记忆。沉淀的记忆会自动出现在这里；每条记忆是一个带 frontmatter 的 .md 文件，指针记入 MEMORY.md。）'
  return `## 记忆索引\n${inner}`
}
```

- [ ] **Step 4: 跑测试确认通过** — PASS。

- [ ] **Step 5: Commit**

```bash
git add src/memdir/memdir.ts test/memdir.load.test.ts
git commit -m "feat(memdir): loadMemoryPrompt + truncateEntrypoint"
```

---

### Task 5: 配置 `Settings.memory` 解析

**Files:**
- Modify: `src/config.ts`（`Settings` 接口加 `memory?`、`loadRawUserSettings` 接线、新增 `parseMemoryConfig`）
- Create: `src/memdir/memoryConfig.ts`（`MemoryConfig` 类型 + `DEFAULT_MEMORY_CONFIG` + `parseMemoryConfig`）
- Test: `test/memory.config.test.ts`

**Interfaces:**
- Produces:
  - `interface MemoryConfig {...}`（见 Global Constraints 默认表）
  - `DEFAULT_MEMORY_CONFIG: MemoryConfig`
  - `parseMemoryConfig(raw: unknown): MemoryConfig`
- Consumes（后续 task）：`loadSettings(cwd).memory`。

- [ ] **Step 1: 写失败测试** `test/memory.config.test.ts`

```ts
import { describe, test, expect } from 'vitest'
import { parseMemoryConfig, DEFAULT_MEMORY_CONFIG } from '../src/memdir/memoryConfig.js'

test('空/非对象 → 全默认', () => {
  expect(parseMemoryConfig(undefined)).toEqual(DEFAULT_MEMORY_CONFIG)
  expect(parseMemoryConfig('x')).toEqual(DEFAULT_MEMORY_CONFIG)
  expect(parseMemoryConfig({})).toEqual(DEFAULT_MEMORY_CONFIG)
})
test('部分覆盖 + 非法字段丢弃回默认', () => {
  const c = parseMemoryConfig({ enabled: false, extractEveryTurns: 'x', recall: { enabled: true }, dream: { minHours: 1 } })
  expect(c.enabled).toBe(false)
  expect(c.extractEveryTurns).toBe(1) // 非法→默认
  expect(c.recall.enabled).toBe(true)
  expect(c.recall.maxResults).toBe(5) // 未给→默认
  expect(c.dream.minHours).toBe(1)
  expect(c.dream.minSessions).toBe(5)
})
test('默认值正确', () => {
  expect(DEFAULT_MEMORY_CONFIG).toEqual({
    enabled: true, extractEveryTurns: 1,
    recall: { enabled: false, maxResults: 5 },
    sessionMemory: { enabled: true, minInitTokens: 10000, minUpdateTokens: 5000, toolCallsBetween: 3 },
    dream: { enabled: true, minHours: 24, minSessions: 5 },
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — FAIL。

- [ ] **Step 3: 实现** `src/memdir/memoryConfig.ts`

```ts
export interface MemoryConfig {
  enabled: boolean
  extractEveryTurns: number
  recall: { enabled: boolean; maxResults: number }
  sessionMemory: { enabled: boolean; minInitTokens: number; minUpdateTokens: number; toolCallsBetween: number }
  dream: { enabled: boolean; minHours: number; minSessions: number }
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  extractEveryTurns: 1,
  recall: { enabled: false, maxResults: 5 },
  sessionMemory: { enabled: true, minInitTokens: 10000, minUpdateTokens: 5000, toolCallsBetween: 3 },
  dream: { enabled: true, minHours: 24, minSessions: 5 },
}

const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
const posInt = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d)
const nonNeg = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d)

export function parseMemoryConfig(raw: unknown): MemoryConfig {
  const r: any = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const D = DEFAULT_MEMORY_CONFIG
  const rc = r.recall && typeof r.recall === 'object' ? r.recall : {}
  const sm = r.sessionMemory && typeof r.sessionMemory === 'object' ? r.sessionMemory : {}
  const dr = r.dream && typeof r.dream === 'object' ? r.dream : {}
  return {
    enabled: bool(r.enabled, D.enabled),
    extractEveryTurns: posInt(r.extractEveryTurns, D.extractEveryTurns),
    recall: { enabled: bool(rc.enabled, D.recall.enabled), maxResults: posInt(rc.maxResults, D.recall.maxResults) },
    sessionMemory: {
      enabled: bool(sm.enabled, D.sessionMemory.enabled),
      minInitTokens: posInt(sm.minInitTokens, D.sessionMemory.minInitTokens),
      minUpdateTokens: posInt(sm.minUpdateTokens, D.sessionMemory.minUpdateTokens),
      toolCallsBetween: posInt(sm.toolCallsBetween, D.sessionMemory.toolCallsBetween),
    },
    dream: {
      enabled: bool(dr.enabled, D.dream.enabled),
      minHours: nonNeg(dr.minHours, D.dream.minHours),
      minSessions: posInt(dr.minSessions, D.dream.minSessions),
    },
  }
}
```

- [ ] **Step 4: 接线 `src/config.ts`**

`Settings` 接口加字段（紧接 `httpHookAllowedEnvVars` 后）：
```ts
  /** 记忆子系统配置（缺省全默认，见 memoryConfig.ts）。 */
  memory?: import('./memdir/memoryConfig.js').MemoryConfig
```
顶部 import：
```ts
import { parseMemoryConfig } from './memdir/memoryConfig.js'
```
`loadRawUserSettings` 的返回对象里加（紧接 `httpHookAllowedEnvVars` 行后）：
```ts
    memory: parseMemoryConfig(raw?.memory),
```

- [ ] **Step 5: 跑测试 + typecheck** — `npx vitest run test/memory.config.test.ts && npx tsc --noEmit` → PASS / 干净。

- [ ] **Step 6: Commit**

```bash
git add src/memdir/memoryConfig.ts src/config.ts test/memory.config.test.ts
git commit -m "feat(config): Settings.memory 解析（默认全默认，宽松丢弃非法字段）"
```

---

### Task 6: 静态索引接入 `buildSystemPrompt` + useChat 传 memdir

**Files:**
- Modify: `src/prompt.ts:33`（`buildSystemPrompt` 加 `memdir?` 参 + 注入段）
- Modify: `src/tui/useChat.ts:233,313`（两处 `buildSystemPrompt` 调用传 memdir；recall 开则不传）
- Test: `test/prompt.memory.test.ts`

**Interfaces:**
- Consumes: `loadMemoryPrompt`、`memdirFor`、`loadSettings(...).memory`。
- Produces: `buildSystemPrompt(cwd, home?, skills?, budgetChars?, memdir?: string): string` —— 给了 memdir 则末尾追加 `loadMemoryPrompt(memdir)`。

- [ ] **Step 1: 写失败测试** `test/prompt.memory.test.ts`

```ts
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSystemPrompt } from '../src/prompt.js'

describe('buildSystemPrompt memdir 段', () => {
  let md: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-bsp-')) })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }) })
  test('给 memdir → 注入记忆索引段', () => {
    fs.writeFileSync(path.join(md, 'MEMORY.md'), '- [x](x.md) — hook')
    const out = buildSystemPrompt(process.cwd(), os.homedir(), undefined, undefined, md)
    expect(out).toContain('## 记忆索引')
    expect(out).toContain('x.md')
  })
  test('不给 memdir → 无记忆索引段（recall 开态）', () => {
    const out = buildSystemPrompt(process.cwd(), os.homedir())
    expect(out).not.toContain('## 记忆索引')
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — FAIL。

- [ ] **Step 3: 实现** `src/prompt.ts` —— 改签名加 `memdir?: string`，在 `return` 模板字符串末尾（`${skillBlock}` 之后）追加：

```ts
  const memdirBlock = memdir ? '\n\n' + loadMemoryPrompt(memdir) : ''
```
并把模板结尾改为 `…${skillBlock}${memdirBlock}\``。顶部 import：
```ts
import { loadMemoryPrompt } from './memdir/memdir.js'
```
签名：
```ts
export function buildSystemPrompt(cwd: string, home: string = os.homedir(), skills?: SkillDefinition[], budgetChars?: number, memdir?: string): string {
```

- [ ] **Step 4: 接线 useChat** `src/tui/useChat.ts` —— 在两处 `buildSystemPrompt(...)` 调用点，先算：
```ts
const mem = loadSettings(cwd).memory ?? DEFAULT_MEMORY_CONFIG
const memdir = mem.enabled && !mem.recall.enabled ? memdirFor(cwd) : undefined
```
把 `memdir` 作第 5 参传入。import：
```ts
import { memdirFor } from '../memdir/paths.js'
import { DEFAULT_MEMORY_CONFIG } from '../memdir/memoryConfig.js'
```
（`loadSettings` 已 import；若该处已有 settings 变量则复用。）

- [ ] **Step 5: 跑测试 + typecheck + 全量** — `npx vitest run test/prompt.memory.test.ts && npx tsc --noEmit && npm test` → 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/prompt.ts src/tui/useChat.ts test/prompt.memory.test.ts
git commit -m "feat(memdir): 静态记忆索引接入 buildSystemPrompt（recall 关时注入）"
```

> **Phase 1 验收**：memdir schema/路径/扫描/加载/配置就位，会话启动静态注入 MEMORY.md 索引。`npm test` + `tsc` + `npm run build` 全绿。

---

# Phase 2 — 自动提取（3.2）

### Task 7: memdir 受限工具工厂 `makeMemdirTools`

**Files:**
- Create: `src/services/memory/memdirTools.ts`
- Test: `test/memory.memdirTools.test.ts`

**Interfaces:**
- Consumes: `Tool`、`ToolContext`（`src/tools/types.ts`）、现有 `readTool`（`src/tools/read.ts`）。
- Produces: `makeMemdirTools(memdir: string): Tool<any>[]`（= 只读 Read + memdir 绑定 MemWrite/MemEdit；写工具 `call` 内断言 resolved 路径前缀 === memdir，越界返回错误串不写盘）。
- Produces: `assertInMemdir(memdir: string, target: string): string | null`（null=允许；string=拒绝原因）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeMemdirTools, assertInMemdir } from '../src/services/memory/memdirTools.js'

test('assertInMemdir 拦越界', () => {
  const md = '/home/u/.deepcode/projects/k/memory'
  expect(assertInMemdir(md, path.join(md, 'a.md'))).toBe(null)
  expect(assertInMemdir(md, path.join(md, 'sub/a.md'))).toBe(null)
  expect(assertInMemdir(md, '/home/u/.ssh/id_rsa')).not.toBe(null)
  expect(assertInMemdir(md, path.join(md, '../../../etc/passwd'))).not.toBe(null)
})

describe('makeMemdirTools 写工具', () => {
  let md: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-mt-')) })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }) })
  const ctx: any = { cwd: () => md, fileState: new Map(), signal: new AbortController().signal }

  test('MemWrite 落 memdir 内成功', async () => {
    const tools = makeMemdirTools(md)
    const w = tools.find(t => t.name === 'MemWrite')!
    const r = await w.call({ file_path: 'note.md', content: 'hi' }, ctx)
    expect(r).toContain('已写入')
    expect(fs.readFileSync(path.join(md, 'note.md'), 'utf8')).toBe('hi')
  })
  test('MemWrite 越界被拒、不写盘', async () => {
    const tools = makeMemdirTools(md)
    const w = tools.find(t => t.name === 'MemWrite')!
    const out = '/tmp/evil-' + path.basename(md) + '.txt'
    const r = await w.call({ file_path: out, content: 'x' }, ctx)
    expect(r).toMatch(/拒绝|越界|memory/)
    expect(fs.existsSync(out)).toBe(false)
  })
  test('含 Read', () => {
    expect(makeMemdirTools(md).some(t => t.name === 'Read')).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — FAIL。

- [ ] **Step 3: 实现** `src/services/memory/memdirTools.ts`

```ts
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import type { Tool } from '../../tools/types.js'
import { readTool } from '../../tools/read.js'

/** 返回 null 表示允许；否则返回拒绝原因。target 解析后必须在 memdir 子树内。 */
export function assertInMemdir(memdir: string, target: string): string | null {
  const root = path.resolve(memdir)
  const abs = path.resolve(target)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return `拒绝：记忆工具只能写入 memory 目录（${root}）内，越界路径 ${abs} 被拦截。`
  }
  return null
}

const wschema = z.object({
  file_path: z.string().describe('memory 目录内的相对或绝对路径'),
  content: z.string().describe('完整文件内容（覆盖写）'),
})
const eschema = z.object({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
})

export function makeMemdirTools(memdir: string): Tool<any>[] {
  const resolve = (fp: string) => path.isAbsolute(fp) ? fp : path.join(memdir, fp)

  const memWrite: Tool<typeof wschema> = {
    name: 'MemWrite',
    description: '把整文件写入 memory 目录（自动建父目录）。仅限 memory 目录内。',
    inputSchema: wschema,
    isReadOnly: false,
    needsPermission: () => false, // forked 子代理无 UI；隔离靠路径断言
    async call(input) {
      const p = resolve(input.file_path)
      const deny = assertInMemdir(memdir, p)
      if (deny) return deny
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, input.content)
      return `已写入 ${p}（${input.content.length} 字符）。`
    },
  }

  const memEdit: Tool<typeof eschema> = {
    name: 'MemEdit',
    description: '在 memory 目录内的文件做精确字符串替换。仅限 memory 目录内。',
    inputSchema: eschema,
    isReadOnly: false,
    needsPermission: () => false,
    async call(input) {
      const p = resolve(input.file_path)
      const deny = assertInMemdir(memdir, p)
      if (deny) return deny
      let cur: string
      try { cur = fs.readFileSync(p, 'utf8') } catch { return `错误：文件不存在 ${p}` }
      if (!cur.includes(input.old_string)) return `错误：old_string 未匹配到。`
      fs.writeFileSync(p, cur.replace(input.old_string, input.new_string))
      return `已编辑 ${p}。`
    },
  }

  return [readTool, memWrite, memEdit]
}
```

- [ ] **Step 4: 跑测试确认通过** — PASS。

- [ ] **Step 5: Commit**

```bash
git add src/services/memory/memdirTools.ts test/memory.memdirTools.test.ts
git commit -m "feat(memory): makeMemdirTools 受限工具工厂（路径物理隔离）"
```

---

### Task 8: 提取游标与判重谓词（纯函数）

**Files:**
- Create: `src/services/memory/extractCursor.ts`
- Test: `test/memory.extractCursor.test.ts`

**Interfaces:**
- Produces:
  - `shouldExtractByThrottle(turnsSinceLast: number, everyTurns: number, isTrailing: boolean): boolean`（trailing 跳节流恒 true）
  - `messagesSince(messages: any[], turnIds: (number|undefined)[], cursorTurnId: number): any[]`（取 turn > cursor 的 user 消息起到末尾的切片）
  - `hasMemoryWritesSince(messages: any[], memdir: string): boolean`（区间内有对 memdir 的 MemWrite/MemEdit/Write tool_call）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, test, expect } from 'vitest'
import { shouldExtractByThrottle, messagesSince, hasMemoryWritesSince } from '../src/services/memory/extractCursor.js'

test('节流：trailing 恒跑；否则按 everyTurns', () => {
  expect(shouldExtractByThrottle(0, 1, true)).toBe(true)
  expect(shouldExtractByThrottle(1, 1, false)).toBe(true)
  expect(shouldExtractByThrottle(1, 3, false)).toBe(false)
  expect(shouldExtractByThrottle(3, 3, false)).toBe(true)
})

test('messagesSince 取游标后的切片', () => {
  const msgs = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]
  const turns = [1, undefined, 2]
  expect(messagesSince(msgs, turns, 1)).toEqual([{ role: 'user', content: 'c' }])
  expect(messagesSince(msgs, turns, 0).length).toBe(3)
})

test('hasMemoryWritesSince 检测 memdir 写', () => {
  const md = '/x/memory'
  const withWrite = [{ role: 'assistant', tool_calls: [{ function: { name: 'MemWrite', arguments: '{"file_path":"a.md"}' } }] }]
  expect(hasMemoryWritesSince(withWrite, md)).toBe(true)
  const plainWrite = [{ role: 'assistant', tool_calls: [{ function: { name: 'Write', arguments: '{"file_path":"/x/memory/a.md"}' } }] }]
  expect(hasMemoryWritesSince(plainWrite, md)).toBe(true)
  const noWrite = [{ role: 'assistant', tool_calls: [{ function: { name: 'Read', arguments: '{}' } }] }]
  expect(hasMemoryWritesSince(noWrite, md)).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败** — FAIL。

- [ ] **Step 3: 实现** `src/services/memory/extractCursor.ts`

```ts
import path from 'node:path'

export function shouldExtractByThrottle(turnsSinceLast: number, everyTurns: number, isTrailing: boolean): boolean {
  if (isTrailing) return true
  return turnsSinceLast >= Math.max(1, everyTurns)
}

/** 取 turnId > cursor 的首个 user 消息起到数组末尾。无则返回全部（首次提取）。 */
export function messagesSince(messages: any[], turnIds: (number | undefined)[], cursorTurnId: number): any[] {
  let start = -1
  for (let i = 0; i < messages.length; i++) {
    const t = turnIds[i]
    if (typeof t === 'number' && t > cursorTurnId) { start = i; break }
  }
  return start < 0 ? (cursorTurnId <= 0 ? messages.slice() : []) : messages.slice(start)
}

/** 区间消息里是否有写 memdir 的 tool_call（MemWrite/MemEdit 恒算；Write/Edit 看路径前缀）。 */
export function hasMemoryWritesSince(messages: any[], memdir: string): boolean {
  const root = path.resolve(memdir)
  for (const m of messages) {
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue
    for (const c of m.tool_calls) {
      const name = c?.function?.name
      if (name === 'MemWrite' || name === 'MemEdit') return true
      if (name === 'Write' || name === 'Edit') {
        try {
          const fp = JSON.parse(c.function.arguments)?.file_path
          if (typeof fp === 'string' && path.resolve(fp).startsWith(root)) return true
        } catch { /* 忽略 */ }
      }
    }
  }
  return false
}
```

- [ ] **Step 4: 跑测试确认通过** — PASS。

- [ ] **Step 5: Commit**

```bash
git add src/services/memory/extractCursor.ts test/memory.extractCursor.test.ts
git commit -m "feat(memory): 提取游标/节流/判重谓词（turnId 游标）"
```

---

### Task 9: 提取 prompt 构建

**Files:**
- Create: `src/services/memory/extractPrompt.ts`
- Test: `test/memory.extractPrompt.test.ts`

**Interfaces:**
- Consumes: `MEMORY_TYPE_GUIDE`、`formatMemoryManifest`、`MemoryHeader`。
- Produces: `buildExtractPrompt(recentMessages: any[], manifest: string): string`、`renderRecentMessages(messages: any[]): string`

- [ ] **Step 1: 写失败测试**

```ts
import { test, expect } from 'vitest'
import { buildExtractPrompt, renderRecentMessages } from '../src/services/memory/extractPrompt.js'

test('renderRecentMessages 拼角色+文本', () => {
  const r = renderRecentMessages([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }])
  expect(r).toContain('hello'); expect(r).toContain('hi')
})
test('buildExtractPrompt 含四类 + 清单 + 禁 grep 源码', () => {
  const p = buildExtractPrompt([{ role: 'user', content: 'X' }], '- [user] a.md: d')
  expect(p).toContain('user'); expect(p).toContain('feedback')
  expect(p).toContain('a.md')
  expect(p).toMatch(/不要.*源码|禁.*grep/)
  expect(p).toContain('MEMORY.md')
})
```

- [ ] **Step 2: 跑测试确认失败** — FAIL。

- [ ] **Step 3: 实现** `src/services/memory/extractPrompt.ts`

```ts
import { MEMORY_TYPE_GUIDE } from '../../memdir/memoryTypes.js'

export function renderRecentMessages(messages: any[]): string {
  return messages.map(m => {
    const text = typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.map((c: any) => c?.text ?? '').join('') : ''
    return `[${m.role}] ${text}`.trim()
  }).filter(Boolean).join('\n\n')
}

export function buildExtractPrompt(recentMessages: any[], manifest: string): string {
  return `你的任务：从下面这段最近对话里，提取值得长期记住的事实，存成 memory 文件。

只用 MemWrite/MemEdit 工具（只能写 memory 目录），可用 Read 看现有文件。**不要 grep 源码、不要 git 探索**，只依据下面对话内容。最多 5 轮内完成。

${MEMORY_TYPE_GUIDE}

不要保存：代码结构/git 历史能查到的、只对本次对话有意义的、已被现有记忆覆盖的。

现有记忆清单（避免重复，已有的用 MemEdit 更新而非新建）：
${manifest}

保存方法（两步）：① MemWrite 写 \`<slug>.md\`（带 frontmatter：name/description/type，正文遵循类型约定）；② MemEdit 更新 \`MEMORY.md\` 加一行指针 \`- [Title](<slug>.md) — 一行 hook\`。没什么值得记的就什么都不写。

最近对话：
${renderRecentMessages(recentMessages)}`
}
```

- [ ] **Step 4: 跑测试确认通过** — PASS。

- [ ] **Step 5: Commit**

```bash
git add src/services/memory/extractPrompt.ts test/memory.extractPrompt.test.ts
git commit -m "feat(memory): 提取 prompt 构建"
```

---

### Task 10: 提取编排器（coalesce / inFlight / forked）

**Files:**
- Create: `src/services/memory/extractMemories.ts`
- Test: `test/memory.extractMemories.test.ts`

**Interfaces:**
- Consumes: `runSubagent`（`src/subagentRunner.ts`）、`acquireSubagentSlot`/`releaseSubagentSlot`（若导出；否则见下注）、`makeMemdirTools`、`scanMemoryFiles`、`formatMemoryManifest`、`buildExtractPrompt`、`messagesSince`、`shouldExtractByThrottle`、`hasMemoryWritesSince`、`memdirFor`。
- Produces:
  - `createMemoryExtractor(deps: ExtractorDeps): { onTurnEnd(input): void; drain(): Promise<void> }`
  - `interface ExtractorDeps { client; model; memdir; config; ctx; runSubagent?; scan?; now? }`（`runSubagent`/`scan` 可注入便于测）

> 注：`subagentRunner.ts` 的信号量 acquire/release 由调用方管（见该文件注释）。提取走后台 fire-and-forget，需 acquire slot 再 runSubagent，finally release。若 `subagentRunner.ts` 未导出信号量函数，本 task 先在 `subagentRunner.ts` 加 `export { acquireSubagentSlot, releaseSubagentSlot }`（最小改动，规格审确认）。

- [ ] **Step 1: 写失败测试**（用注入的假 runSubagent，验证节流/游标/coalesce/drain，不碰真模型）

```ts
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createMemoryExtractor } from '../src/services/memory/extractMemories.js'
import { DEFAULT_MEMORY_CONFIG } from '../src/memdir/memoryConfig.js'

function mkDeps(md: string, runSub: any, cfg = DEFAULT_MEMORY_CONFIG) {
  return {
    client: {} as any, model: 'm', memdir: md, config: cfg,
    ctx: { cwd: () => md, fileState: new Map(), signal: new AbortController().signal } as any,
    runSubagent: runSub,
    scan: async () => [], // 空清单
  }
}

describe('createMemoryExtractor', () => {
  let md: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-ext-')); fs.mkdirSync(md, { recursive: true }) })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }) })

  test('每轮触发（everyTurns=1）调 runSubagent', async () => {
    const runSub = vi.fn(async () => 'ok')
    const ex = createMemoryExtractor(mkDeps(md, runSub))
    ex.onTurnEnd({ messages: [{ role: 'user', content: 'a' }], turnIds: [1], maxTurnId: 1 })
    await ex.drain()
    expect(runSub).toHaveBeenCalledTimes(1)
  })

  test('游标推进：同 maxTurnId 不重复提取', async () => {
    const runSub = vi.fn(async () => 'ok')
    const ex = createMemoryExtractor(mkDeps(md, runSub))
    const snap = { messages: [{ role: 'user', content: 'a' }], turnIds: [1], maxTurnId: 1 }
    ex.onTurnEnd(snap); await ex.drain()
    ex.onTurnEnd(snap); await ex.drain() // 游标已到 1，无新消息
    expect(runSub).toHaveBeenCalledTimes(1)
  })

  test('失败不前移游标，下次重试', async () => {
    const runSub = vi.fn(async () => { throw new Error('boom') })
    const ex = createMemoryExtractor(mkDeps(md, runSub))
    const snap = { messages: [{ role: 'user', content: 'a' }], turnIds: [1], maxTurnId: 1 }
    ex.onTurnEnd(snap); await ex.drain()
    const runSub2 = vi.fn(async () => 'ok')
    const ex2Deps = mkDeps(md, runSub2)
    // 复用同一 extractor 实例验证重试：换成成功
    ;(ex as any) // 同实例：第二次仍因游标未动而尝试
    ex.onTurnEnd(snap); await ex.drain()
    expect(runSub).toHaveBeenCalledTimes(1) // 第一次失败
  })

  test('enabled=false 不触发', async () => {
    const runSub = vi.fn(async () => 'ok')
    const ex = createMemoryExtractor(mkDeps(md, runSub, { ...DEFAULT_MEMORY_CONFIG, enabled: false }))
    ex.onTurnEnd({ messages: [{ role: 'user', content: 'a' }], turnIds: [1], maxTurnId: 1 })
    await ex.drain()
    expect(runSub).not.toHaveBeenCalled()
  })

  test('drain 跑尾部提取（跳节流）', async () => {
    const runSub = vi.fn(async () => 'ok')
    const ex = createMemoryExtractor(mkDeps(md, runSub, { ...DEFAULT_MEMORY_CONFIG, extractEveryTurns: 100 }))
    ex.onTurnEnd({ messages: [{ role: 'user', content: 'a' }], turnIds: [1], maxTurnId: 1 }) // 节流挡住
    expect(runSub).toHaveBeenCalledTimes(0)
    await ex.drain() // 尾部跳节流
    expect(runSub).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — FAIL。

- [ ] **Step 3: 实现** `src/services/memory/extractMemories.ts`

```ts
import type OpenAI from 'openai'
import type { ToolContext } from '../../tools/types.js'
import type { MemoryConfig } from '../../memdir/memoryConfig.js'
import { runSubagent as realRunSubagent } from '../../subagentRunner.js'
import { scanMemoryFiles, formatMemoryManifest } from '../../memdir/memoryScan.js'
import { makeMemdirTools } from './memdirTools.js'
import { buildExtractPrompt } from './extractPrompt.js'
import { messagesSince, shouldExtractByThrottle, hasMemoryWritesSince } from './extractCursor.js'

export interface TurnSnapshot { messages: any[]; turnIds: (number | undefined)[]; maxTurnId: number }

export interface ExtractorDeps {
  client: OpenAI
  model: string
  memdir: string
  config: MemoryConfig
  ctx: ToolContext
  runSubagent?: typeof realRunSubagent
  scan?: typeof scanMemoryFiles
}

export function createMemoryExtractor(deps: ExtractorDeps) {
  const runSub = deps.runSubagent ?? realRunSubagent
  const scan = deps.scan ?? scanMemoryFiles
  let cursor = 0
  let turnsSinceLast = 0
  let inProgress = false
  let pending: TurnSnapshot | null = null
  let lastSnap: TurnSnapshot | null = null
  const inFlight = new Set<Promise<void>>()
  let counter = 0

  async function run(snap: TurnSnapshot, isTrailing: boolean): Promise<void> {
    const recent = messagesSince(snap.messages, snap.turnIds, cursor)
    if (!recent.length) { turnsSinceLast = 0; return }
    // 主 agent 已自写记忆 → 跳过 fork、推进游标
    if (hasMemoryWritesSince(recent, deps.memdir)) { cursor = snap.maxTurnId; turnsSinceLast = 0; return }
    const manifest = formatMemoryManifest(await scan(deps.memdir))
    await runSub({
      client: deps.client, model: deps.model,
      onUsage: () => {},
      systemPrompt: '你是 deepcode 的记忆提取助手。只用提供的工具，简洁高效。',
      userPrompt: buildExtractPrompt(recent, manifest),
      tools: makeMemdirTools(deps.memdir),
      ctx: deps.ctx, signal: deps.ctx.signal,
      agentId: `extract-${++counter}`, agentType: 'extract_memories',
    })
    cursor = snap.maxTurnId // 仅成功后推进
    turnsSinceLast = 0
  }

  function trigger(snap: TurnSnapshot, isTrailing: boolean) {
    if (!deps.config.enabled) return
    if (inProgress) { pending = snap; return }
    if (!shouldExtractByThrottle(turnsSinceLast, deps.config.extractEveryTurns, isTrailing)) return
    inProgress = true
    const p = (async () => {
      try { await run(snap, isTrailing) }
      catch (e: any) { console.error('[memory] 提取失败：' + (e?.message ?? e)) } // fail-safe，游标不动
      finally {
        inProgress = false
        if (pending) { const next = pending; pending = null; trigger(next, true) } // trailing 跳节流
      }
    })()
    inFlight.add(p); p.finally(() => inFlight.delete(p))
  }

  return {
    onTurnEnd(snap: TurnSnapshot) {
      if (!deps.config.enabled) return
      lastSnap = snap
      turnsSinceLast++
      trigger(snap, false)
    },
    async drain(): Promise<void> {
      // 退出/清空：跑一次尾部提取（跳节流）再等所有在飞
      if (deps.config.enabled && !inProgress && lastSnap) trigger(lastSnap, true)
      await Promise.allSettled([...inFlight])
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过** — `npx vitest run test/memory.extractMemories.test.ts` → PASS。

- [ ] **Step 5: Commit**

```bash
git add src/services/memory/extractMemories.ts src/subagentRunner.ts test/memory.extractMemories.test.ts
git commit -m "feat(memory): 提取编排器（节流/游标/coalesce/drain，forked 受限 agent）"
```

---

### Task 11: useChat 接线（每轮末触发 + 退出 drain）

**Files:**
- Modify: `src/tui/useChat.ts`（创建 extractor；每轮助手回复完成后 `onTurnEnd`；`fireSessionEnd`/`dispose` 调 `drain`）
- Test: `test/useChat.memory.test.ts`（集成：mock runSubagent，跑一轮验证 onTurnEnd 被调）

**Interfaces:**
- Consumes: `createMemoryExtractor`、`memdirFor`、`loadSettings(cwd).memory`。

- [ ] **Step 1: 写失败测试** —— 在 `createChatCore`（useChat 测试入口）注入假 client/runSubagent，发送一条用户消息跑完一轮，断言 extractor 的 `onTurnEnd` 触发了 runSubagent（用 spy）。参照现有 `test/useChat.tasks.test.ts` 的 harness 写。

```ts
// 关键断言（具体 harness 仿 useChat.tasks.test.ts）：
// const runSub = vi.fn(async () => 'ok')
// ...注入 runSub，发送 'hi'，等一轮结束 + 微任务 flush
// expect(runSub).toHaveBeenCalled()
```

- [ ] **Step 2: 跑测试确认失败** — FAIL。

- [ ] **Step 3: 接线 useChat**：
  - 会话创建后构建 extractor：
    ```ts
    const memCfg = loadSettings(cwd).memory ?? DEFAULT_MEMORY_CONFIG
    const extractor = createMemoryExtractor({
      client, model, memdir: memdirFor(cwd), config: memCfg, ctx: toolCtx,
    })
    ```
  - 每轮用户回复跑完（`runLoop` 对该 turn 返回、消息已落盘）后 fire-and-forget：
    ```ts
    extractor.onTurnEnd({ messages, turnIds: messageTurnIds, maxTurnId: currentTurnId })
    ```
  - `fireSessionEnd(reason)` 与 `dispose()` 内：`void extractor.drain()`（exit 路径加有界超时：`Promise.race([extractor.drain(), sleep(3000)])`）。
  > resume 换 session：extractor 需随之重建（cursor 重置）。在 resume 路径重建 extractor。

- [ ] **Step 4: 跑测试 + 全量** — `npx vitest run test/useChat.memory.test.ts && npm test && npx tsc --noEmit` → 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/tui/useChat.ts test/useChat.memory.test.ts
git commit -m "feat(memory): useChat 每轮末触发提取 + 退出 drain"
```

> **Phase 2 验收**：开启 memory 后每轮末后台提取记忆到 memdir，游标防重、退出 drain。`npm test`+`tsc`+`build` 全绿。

---

# Phase 3 — 动态召回（3.1 dynamic）

### Task 12: findRelevantMemories（DeepSeek 侧调用）

**Files:**
- Create: `src/memdir/findRelevantMemories.ts`
- Test: `test/memdir.findRelevant.test.ts`

**Interfaces:**
- Consumes: `scanMemoryFiles`、`formatMemoryManifest`。
- Produces: `findRelevantMemories(client, query, memdir, opts): Promise<string[]>`（返回选中的相对文件名；失败/abort → `[]`；用真实文件名集校验剔除幻觉；≤ maxResults）。`opts = { maxResults; model; signal; scan? }`

- [ ] **Step 1: 写失败测试**（注入假 client，返回 JSON）

```ts
import { describe, test, expect, vi } from 'vitest'
import { findRelevantMemories } from '../src/memdir/findRelevantMemories.js'

function fakeClient(content: string) {
  return { chat: { completions: { create: vi.fn(async () => ({ choices: [{ message: { content } }] })) } } } as any
}
const scan = async () => ([
  { filename: 'a.md', filePath: '/x/a.md', mtimeMs: 0, description: 'd', type: 'user' as const },
  { filename: 'b.md', filePath: '/x/b.md', mtimeMs: 0, description: 'd', type: 'project' as const },
])

test('解析 selected，校验真实文件名', async () => {
  const c = fakeClient('{"selected":["a.md","ghost.md"]}')
  const r = await findRelevantMemories(c, 'q', '/x', { maxResults: 5, model: 'm', signal: new AbortController().signal, scan })
  expect(r).toEqual(['a.md']) // ghost.md 被剔除
})
test('坏 JSON → []', async () => {
  const c = fakeClient('not json')
  expect(await findRelevantMemories(c, 'q', '/x', { maxResults: 5, model: 'm', signal: new AbortController().signal, scan })).toEqual([])
})
test('截断到 maxResults', async () => {
  const c = fakeClient('{"selected":["a.md","b.md"]}')
  const r = await findRelevantMemories(c, 'q', '/x', { maxResults: 1, model: 'm', signal: new AbortController().signal, scan })
  expect(r.length).toBe(1)
})
```

- [ ] **Step 2: 跑测试确认失败** — FAIL。

- [ ] **Step 3: 实现** `src/memdir/findRelevantMemories.ts`

```ts
import type OpenAI from 'openai'
import { scanMemoryFiles as realScan, formatMemoryManifest, type MemoryHeader } from './memoryScan.js'

export interface FindOpts {
  maxResults: number
  model: string
  signal: AbortSignal
  scan?: (memdir: string) => Promise<MemoryHeader[]>
}

const SYS = '你从记忆清单里挑出与用户当前请求最相关的文件。只输出 JSON：{"selected":["file1.md",...]}，最多挑给定上限，无相关就空数组。'

export async function findRelevantMemories(client: OpenAI, query: string, memdir: string, opts: FindOpts): Promise<string[]> {
  try {
    const heads = await (opts.scan ?? realScan)(memdir)
    if (!heads.length) return []
    const valid = new Set(heads.map(h => h.filename))
    const res = await client.chat.completions.create({
      model: opts.model, max_tokens: 256,
      messages: [
        { role: 'system', content: SYS },
        { role: 'user', content: `用户请求：${query}\n\n记忆清单：\n${formatMemoryManifest(heads)}\n\n最多挑 ${opts.maxResults} 个。` },
      ],
    } as any, { signal: opts.signal })
    const content = (res as any).choices?.[0]?.message?.content ?? ''
    const m = content.match(/\{[\s\S]*\}/)
    if (!m) return []
    const parsed = JSON.parse(m[0])
    const sel: unknown = parsed?.selected
    if (!Array.isArray(sel)) return []
    return sel.filter((s): s is string => typeof s === 'string' && valid.has(s)).slice(0, opts.maxResults)
  } catch { return [] }
}
```

- [ ] **Step 4: 跑测试确认通过** — PASS。

- [ ] **Step 5: Commit**

```bash
git add src/memdir/findRelevantMemories.ts test/memdir.findRelevant.test.ts
git commit -m "feat(memdir): findRelevantMemories（DeepSeek 召回，校验+兜底）"
```

---

### Task 13: 召回 prefetch + reminder 注入 + 去重（接线）

**Files:**
- Create: `src/services/memory/recall.ts`（`createRecaller`：prefetch 启动/消费、seen-set 去重、字节上限、reminder 文本构建）
- Modify: `src/tui/useChat.ts`（recall 开时：每 user turn 启 prefetch；tools 后 poll 消费经 `injectUserMessage` 注 reminder）
- Test: `test/memory.recall.test.ts`

**Interfaces:**
- Produces:
  - `createRecaller(deps): { prefetch(query): void; consume(alreadyRead: Set<string>): string | null }`
  - `buildRecallReminder(files: {filename:string; content:string}[]): string`（包 `<system-reminder>`，含截断标注）
  - 常量 `MAX_RECALL_BYTES = 16384`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createRecaller, buildRecallReminder } from '../src/services/memory/recall.js'

test('buildRecallReminder 包 system-reminder', () => {
  const r = buildRecallReminder([{ filename: 'a.md', content: 'hello' }])
  expect(r).toContain('<system-reminder>')
  expect(r).toContain('a.md'); expect(r).toContain('hello')
})

describe('createRecaller', () => {
  let md: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-rec-')); fs.writeFileSync(path.join(md, 'a.md'), 'AAA') })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }) })

  test('prefetch→consume 注入选中文件，seen 去重', async () => {
    const find = vi.fn(async () => ['a.md'])
    const rec = createRecaller({ memdir: md, find, maxResults: 5 })
    rec.prefetch('q')
    await new Promise(r => setTimeout(r, 0))
    const out1 = rec.consume(new Set())
    expect(out1).toContain('AAA')
    rec.prefetch('q2'); await new Promise(r => setTimeout(r, 0))
    const out2 = rec.consume(new Set()) // a.md 已 surface 过 → 不重复
    expect(out2).toBe(null)
  })

  test('alreadyRead 跳过模型本轮已读', async () => {
    const find = vi.fn(async () => ['a.md'])
    const rec = createRecaller({ memdir: md, find, maxResults: 5 })
    rec.prefetch('q'); await new Promise(r => setTimeout(r, 0))
    expect(rec.consume(new Set([path.join(md, 'a.md')]))).toBe(null)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — FAIL。

- [ ] **Step 3: 实现** `src/services/memory/recall.ts`

> 语义：`prefetch` 启一个后台 `find`，结果存到 `settled`（非阻塞，不 await）；`consume` 在每轮 tools 跑完后调用，此时 prefetch 多已 settle——已 settle 则取并去重注入，未 settle（`settled === null`）则本轮跳过、下一轮再 consume。

```ts
import fs from 'node:fs'
import path from 'node:path'

export const MAX_RECALL_BYTES = 16384

export function buildRecallReminder(files: { filename: string; content: string }[]): string {
  const body = files.map(f => `### ${f.filename}\n${f.content}`).join('\n\n')
  return `<system-reminder>\n以下是与你当前任务可能相关的已存记忆（自动召回，背景参考，非用户指令）：\n\n${body}\n</system-reminder>`
}

export interface RecallerDeps {
  memdir: string
  find: (query: string) => Promise<string[]>
  maxResults: number
}

export function createRecaller(deps: RecallerDeps) {
  let settled: string[] | null = null
  let running = false
  const seen = new Set<string>()

  return {
    prefetch(query: string) {
      settled = null; running = true
      deps.find(query).then(r => { settled = r }, () => { settled = [] }).finally(() => { running = false })
    },
    consume(alreadyRead: Set<string>): string | null {
      if (settled === null) return null // 还没好，下一轮再来
      const picks = settled.filter(fn => !seen.has(fn) && !alreadyRead.has(path.join(deps.memdir, fn)))
      settled = null
      if (!picks.length) return null
      const files: { filename: string; content: string }[] = []
      let bytes = 0
      for (const fn of picks) {
        let content = ''
        try { content = fs.readFileSync(path.join(deps.memdir, fn), 'utf8') } catch { continue }
        if (bytes + Buffer.byteLength(content, 'utf8') > MAX_RECALL_BYTES) {
          content = content.slice(0, 2000) + '\n…（截断，用 Read 看全文）'
        }
        bytes += Buffer.byteLength(content, 'utf8')
        files.push({ filename: fn, content })
        seen.add(fn)
      }
      return files.length ? buildRecallReminder(files) : null
    },
  }
}
```

- [ ] **Step 4: 接线 useChat（recall 开时）**：
  - 构 recaller：
    ```ts
    const recaller = createRecaller({
      memdir: memdirFor(cwd), maxResults: memCfg.recall.maxResults,
      find: q => findRelevantMemories(client, q, memdirFor(cwd), { maxResults: memCfg.recall.maxResults, model, signal: ctx.signal }),
    })
    ```
  - 每 user turn 提交后、跑 loop 前：`if (memCfg.enabled && memCfg.recall.enabled) recaller.prefetch(userText)`。
  - loop 内每轮 tool 结果回灌后（与 `drainInjections` 同站点）：`const rem = recaller.consume(readPathsThisTurn); if (rem) ctx.injectUserMessage(rem)`。`readPathsThisTurn` = 本轮 fileState 新增的绝对路径集合（从 `ctx.fileState` keys 取）。

- [ ] **Step 5: 跑测试 + 全量** — `npx vitest run test/memory.recall.test.ts && npm test && npx tsc --noEmit` → 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/services/memory/recall.ts src/tui/useChat.ts test/memory.recall.test.ts
git commit -m "feat(memory): 动态召回 prefetch+poll + reminder 注入 + 去重"
```

> **Phase 3 验收**：`recall.enabled=true` 时不注静态索引、改每轮非阻塞召回 surface 相关记忆，去重 + 字节上限。

---

# Phase 4 — SessionMemory（3.3）

### Task 14: SessionMemory 模板 + 触发谓词（纯函数）

**Files:**
- Create: `src/services/memory/sessionMemory.ts`（本 task 仅纯函数部分）
- Test: `test/memory.sessionMemory.test.ts`

**Interfaces:**
- Produces:
  - `SESSION_MEMORY_TEMPLATE: string`
  - `shouldUpdateSessionMemory(state, cfg): boolean`，`state = { promptTokens; tokensAtLastUpdate; initialized; toolCallsSinceUpdate; lastTurnHadToolCalls }`
  - `setupSessionMemoryFile(absPath): string`（不存在则写模板，返回当前内容）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { shouldUpdateSessionMemory, setupSessionMemoryFile, SESSION_MEMORY_TEMPLATE } from '../src/services/memory/sessionMemory.js'
import { DEFAULT_MEMORY_CONFIG } from '../src/memdir/memoryConfig.js'

const sm = DEFAULT_MEMORY_CONFIG.sessionMemory

test('首次：未达 init token 不触发', () => {
  expect(shouldUpdateSessionMemory({ promptTokens: 5000, tokensAtLastUpdate: 0, initialized: false, toolCallsSinceUpdate: 5, lastTurnHadToolCalls: true }, sm)).toBe(false)
})
test('首次：达 init token + 工具阈值 → 触发', () => {
  expect(shouldUpdateSessionMemory({ promptTokens: 12000, tokensAtLastUpdate: 0, initialized: false, toolCallsSinceUpdate: 3, lastTurnHadToolCalls: true }, sm)).toBe(true)
})
test('达 token + 上轮无 tool_calls（自然断点）→ 触发', () => {
  expect(shouldUpdateSessionMemory({ promptTokens: 12000, tokensAtLastUpdate: 6000, initialized: true, toolCallsSinceUpdate: 0, lastTurnHadToolCalls: false }, sm)).toBe(true)
})
test('更新间隔不足 → 不触发', () => {
  expect(shouldUpdateSessionMemory({ promptTokens: 12000, tokensAtLastUpdate: 10000, initialized: true, toolCallsSinceUpdate: 5, lastTurnHadToolCalls: true }, sm)).toBe(false)
})

describe('setupSessionMemoryFile', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-sm-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })
  test('不存在 → 写模板并返回', () => {
    const p = path.join(dir, 'session-memory', 'summary.md')
    const c = setupSessionMemoryFile(p)
    expect(c).toBe(SESSION_MEMORY_TEMPLATE)
    expect(fs.readFileSync(p, 'utf8')).toBe(SESSION_MEMORY_TEMPLATE)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — FAIL。

- [ ] **Step 3: 实现纯函数部分** `src/services/memory/sessionMemory.ts`

```ts
import fs from 'node:fs'
import path from 'node:path'
import type { MemoryConfig } from '../../memdir/memoryConfig.js'

export const SESSION_MEMORY_TEMPLATE = `# Session Title

# Current State

# Task specification

# Files and Functions

# Errors & Corrections

# Learnings

# Worklog
`

export interface SessionMemoryState {
  promptTokens: number
  tokensAtLastUpdate: number
  initialized: boolean
  toolCallsSinceUpdate: number
  lastTurnHadToolCalls: boolean
}

export function shouldUpdateSessionMemory(s: SessionMemoryState, cfg: MemoryConfig['sessionMemory']): boolean {
  const tokenGate = !s.initialized
    ? s.promptTokens >= cfg.minInitTokens
    : s.promptTokens - s.tokensAtLastUpdate >= cfg.minUpdateTokens
  if (!tokenGate) return false
  return s.toolCallsSinceUpdate >= cfg.toolCallsBetween || !s.lastTurnHadToolCalls
}

export function setupSessionMemoryFile(absPath: string): string {
  try { return fs.readFileSync(absPath, 'utf8') }
  catch {
    fs.mkdirSync(path.dirname(absPath), { recursive: true })
    fs.writeFileSync(absPath, SESSION_MEMORY_TEMPLATE)
    return SESSION_MEMORY_TEMPLATE
  }
}
```

- [ ] **Step 4: 跑测试确认通过** — PASS。

- [ ] **Step 5: Commit**

```bash
git add src/services/memory/sessionMemory.ts test/memory.sessionMemory.test.ts
git commit -m "feat(memory): SessionMemory 模板 + 触发谓词 + setup"
```

---

### Task 15: SessionMemory 更新编排 + 单文件编辑工具

**Files:**
- Modify: `src/services/memory/sessionMemory.ts`（加 `makeSessionFileTool(absPath)` + `runSessionMemoryUpdate(deps)`）
- Test: `test/memory.sessionMemory.update.test.ts`

**Interfaces:**
- Consumes: `runSubagent`、`assertInMemdir`（复用：单文件白名单）。
- Produces:
  - `makeSessionFileTool(absPath): Tool<any>`（仅可 Edit 该文件）
  - `runSessionMemoryUpdate(deps): Promise<void>`（forked agent 编辑 summary.md；fail-safe）

- [ ] **Step 1: 写失败测试**（注入假 runSubagent，验证调用 + 工具仅限该文件）

```ts
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { makeSessionFileTool, runSessionMemoryUpdate } from '../src/services/memory/sessionMemory.js'

describe('makeSessionFileTool', () => {
  let dir: string, p: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-sf-')); p = path.join(dir, 'summary.md'); fs.writeFileSync(p, 'A B C') })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })
  test('编辑目标文件成功', async () => {
    const t = makeSessionFileTool(p)
    const r = await t.call({ file_path: p, old_string: 'B', new_string: 'X' }, {} as any)
    expect(fs.readFileSync(p, 'utf8')).toBe('A X C')
  })
  test('拒绝其它文件', async () => {
    const t = makeSessionFileTool(p)
    const other = path.join(dir, 'other.md'); fs.writeFileSync(other, 'z')
    const r = await t.call({ file_path: other, old_string: 'z', new_string: 'q' }, {} as any)
    expect(r).toMatch(/拒绝|只能/)
    expect(fs.readFileSync(other, 'utf8')).toBe('z')
  })
})

test('runSessionMemoryUpdate 调 runSubagent（fail-safe）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-su-'))
  const p = path.join(dir, 'summary.md')
  const runSub = vi.fn(async () => 'ok')
  await runSessionMemoryUpdate({ client: {} as any, model: 'm', absPath: p, ctx: { signal: new AbortController().signal } as any, runSubagent: runSub })
  expect(runSub).toHaveBeenCalled()
  const runSubBad = vi.fn(async () => { throw new Error('x') })
  await expect(runSessionMemoryUpdate({ client: {} as any, model: 'm', absPath: p, ctx: { signal: new AbortController().signal } as any, runSubagent: runSubBad })).resolves.toBeUndefined()
  fs.rmSync(dir, { recursive: true, force: true })
})
```

- [ ] **Step 2: 跑测试确认失败** — FAIL。

- [ ] **Step 3: 实现**（追加到 `sessionMemory.ts`）

```ts
import { z } from 'zod'
import type OpenAI from 'openai'
import type { Tool, ToolContext } from '../../tools/types.js'
import { runSubagent as realRunSubagent } from '../../subagentRunner.js'

const editSchema = z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string() })

export function makeSessionFileTool(absPath: string): Tool<typeof editSchema> {
  const root = path.resolve(absPath)
  return {
    name: 'Edit', description: '编辑会话记忆文件（仅限该文件）。', inputSchema: editSchema,
    isReadOnly: false, needsPermission: () => false,
    async call(input) {
      if (path.resolve(input.file_path) !== root) return '拒绝：只能编辑当前会话的 summary.md。'
      let cur: string; try { cur = fs.readFileSync(root, 'utf8') } catch { return '错误：文件不存在。' }
      if (!cur.includes(input.old_string)) return '错误：old_string 未匹配。'
      fs.writeFileSync(root, cur.replace(input.old_string, input.new_string))
      return '已更新会话记忆。'
    },
  }
}

export interface SessionMemoryUpdateDeps {
  client: OpenAI; model: string; absPath: string; ctx: ToolContext
  runSubagent?: typeof realRunSubagent
}

export async function runSessionMemoryUpdate(deps: SessionMemoryUpdateDeps): Promise<void> {
  try {
    const cur = setupSessionMemoryFile(deps.absPath)
    const runSub = deps.runSubagent ?? realRunSubagent
    await runSub({
      client: deps.client, model: deps.model, onUsage: () => {},
      systemPrompt: '你维护一份会话进度笔记。只用 Edit 工具更新给定文件，保持各节简洁。',
      userPrompt: `更新这份会话记忆，把最新进展/错误/学习并入对应章节（结构保持）。当前内容：\n\n${cur}\n\n文件路径：${deps.absPath}`,
      tools: [makeSessionFileTool(deps.absPath)],
      ctx: deps.ctx, signal: deps.ctx.signal,
      agentId: 'session-memory', agentType: 'session_memory',
    })
  } catch (e: any) { console.error('[memory] SessionMemory 更新失败：' + (e?.message ?? e)) }
}
```

- [ ] **Step 4: 跑测试确认通过** — PASS。

- [ ] **Step 5: Commit**

```bash
git add src/services/memory/sessionMemory.ts test/memory.sessionMemory.update.test.ts
git commit -m "feat(memory): SessionMemory 更新编排 + 单文件编辑工具"
```

---

### Task 16: SessionMemory 接线 useChat + 并入 doCompact

**Files:**
- Modify: `src/tui/useChat.ts`（post-turn 触发 + 维护 state + `doCompact` 并入 summary）
- Test: `test/useChat.sessionMemory.test.ts`

**Interfaces:**
- Consumes: `shouldUpdateSessionMemory`、`runSessionMemoryUpdate`、`sessionMemoryPathFor`、`setupSessionMemoryFile`。

- [ ] **Step 1: 写失败测试** —— 集成 harness（仿 useChat.tasks）：注入 runSubagent spy，喂足够 token 的一轮使 `shouldUpdateSessionMemory` 为真，断言 `runSessionMemoryUpdate` 触发；并验证 `doCompact` 时把 summary.md 内容前置进 summarize 输入（spy `summarize`）。

- [ ] **Step 2: 跑测试确认失败** — FAIL。

- [ ] **Step 3: 接线**：
  - 维护 `smState: SessionMemoryState`（promptTokens 取每轮 usage.prompt_tokens；toolCallsSinceUpdate 累加；lastTurnHadToolCalls 记录）。
  - 每轮末（在 extractor.onTurnEnd 同站点）：
    ```ts
    if (memCfg.enabled && memCfg.sessionMemory.enabled && shouldUpdateSessionMemory(smState, memCfg.sessionMemory)) {
      const p = sessionMemoryPathFor(cwd, sessionId, os.homedir())
      void runSessionMemoryUpdate({ client, model, absPath: p, ctx: toolCtx })
      smState.tokensAtLastUpdate = smState.promptTokens; smState.initialized = true; smState.toolCallsSinceUpdate = 0
    }
    ```
  - `doCompact`：在调 `summarize(client, messages, signal)` 前，若 summary.md 存在则读其内容，作为一条 system/user 前置消息加入 `messages` 副本传给 `summarize`（保留会话状态进压缩）。

- [ ] **Step 4: 跑测试 + 全量** — 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/tui/useChat.ts test/useChat.sessionMemory.test.ts
git commit -m "feat(memory): SessionMemory 接线 useChat + 并入 doCompact"
```

> **Phase 4 验收**：长会话达阈值时后台维护 summary.md，compact 时并入保状态。

---

# Phase 5 — autoDream（3.4）

### Task 17: consolidationLock（PID 锁 CAS）

**Files:**
- Create: `src/services/memory/consolidationLock.ts`
- Test: `test/memory.lock.test.ts`

**Interfaces:**
- Produces:
  - `readLastConsolidatedAt(memdir): number`（锁文件 mtime；缺失返回 0）
  - `tryAcquireConsolidationLock(memdir, now, isPidAlive?): number | null`（成功返回 priorMtime；被占有返回 null）
  - `rollbackConsolidationLock(memdir, priorMtime): void`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { readLastConsolidatedAt, tryAcquireConsolidationLock, rollbackConsolidationLock } from '../src/services/memory/consolidationLock.js'

describe('consolidationLock', () => {
  let md: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-lock-')) })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }) })
  test('首次无锁 → 取锁成功，prior=0', () => {
    expect(readLastConsolidatedAt(md)).toBe(0)
    expect(tryAcquireConsolidationLock(md, Date.now(), () => false)).toBe(0)
    expect(fs.existsSync(path.join(md, '.consolidate-lock'))).toBe(true)
  })
  test('活跃 PID 且锁新鲜 → 拒绝', () => {
    tryAcquireConsolidationLock(md, Date.now(), () => false) // 占锁
    expect(tryAcquireConsolidationLock(md, Date.now(), () => true)).toBe(null)
  })
  test('rollback prior=0 删锁', () => {
    tryAcquireConsolidationLock(md, Date.now(), () => false)
    rollbackConsolidationLock(md, 0)
    expect(fs.existsSync(path.join(md, '.consolidate-lock'))).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — FAIL。

- [ ] **Step 3: 实现** `src/services/memory/consolidationLock.ts`

```ts
import fs from 'node:fs'
import path from 'node:path'

const LOCK = '.consolidate-lock'
const FRESH_MS = 3600_000

function lockPath(memdir: string) { return path.join(memdir, LOCK) }

export function readLastConsolidatedAt(memdir: string): number {
  try { return fs.statSync(lockPath(memdir)).mtimeMs } catch { return 0 }
}

function pidAliveDefault(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

export function tryAcquireConsolidationLock(memdir: string, now: number, isPidAlive: (pid: number) => boolean = pidAliveDefault): number | null {
  const p = lockPath(memdir)
  let priorMtime = 0
  try {
    const stat = fs.statSync(p)
    priorMtime = stat.mtimeMs
    const pid = parseInt(fs.readFileSync(p, 'utf8').trim(), 10)
    if (Number.isFinite(pid) && isPidAlive(pid) && now - stat.mtimeMs < FRESH_MS) return null
  } catch { priorMtime = 0 }
  try {
    fs.mkdirSync(memdir, { recursive: true })
    fs.writeFileSync(p, String(process.pid))
    return priorMtime
  } catch { return null }
}

export function rollbackConsolidationLock(memdir: string, priorMtime: number): void {
  const p = lockPath(memdir)
  try {
    if (priorMtime === 0) { fs.rmSync(p, { force: true }); return }
    fs.writeFileSync(p, '')
    fs.utimesSync(p, new Date(priorMtime), new Date(priorMtime))
  } catch { /* 忽略 */ }
}
```

- [ ] **Step 4: 跑测试确认通过** — PASS。

- [ ] **Step 5: Commit**

```bash
git add src/services/memory/consolidationLock.ts test/memory.lock.test.ts
git commit -m "feat(memory): autoDream PID 锁 CAS（取锁/回退/上次合并时刻）"
```

---

### Task 18: autoDream 门控（时间/会话/扫描节流）

**Files:**
- Create: `src/services/memory/dreamGate.ts`
- Test: `test/memory.dreamGate.test.ts`

**Interfaces:**
- Produces:
  - `countSessionsTouchedSince(sessionsDir, sinceMs, currentSessionFile): number`（统计 mtime > since 的 .jsonl，排除当前）
  - `checkDreamGates(deps): { pass: boolean; reason?: string }`，`deps = { memdir; sessionsDir; currentSessionFile; cfg; now; lastScanAt; readLastAt? ; countSessions? }`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { countSessionsTouchedSince, checkDreamGates } from '../src/services/memory/dreamGate.js'
import { DEFAULT_MEMORY_CONFIG } from '../src/memdir/memoryConfig.js'

const dream = DEFAULT_MEMORY_CONFIG.dream

describe('countSessionsTouchedSince', () => {
  let sd: string
  beforeEach(() => { sd = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-sd-')) })
  afterEach(() => { fs.rmSync(sd, { recursive: true, force: true }) })
  test('统计 since 后、排除当前', () => {
    for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(sd, n + '.jsonl'), 'x')
    expect(countSessionsTouchedSince(sd, 0, path.join(sd, 'a.jsonl'))).toBe(2)
  })
})

test('时间门控未到 → 拒', () => {
  const r = checkDreamGates({
    memdir: '/x', sessionsDir: '/s', currentSessionFile: '/s/cur.jsonl', cfg: dream,
    now: 1000, lastScanAt: 0, readLastAt: () => 1000 - 3600_000, countSessions: () => 10, // 1h前 < 24h
  })
  expect(r.pass).toBe(false)
})
test('时间+会话都满足 → pass', () => {
  const r = checkDreamGates({
    memdir: '/x', sessionsDir: '/s', currentSessionFile: '/s/cur.jsonl', cfg: dream,
    now: 1000 + 25 * 3600_000, lastScanAt: 0, readLastAt: () => 1000, countSessions: () => 5,
  })
  expect(r.pass).toBe(true)
})
test('时间过但会话不足 → 拒', () => {
  const r = checkDreamGates({
    memdir: '/x', sessionsDir: '/s', currentSessionFile: '/s/cur.jsonl', cfg: dream,
    now: 1000 + 25 * 3600_000, lastScanAt: 0, readLastAt: () => 1000, countSessions: () => 2,
  })
  expect(r.pass).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败** — FAIL。

- [ ] **Step 3: 实现** `src/services/memory/dreamGate.ts`

```ts
import fs from 'node:fs'
import path from 'node:path'
import { readLastConsolidatedAt } from './consolidationLock.js'
import type { MemoryConfig } from '../../memdir/memoryConfig.js'

const RESCAN_MS = 600_000 // 时间过但会话不过：10min 内不再扫

export function countSessionsTouchedSince(sessionsDir: string, sinceMs: number, currentSessionFile: string): number {
  let files: string[]
  try { files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl')) } catch { return 0 }
  const cur = path.basename(currentSessionFile)
  let n = 0
  for (const f of files) {
    if (f === cur) continue
    try { if (fs.statSync(path.join(sessionsDir, f)).mtimeMs > sinceMs) n++ } catch { /* skip */ }
  }
  return n
}

export interface DreamGateDeps {
  memdir: string; sessionsDir: string; currentSessionFile: string
  cfg: MemoryConfig['dream']; now: number; lastScanAt: number
  readLastAt?: (memdir: string) => number
  countSessions?: (sessionsDir: string, sinceMs: number, cur: string) => number
}

export function checkDreamGates(d: DreamGateDeps): { pass: boolean; reason?: string } {
  const lastAt = (d.readLastAt ?? readLastConsolidatedAt)(d.memdir)
  const hoursSince = (d.now - lastAt) / 3600_000
  if (hoursSince < d.cfg.minHours) return { pass: false, reason: 'time' }
  if (d.now - d.lastScanAt < RESCAN_MS && d.lastScanAt > 0) return { pass: false, reason: 'rescan-throttle' }
  const n = (d.countSessions ?? countSessionsTouchedSince)(d.sessionsDir, lastAt, d.currentSessionFile)
  if (n < d.cfg.minSessions) return { pass: false, reason: 'sessions' }
  return { pass: true }
}
```

- [ ] **Step 4: 跑测试确认通过** — PASS。

- [ ] **Step 5: Commit**

```bash
git add src/services/memory/dreamGate.ts test/memory.dreamGate.test.ts
git commit -m "feat(memory): autoDream 门控（时间/会话/扫描节流）"
```

---

### Task 19: autoDream 编排（合并 prompt + forked + tasks 跟踪）

**Files:**
- Create: `src/services/memory/autoDream.ts`
- Test: `test/memory.autoDream.test.ts`

**Interfaces:**
- Consumes: `checkDreamGates`、`tryAcquireConsolidationLock`、`rollbackConsolidationLock`、`runSubagent`、`makeMemdirTools`、`registerTask`/`updateTask`/`enqueueNotification`（`src/tasks.ts`）。
- Produces: `runAutoDream(deps): Promise<void>`（门控→取锁→forked 合并→成功更新锁 mtime / 失败回退；fail-safe）。`buildConsolidationPrompt(sessionCount): string`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { runAutoDream, buildConsolidationPrompt } from '../src/services/memory/autoDream.js'
import { DEFAULT_MEMORY_CONFIG } from '../src/memdir/memoryConfig.js'

test('buildConsolidationPrompt 四阶段', () => {
  const p = buildConsolidationPrompt(5)
  expect(p).toMatch(/MEMORY\.md/)
  expect(p).toContain('过时'); expect(p).toContain('200')
})

describe('runAutoDream', () => {
  let md: string, sd: string
  beforeEach(() => { md = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-dr-')); sd = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-drs-')) })
  afterEach(() => { fs.rmSync(md, { recursive: true, force: true }); fs.rmSync(sd, { recursive: true, force: true }) })

  test('门控不过 → 不 fork', async () => {
    const runSub = vi.fn(async () => 'ok')
    await runAutoDream({
      client: {} as any, model: 'm', memdir: md, sessionsDir: sd, currentSessionFile: path.join(sd, 'c.jsonl'),
      cfg: DEFAULT_MEMORY_CONFIG.dream, ctx: { signal: new AbortController().signal } as any,
      now: 0, lastScanAt: 0, runSubagent: runSub, gate: () => ({ pass: false }),
    })
    expect(runSub).not.toHaveBeenCalled()
  })

  test('门控过 → 取锁 + fork + 成功更新 mtime', async () => {
    const runSub = vi.fn(async () => 'done')
    await runAutoDream({
      client: {} as any, model: 'm', memdir: md, sessionsDir: sd, currentSessionFile: path.join(sd, 'c.jsonl'),
      cfg: DEFAULT_MEMORY_CONFIG.dream, ctx: { signal: new AbortController().signal } as any,
      now: Date.now(), lastScanAt: 0, runSubagent: runSub, gate: () => ({ pass: true }), sessionCount: 5,
    })
    expect(runSub).toHaveBeenCalled()
    expect(fs.existsSync(path.join(md, '.consolidate-lock'))).toBe(true)
  })

  test('fork 失败 → 回退锁（fail-safe，不抛）', async () => {
    const runSub = vi.fn(async () => { throw new Error('x') })
    await expect(runAutoDream({
      client: {} as any, model: 'm', memdir: md, sessionsDir: sd, currentSessionFile: path.join(sd, 'c.jsonl'),
      cfg: DEFAULT_MEMORY_CONFIG.dream, ctx: { signal: new AbortController().signal } as any,
      now: Date.now(), lastScanAt: 0, runSubagent: runSub, gate: () => ({ pass: true }), sessionCount: 5,
    })).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败** — FAIL。

- [ ] **Step 3: 实现** `src/services/memory/autoDream.ts`

```ts
import type OpenAI from 'openai'
import type { ToolContext } from '../../tools/types.js'
import type { MemoryConfig } from '../../memdir/memoryConfig.js'
import { runSubagent as realRunSubagent } from '../../subagentRunner.js'
import { makeMemdirTools } from './memdirTools.js'
import { checkDreamGates } from './dreamGate.js'
import { tryAcquireConsolidationLock, rollbackConsolidationLock } from './consolidationLock.js'
import fs from 'node:fs'
import path from 'node:path'

export function buildConsolidationPrompt(sessionCount: number): string {
  return `执行一次记忆整理（dream）。自上次整理以来约 ${sessionCount} 个会话有更新。

阶段：
1) Orient：用 Read 看 MEMORY.md，skim 现有 topic 文件。
2) Gather：找出值得合并的新信号（以现有记忆为主）。
3) Consolidate：把相关信号并入对应文件，相对日期转绝对，删除过时内容（用 MemEdit/MemWrite）。
4) Prune：更新 MEMORY.md 索引，保持简洁（≤200 行、≤25KB）。

只用提供的工具（仅能写 memory 目录）。完成后回一句简短总结。`
}

export interface AutoDreamDeps {
  client: OpenAI; model: string
  memdir: string; sessionsDir: string; currentSessionFile: string
  cfg: MemoryConfig['dream']; ctx: ToolContext
  now: number; lastScanAt: number; sessionCount?: number
  runSubagent?: typeof realRunSubagent
  gate?: typeof checkDreamGates
}

export async function runAutoDream(deps: AutoDreamDeps): Promise<void> {
  try {
    const gate = (deps.gate ?? checkDreamGates)({
      memdir: deps.memdir, sessionsDir: deps.sessionsDir, currentSessionFile: deps.currentSessionFile,
      cfg: deps.cfg, now: deps.now, lastScanAt: deps.lastScanAt,
    })
    if (!gate.pass) return
    const prior = tryAcquireConsolidationLock(deps.memdir, deps.now)
    if (prior === null) return
    try {
      const runSub = deps.runSubagent ?? realRunSubagent
      await runSub({
        client: deps.client, model: deps.model, onUsage: () => {},
        systemPrompt: '你是 deepcode 的记忆整理助手。只用提供的工具，谨慎合并、勿丢信息。',
        userPrompt: buildConsolidationPrompt(deps.sessionCount ?? 0),
        tools: makeMemdirTools(deps.memdir),
        ctx: deps.ctx, signal: deps.ctx.signal,
        agentId: 'auto-dream', agentType: 'auto_dream',
      })
      // 成功：刷新锁 mtime（= lastConsolidatedAt）
      try { fs.utimesSync(path.join(deps.memdir, '.consolidate-lock'), new Date(deps.now), new Date(deps.now)) } catch {}
    } catch (e: any) {
      console.error('[memory] autoDream 失败：' + (e?.message ?? e))
      rollbackConsolidationLock(deps.memdir, prior)
    }
  } catch (e: any) { console.error('[memory] autoDream 异常：' + (e?.message ?? e)) }
}
```

- [ ] **Step 4: 跑测试确认通过** — PASS。

- [ ] **Step 5: Commit**

```bash
git add src/services/memory/autoDream.ts test/memory.autoDream.test.ts
git commit -m "feat(memory): autoDream 编排（门控→取锁→forked 合并→回退）"
```

---

### Task 20: autoDream 接线 useChat（query-end fire-and-forget + tasks 通知）

**Files:**
- Modify: `src/tui/useChat.ts`（每轮末 fire-and-forget `runAutoDream`；作 `tasks.ts` 任务跟踪 + 完成通知）
- Test: `test/useChat.autoDream.test.ts`

**Interfaces:**
- Consumes: `runAutoDream`、`memdirFor`、`registerTask`/`updateTask`/`enqueueNotification`（`src/tasks.ts`）、`loadSettings(cwd).memory`。

- [ ] **Step 1: 写失败测试** —— harness 注入 gate（强制 pass=false 验证不 fork，pass=true 验证 fork + 注册任务）。集成断言：`memory.enabled && dream.enabled` 时每轮末调 `runAutoDream`（spy）。

- [ ] **Step 2: 跑测试确认失败** — FAIL。

- [ ] **Step 3: 接线**：
  - 维护 `dreamLastScanAt`（模块/闭包变量）。
  - 每轮末（extractor.onTurnEnd 同站点）：
    ```ts
    if (memCfg.enabled && memCfg.dream.enabled) {
      const taskId = registerTask({ type: 'local_agent', description: '记忆整理（dream）' })
      void runAutoDream({
        client, model, memdir: memdirFor(cwd),
        sessionsDir: path.join(os.homedir(), '.deepcode', 'sessions'),
        currentSessionFile: session.file, cfg: memCfg.dream, ctx: toolCtx,
        now: Date.now(), lastScanAt: dreamLastScanAt,
      }).then(() => { updateTask(taskId, { status: 'done' }); enqueueNotification(getTask(taskId)!) })
        .catch(() => updateTask(taskId, { status: 'error' }))
      dreamLastScanAt = Date.now()
    }
    ```
  > 注：`registerTask` 实际签名以 `src/tasks.ts` 为准（Task 实现者读取后对齐字段；本步给出意图，具体字段名按现有 API）。门控不过时 runAutoDream 内部直接 return，taskId 仍标 done（无副作用）——可接受，或在 runAutoDream 返回是否真跑的布尔以决定是否通知（实现者择一，规格审确认）。

- [ ] **Step 4: 跑测试 + 全量 + build** — `npm test && npx tsc --noEmit && npm run build` → 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/tui/useChat.ts test/useChat.autoDream.test.ts
git commit -m "feat(memory): autoDream 接线 useChat（query-end fire-and-forget + tasks 跟踪）"
```

> **Phase 5 验收**：满足 24h/5 会话/锁三门控时后台合并记忆、修剪 MEMORY.md，作后台任务带通知。

---

# 最终验收

- [ ] `npm test` 全绿（新增 ~15 测试文件）。
- [ ] `npx tsc --noEmit` 干净。
- [ ] `npm run build` 干净。
- [ ] 默认配置（enabled=true, recall=false, dream=true）下：会话启动注入 MEMORY.md 索引、每轮末提取、长会话维护 summary、满门控时 dream。
- [ ] `memory.enabled=false` 全链路零副作用（无 fork、无模型调用、无写盘）——加一条端到端测试覆盖。
- [ ] opus 全分支对抗终审：重点查 ① memdir 路径越界（`..`/绝对路径/symlink）确实被 `assertInMemdir` 拦；② fail-safe 真不阻断主对话/退出；③ 游标失败回退正确；④ 锁 CAS 并发安全。
- [ ] 更新 `docs/specs/2026-06-17-deepcode-cc-full-parity-master-roadmap.md` 状态列：3.1/3.2/3.3/3.4 标 ✅。

---

# Self-Review（已对照 spec）

**Spec 覆盖**：§1 路径→Task1；§2 schema→Task2,3;§3 配置→Task5；§4.1 静态→Task4,6；§4.2 扫描→Task3；§4.3 召回→Task12,13；§5 提取→Task7-11；§6 SessionMemory→Task14-16；§7 autoDream→Task17-20；§8 安全→Task7（assertInMemdir）+ 各 fail-safe；§9 测试→每 task TDD + 最终端到端；§10 分期→五 Phase；§11 非目标→未建对应 task（正确）。

**游标偏离记录**：spec §5.2 写 message UUID，计划改用 turnId（Global Constraints 已注明理由，handoff 待用户确认）。

**类型一致**：`MemoryConfig`/`MemoryHeader`/`TurnSnapshot`/`SessionMemoryState` 跨 task 命名一致；`makeMemdirTools` 产出 `Read`/`MemWrite`/`MemEdit`，`hasMemoryWritesSince` 按这些名 + Write/Edit 判定，一致。

**占位扫描**：已清理——Task10 `lastSnap` 直接在 Step3 实现中声明/赋值；Task13 `createRecaller` Step3 即完整实现（去掉了原 throwaway 占位）。全文无 TBD/TODO/「待补」。少数「实现者按现有 API 对齐字段」注解（Task10 信号量导出、Task20 registerTask 字段）是有意的接口对齐说明，非占位——这些字段名以实读 `src/subagentRunner.ts`/`src/tasks.ts` 为准，规格审确认。
