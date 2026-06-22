# C4 Notebook（NotebookRead + NotebookEdit）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** deepcode 把 `.ipynb` 当 Jupyter notebook 处理——Read 输出 cell 视图，新 NotebookEdit 工具做 cell 级 replace/insert/delete（纯 JSON 编辑不执行），Edit 拒绝 .ipynb 重定向。

**Architecture:** 新建 `src/notebook.ts` 纯工具模块（类型 + 解析/序列化 + cell 操作 + Read 格式化）；`read.ts` 检测 .ipynb 走 cell 视图（解析失败优雅回退纯文本）；新 `src/tools/notebookEdit.ts` 工具复用 edit.ts 的 read-before-edit 闸门；`edit.ts` 加 .ipynb 守卫；注册进 allTools。

**Tech Stack:** TypeScript/ESM、vitest、zod（工具 schema）、Node fs。零新增依赖。

## Global Constraints

- 测试框架 vitest；命令 `npx vitest run <file>`。全量门禁 `npm test` + `npx tsc --noEmit` + `npm run build` 全绿方可合并。
- 零新增 npm 依赖；不碰 TUI；无平台特定代码。
- 序列化对齐 CC：`JSON.stringify(nb, null, 1)`（indent=1）。
- 图像输出 → 文本占位 `[图像输出已省略]`（deepcode 文本终端无图像块）。
- 单 cell outputs 合计 >10000 字符 → 截断为 jq 提示（`LARGE_OUTPUT_THRESHOLD = 10000`）。
- cell id 缺失回退 `cell-{index}`；`resolveCellIndex` 先按 id 再解析 `cell-N`。
- insert 语义=在 cell_id **之后**插入；insert 必须指定 cell_type。
- replace/insert 的 code cell 重置 `execution_count=null`、`outputs=[]`。
- Edit 拒绝 .ipynb（重定向 NotebookEdit）；Write 保持允许。
- 测试用 `makeCtx(dir)`（`test/helpers.js`）+ tmpdir 临时文件，无需清理（mkdtemp）。

---

### Task 1: notebook.ts 类型 + parse/serialize/generateCellId

**Files:**
- Create: `src/notebook.ts`
- Test: `test/notebook.test.ts`

**Interfaces:**
- Produces:
  - `interface NotebookCell { cell_type: 'code'|'markdown'|'raw'; source: string|string[]; id?: string; execution_count?: number|null; outputs?: NotebookOutput[]; metadata?: Record<string, unknown> }`
  - `interface NotebookOutput { output_type: string; text?: string|string[]; data?: Record<string, unknown>; ename?: string; evalue?: string; traceback?: string[] }`
  - `interface NotebookContent { cells: NotebookCell[]; metadata?: { language_info?: { name?: string } } & Record<string, unknown>; nbformat?: number; nbformat_minor?: number }`
  - `function parseNotebook(content: string): NotebookContent | null`
  - `function serializeNotebook(nb: NotebookContent): string`
  - `function generateCellId(): string`

- [ ] **Step 1: Write the failing test**

Create `test/notebook.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseNotebook, serializeNotebook, generateCellId } from '../src/notebook.js'

const NB = {
  cells: [{ cell_type: 'code', source: 'print(1)', id: 'a1', outputs: [], execution_count: null }],
  metadata: { language_info: { name: 'python' } },
  nbformat: 4, nbformat_minor: 5,
}

describe('parseNotebook', () => {
  it('解析合法 notebook', () => {
    const nb = parseNotebook(JSON.stringify(NB))
    expect(nb?.cells.length).toBe(1)
    expect(nb?.cells[0].cell_type).toBe('code')
  })
  it('非法 JSON → null', () => {
    expect(parseNotebook('{not json')).toBeNull()
  })
  it('合法 JSON 但非 notebook（无 cells 数组）→ null', () => {
    expect(parseNotebook('{"foo":1}')).toBeNull()
    expect(parseNotebook('[]')).toBeNull()
  })
})

describe('serializeNotebook', () => {
  it('indent=1 且 round-trip 不丢内容', () => {
    const nb = parseNotebook(JSON.stringify(NB))!
    const out = serializeNotebook(nb)
    expect(out).toBe(JSON.stringify(NB, null, 1))
    expect(parseNotebook(out)).toEqual(nb)
  })
})

describe('generateCellId', () => {
  it('返回非空字符串且两次不同', () => {
    const a = generateCellId(); const b = generateCellId()
    expect(a).toBeTruthy(); expect(typeof a).toBe('string')
    expect(a).not.toBe(b)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/notebook.test.ts`
Expected: FAIL（`src/notebook.js` 不存在 / 函数未导出）

- [ ] **Step 3: Write minimal implementation**

Create `src/notebook.ts`:

```ts
// src/notebook.ts
// Jupyter notebook (.ipynb) 解析 / 序列化 / cell 操作 / Read 格式化（纯 JSON，不执行 kernel）。

export interface NotebookOutput {
  output_type: string
  text?: string | string[]
  data?: Record<string, unknown>
  ename?: string
  evalue?: string
  traceback?: string[]
}

export interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw'
  source: string | string[]
  id?: string
  execution_count?: number | null
  outputs?: NotebookOutput[]
  metadata?: Record<string, unknown>
}

export interface NotebookContent {
  cells: NotebookCell[]
  metadata?: { language_info?: { name?: string } } & Record<string, unknown>
  nbformat?: number
  nbformat_minor?: number
}

/** 解析 .ipynb 文本；非法 JSON 或非 notebook 结构（无 cells 数组）→ null。 */
export function parseNotebook(content: string): NotebookContent | null {
  try {
    const obj = JSON.parse(content)
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && Array.isArray(obj.cells)) {
      return obj as NotebookContent
    }
    return null
  } catch {
    return null
  }
}

/** 写回 .ipynb：对齐 CC，indent=1。 */
export function serializeNotebook(nb: NotebookContent): string {
  return JSON.stringify(nb, null, 1)
}

/** 生成新 cell 的随机 id。 */
export function generateCellId(): string {
  return Math.random().toString(16).slice(2, 10)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/notebook.test.ts && npx tsc --noEmit`
Expected: PASS；tsc 干净

- [ ] **Step 5: Commit**

```bash
git add src/notebook.ts test/notebook.test.ts
git commit -m "feat(c4): notebook.ts 类型 + parseNotebook/serializeNotebook/generateCellId"
```

---

### Task 2: resolveCellIndex + applyCellEdit

**Files:**
- Modify: `src/notebook.ts`（追加）
- Test: `test/notebook.test.ts`（追加）

**Interfaces:**
- Consumes: `NotebookContent`、`NotebookCell`、`generateCellId`（Task 1）
- Produces:
  - `function resolveCellIndex(nb: NotebookContent, cellId: string): number`
  - `interface CellEditArgs { cellId: string; newSource: string; cellType?: 'code'|'markdown'; editMode: 'replace'|'insert'|'delete' }`
  - `function applyCellEdit(nb: NotebookContent, args: CellEditArgs): { ok: true } | { ok: false; error: string }`

- [ ] **Step 1: Write the failing test**

追加到 `test/notebook.test.ts`：

```ts
import { resolveCellIndex, applyCellEdit } from '../src/notebook.js'

function mk() {
  return {
    cells: [
      { cell_type: 'code', source: 'a', id: 'a1', execution_count: 3, outputs: [{ output_type: 'stream', text: 'x' }] },
      { cell_type: 'markdown', source: '# h', id: 'm1' },
    ],
    metadata: {}, nbformat: 4, nbformat_minor: 5,
  } as any
}

describe('resolveCellIndex', () => {
  it('按 id 匹配', () => { expect(resolveCellIndex(mk(), 'm1')).toBe(1) })
  it('按 cell-N 匹配', () => { expect(resolveCellIndex(mk(), 'cell-0')).toBe(0) })
  it('未命中 → -1', () => { expect(resolveCellIndex(mk(), 'nope')).toBe(-1); expect(resolveCellIndex(mk(), 'cell-9')).toBe(-1) })
})

describe('applyCellEdit', () => {
  it('replace code cell：改 source 且清空 outputs/execution_count', () => {
    const nb = mk()
    const r = applyCellEdit(nb, { cellId: 'a1', newSource: 'b', editMode: 'replace' })
    expect(r.ok).toBe(true)
    expect(nb.cells[0].source).toBe('b')
    expect(nb.cells[0].outputs).toEqual([])
    expect(nb.cells[0].execution_count).toBeNull()
  })
  it('insert：在 cell_id 之后插入，生成 id，需 cell_type', () => {
    const nb = mk()
    const r = applyCellEdit(nb, { cellId: 'a1', newSource: 'new', cellType: 'code', editMode: 'insert' })
    expect(r.ok).toBe(true)
    expect(nb.cells.length).toBe(3)
    expect(nb.cells[1].source).toBe('new')
    expect(nb.cells[1].id).toBeTruthy()
    expect(nb.cells[1].outputs).toEqual([])
  })
  it('insert 缺 cell_type → error', () => {
    const r = applyCellEdit(mk(), { cellId: 'a1', newSource: 'x', editMode: 'insert' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('cell_type')
  })
  it('delete：移除该 cell', () => {
    const nb = mk()
    const r = applyCellEdit(nb, { cellId: 'a1', newSource: '', editMode: 'delete' })
    expect(r.ok).toBe(true)
    expect(nb.cells.length).toBe(1)
    expect(nb.cells[0].id).toBe('m1')
  })
  it('cell 未命中 → error', () => {
    const r = applyCellEdit(mk(), { cellId: 'nope', newSource: 'x', editMode: 'replace' })
    expect(r.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/notebook.test.ts -t applyCellEdit`
Expected: FAIL（未导出）

- [ ] **Step 3: Write minimal implementation**

追加到 `src/notebook.ts`：

```ts
/** 解析 cell_id：先按 cell.id，再解析 cell-N（越界 → -1），否则 -1。 */
export function resolveCellIndex(nb: NotebookContent, cellId: string): number {
  const byId = nb.cells.findIndex(c => c.id === cellId)
  if (byId !== -1) return byId
  const m = cellId.match(/^cell-(\d+)$/)
  if (m) {
    const i = parseInt(m[1], 10)
    if (i >= 0 && i < nb.cells.length) return i
  }
  return -1
}

export interface CellEditArgs {
  cellId: string
  newSource: string
  cellType?: 'code' | 'markdown'
  editMode: 'replace' | 'insert' | 'delete'
}

/** 就地修改 nb：replace/insert/delete。insert 必须 cellType，在 cellId 之后插入；replace/insert 的 code cell 清空 execution_count/outputs。 */
export function applyCellEdit(
  nb: NotebookContent,
  args: CellEditArgs,
): { ok: true } | { ok: false; error: string } {
  const { cellId, newSource, cellType, editMode } = args
  if (editMode === 'insert') {
    if (!cellType) return { ok: false, error: '错误：insert 模式必须指定 cell_type。' }
    const idx = resolveCellIndex(nb, cellId)
    if (idx === -1) return { ok: false, error: `错误：找不到 cell ${cellId}。` }
    const newCell: NotebookCell = { cell_type: cellType, source: newSource, id: generateCellId(), metadata: {} }
    if (cellType === 'code') { newCell.execution_count = null; newCell.outputs = [] }
    nb.cells.splice(idx + 1, 0, newCell)
    return { ok: true }
  }
  const idx = resolveCellIndex(nb, cellId)
  if (idx === -1) return { ok: false, error: `错误：找不到 cell ${cellId}。` }
  if (editMode === 'delete') {
    nb.cells.splice(idx, 1)
    return { ok: true }
  }
  // replace
  const cell = nb.cells[idx]
  cell.source = newSource
  if (cellType) cell.cell_type = cellType
  if (cell.cell_type === 'code') { cell.execution_count = null; cell.outputs = [] }
  return { ok: true }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/notebook.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/notebook.ts test/notebook.test.ts
git commit -m "feat(c4): resolveCellIndex + applyCellEdit（replace/insert/delete）"
```

---

### Task 3: formatNotebookForRead

**Files:**
- Modify: `src/notebook.ts`（追加）
- Test: `test/notebook.test.ts`（追加）

**Interfaces:**
- Consumes: `NotebookContent`、`NotebookOutput`（Task 1）
- Produces: `function formatNotebookForRead(nb: NotebookContent): string`

- [ ] **Step 1: Write the failing test**

追加到 `test/notebook.test.ts`：

```ts
import { formatNotebookForRead } from '../src/notebook.js'

describe('formatNotebookForRead', () => {
  it('code/markdown cell + cell id 回退 cell-N', () => {
    const nb = { cells: [
      { cell_type: 'code', source: 'print(1)' },                 // 无 id → cell-0
      { cell_type: 'markdown', source: ['# h', '\nbody'], id: 'm1' },
    ], metadata: {} } as any
    const out = formatNotebookForRead(nb)
    expect(out).toContain('<cell id="cell-0">')
    expect(out).toContain('print(1)')
    expect(out).toContain('<cell id="m1" type="markdown">')
    expect(out).toContain('# h\nbody')
  })
  it('code cell 的 outputs：stream/error 文本', () => {
    const nb = { cells: [{ cell_type: 'code', source: 'x', id: 'c', outputs: [
      { output_type: 'stream', text: 'hello' },
      { output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['line1', 'line2'] },
    ] }], metadata: {} } as any
    const out = formatNotebookForRead(nb)
    expect(out).toContain('hello')
    expect(out).toContain('ValueError: bad')
    expect(out).toContain('line1\nline2')
  })
  it('图像输出 → 文本占位', () => {
    const nb = { cells: [{ cell_type: 'code', source: 'x', id: 'c', outputs: [
      { output_type: 'display_data', data: { 'image/png': 'BASE64DATA' } },
    ] }], metadata: {} } as any
    expect(formatNotebookForRead(nb)).toContain('[图像输出已省略]')
  })
  it('大输出 → jq 提示截断', () => {
    const big = 'y'.repeat(10001)
    const nb = { cells: [{ cell_type: 'code', source: 'x', id: 'c', outputs: [
      { output_type: 'stream', text: big },
    ] }], metadata: {} } as any
    const out = formatNotebookForRead(nb)
    expect(out).not.toContain(big)
    expect(out).toContain("jq '.cells[0].outputs'")
  })
  it('非 python 语言的 code cell 标 language', () => {
    const nb = { cells: [{ cell_type: 'code', source: 'puts 1', id: 'c' }],
      metadata: { language_info: { name: 'ruby' } } } as any
    expect(formatNotebookForRead(nb)).toContain('<cell id="c" language="ruby">')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/notebook.test.ts -t formatNotebookForRead`
Expected: FAIL（未导出）

- [ ] **Step 3: Write minimal implementation**

追加到 `src/notebook.ts`（顶部已有类型；在文件末尾加常量 + 函数）：

```ts
const LARGE_OUTPUT_THRESHOLD = 10000

function joinSource(s: string | string[] | undefined): string {
  return Array.isArray(s) ? s.join('') : (s ?? '')
}

function outputToText(o: NotebookOutput): string {
  switch (o.output_type) {
    case 'stream':
      return joinSource(o.text)
    case 'execute_result':
    case 'display_data': {
      const txt = joinSource(o.data?.['text/plain'] as string | string[] | undefined)
      const hasImg = !!o.data && (typeof o.data['image/png'] === 'string' || typeof o.data['image/jpeg'] === 'string')
      return hasImg ? (txt ? txt + '\n[图像输出已省略]' : '[图像输出已省略]') : txt
    }
    case 'error':
      return `${o.ename}: ${o.evalue}\n${(o.traceback ?? []).join('\n')}`
    default:
      return ''
  }
}

/** 把 notebook 渲染成 Read 的 cell 文本视图。 */
export function formatNotebookForRead(nb: NotebookContent): string {
  const lang = nb.metadata?.language_info?.name ?? 'python'
  return nb.cells
    .map((cell, index) => {
      const id = cell.id ?? `cell-${index}`
      const src = joinSource(cell.source)
      let attrs = ''
      if (cell.cell_type !== 'code') attrs = ` type="${cell.cell_type}"`
      else if (lang !== 'python') attrs = ` language="${lang}"`
      let block = `<cell id="${id}"${attrs}>\n${src}\n</cell>`
      if (cell.cell_type === 'code' && cell.outputs?.length) {
        const text = cell.outputs.map(outputToText).filter(Boolean).join('\n')
        if (text) {
          const out =
            text.length > LARGE_OUTPUT_THRESHOLD
              ? `输出过大，用 Bash: cat <notebook_path> | jq '.cells[${index}].outputs'`
              : text
          block += `\n<output>\n${out}\n</output>`
        }
      }
      return block
    })
    .join('\n\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/notebook.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/notebook.ts test/notebook.test.ts
git commit -m "feat(c4): formatNotebookForRead（cell 视图 + 图像占位 + 大输出截断）"
```

---

### Task 4: read.ts 检测 .ipynb 走 cell 视图

**Files:**
- Modify: `src/tools/read.ts`
- Test: `test/tools.read.test.ts`（追加）

**Interfaces:**
- Consumes: `parseNotebook`、`formatNotebookForRead`（Task 1/3）
- Produces: Read 对 .ipynb 返回 cell 视图（解析失败回退纯文本），并设 `ctx.fileState`

- [ ] **Step 1: Write the failing test**

追加到 `test/tools.read.test.ts`（参考现有 import 风格：`mkdtempSync`/`tmpdir`/`makeCtx`）：

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readTool } from '../src/tools/read.js'
import { makeCtx } from './helpers.js'

describe('Read .ipynb', () => {
  it('合法 notebook → cell 视图 + 设 fileState', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-nb-'))
    const f = path.join(dir, 'n.ipynb')
    writeFileSync(f, JSON.stringify({ cells: [{ cell_type: 'code', source: 'print(1)', id: 'c1' }], metadata: {} }))
    const ctx = makeCtx(dir)
    const out = await readTool.call({ file_path: f }, ctx)
    expect(out).toContain('<cell id="c1">')
    expect(out).toContain('print(1)')
    expect(out).not.toContain('\t') // 非纯文本行号格式
    expect(ctx.fileState.get(f)).toBeDefined()
  })
  it('非法 .ipynb → 回退纯文本（行号格式）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-nb-'))
    const f = path.join(dir, 'bad.ipynb')
    writeFileSync(f, 'not json at all')
    const out = await readTool.call({ file_path: f }, makeCtx(dir))
    expect(out).toContain('1\tnot json at all') // 纯文本行号回退
  })
})
```

（注：若 `test/tools.read.test.ts` 已 import 上述符号则不重复 import；只加 describe 块。）

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tools.read.test.ts -t "Read .ipynb"`
Expected: FAIL（.ipynb 当纯文本，输出含 `\t` 行号、不含 `<cell`）

- [ ] **Step 3: Write minimal implementation**

`src/tools/read.ts`：

1. 顶部加 import：

```ts
import { parseNotebook, formatNotebookForRead } from '../notebook.js'
```

2. 在 `call` 内、目录检查之后（`if (stat.isDirectory()) ...` 那行之后、`const lines = ...` 之前）插入 .ipynb 分支：

```ts
    if (p.endsWith('.ipynb')) {
      const nb = parseNotebook(fs.readFileSync(p, 'utf8'))
      if (nb) {
        ctx.fileState.set(p, fs.statSync(p).mtimeMs)
        return formatNotebookForRead(nb)
      }
      // 解析失败 → 落到下方纯文本读取（优雅回退）
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tools.read.test.ts && npx tsc --noEmit`
Expected: PASS（含既有 Read 测试回归）

- [ ] **Step 5: Commit**

```bash
git add src/tools/read.ts test/tools.read.test.ts
git commit -m "feat(c4): Read 检测 .ipynb → cell 视图（解析失败回退纯文本）"
```

---

### Task 5: NotebookEdit 工具 + 注册

**Files:**
- Create: `src/tools/notebookEdit.ts`
- Modify: `src/tools/index.ts`
- Test: `test/tools.notebookEdit.test.ts`

**Interfaces:**
- Consumes: `parseNotebook`/`serializeNotebook`/`applyCellEdit`（Task 1/2）、`checkFileState`（`src/tools/edit.js`）、`Tool`/`ToolContext`（types）
- Produces: `notebookEditTool: Tool`（name `NotebookEdit`），注册进 `allTools`

- [ ] **Step 1: Write the failing test**

Create `test/tools.notebookEdit.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { notebookEditTool } from '../src/tools/notebookEdit.js'
import { readTool } from '../src/tools/read.js'
import { parseNotebook } from '../src/notebook.js'
import { makeCtx } from './helpers.js'

const NB = { cells: [{ cell_type: 'code', source: 'old', id: 'c1', execution_count: 2, outputs: [{ output_type: 'stream', text: 'x' }] }], metadata: {}, nbformat: 4, nbformat_minor: 5 }

async function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dc-nbe-'))
  const f = path.join(dir, 'n.ipynb')
  writeFileSync(f, JSON.stringify(NB))
  const ctx = makeCtx(dir)
  await readTool.call({ file_path: f }, ctx) // read-before-edit
  return { f, ctx }
}

describe('NotebookEdit', () => {
  it('replace：改 source 且清空 outputs；写回合法 JSON', async () => {
    const { f, ctx } = await setup()
    const out = await notebookEditTool.call({ notebook_path: f, cell_id: 'c1', new_source: 'new code' }, ctx)
    expect(out).toContain('已编辑 notebook')
    const nb = parseNotebook(readFileSync(f, 'utf8'))!
    expect(nb.cells[0].source).toBe('new code')
    expect(nb.cells[0].outputs).toEqual([])
    expect(nb.cells[0].execution_count).toBeNull()
  })
  it('insert：需 cell_type，在 cell_id 之后', async () => {
    const { f, ctx } = await setup()
    await notebookEditTool.call({ notebook_path: f, cell_id: 'c1', new_source: '# md', cell_type: 'markdown', edit_mode: 'insert' }, ctx)
    const nb = parseNotebook(readFileSync(f, 'utf8'))!
    expect(nb.cells.length).toBe(2)
    expect(nb.cells[1].cell_type).toBe('markdown')
  })
  it('delete：移除 cell', async () => {
    const { f, ctx } = await setup()
    await notebookEditTool.call({ notebook_path: f, cell_id: 'c1', new_source: '', edit_mode: 'delete' }, ctx)
    const nb = parseNotebook(readFileSync(f, 'utf8'))!
    expect(nb.cells.length).toBe(0)
  })
  it('未 Read → read-before-edit 拒绝', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-nbe-'))
    const f = path.join(dir, 'n.ipynb')
    writeFileSync(f, JSON.stringify(NB))
    const out = await notebookEditTool.call({ notebook_path: f, cell_id: 'c1', new_source: 'x' }, makeCtx(dir))
    expect(out).toContain('必须先用 Read')
  })
  it('非法 JSON notebook → 报错', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-nbe-'))
    const f = path.join(dir, 'bad.ipynb')
    writeFileSync(f, 'not json')
    const ctx = makeCtx(dir)
    await readTool.call({ file_path: f }, ctx) // 回退纯文本读，设 fileState
    const out = await notebookEditTool.call({ notebook_path: f, cell_id: 'c1', new_source: 'x' }, ctx)
    expect(out).toContain('不是合法的 Jupyter notebook')
  })
})

describe('NotebookEdit 注册', () => {
  it('在 allTools 中', async () => {
    const { allTools } = await import('../src/tools/index.js')
    expect(allTools.some(t => t.name === 'NotebookEdit')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tools.notebookEdit.test.ts`
Expected: FAIL（`notebookEdit.js` 不存在）

- [ ] **Step 3: Write minimal implementation**

Create `src/tools/notebookEdit.ts`：

```ts
// src/tools/notebookEdit.ts
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import type { Tool } from './types.js'
import { checkFileState } from './edit.js'
import { parseNotebook, serializeNotebook, applyCellEdit } from '../notebook.js'

const schema = z.object({
  notebook_path: z.string().describe('要编辑的 .ipynb 文件路径'),
  cell_id: z.string().describe('目标 cell 的 id（真实 id 或 cell-N 索引格式）'),
  new_source: z.string().describe('新的 cell 源码/文本（delete 时忽略）'),
  cell_type: z.enum(['code', 'markdown']).optional().describe('cell 类型；insert 模式必填'),
  edit_mode: z.enum(['replace', 'insert', 'delete']).optional().describe('编辑模式，默认 replace；insert 在 cell_id 之后插入'),
})

export const notebookEditTool: Tool<typeof schema> = {
  name: 'NotebookEdit',
  description:
    '编辑 Jupyter notebook (.ipynb) 的单个 cell：replace（替换源码，清空输出）/ insert（在指定 cell 之后插入，需 cell_type）/ delete（删除）。纯 JSON 编辑，不执行 cell。编辑前必须先用 Read 读取该 notebook。',
  inputSchema: schema,
  isReadOnly: false,
  needsPermission: input => `编辑 ${input.notebook_path}`,
  deniablePaths: (input, cwd) => [path.resolve(cwd, input.notebook_path)],
  async call(input, ctx) {
    const p = path.resolve(ctx.cwd(), input.notebook_path)
    const stateErr = checkFileState(p, ctx)
    if (stateErr) return stateErr
    const nb = parseNotebook(fs.readFileSync(p, 'utf8'))
    if (!nb) return `错误：${p} 不是合法的 Jupyter notebook（JSON 解析失败）。`
    const editMode = input.edit_mode ?? 'replace'
    const r = applyCellEdit(nb, {
      cellId: input.cell_id,
      newSource: input.new_source,
      cellType: input.cell_type,
      editMode,
    })
    if (!r.ok) return r.error
    ctx.recordBeforeImage?.(p)
    fs.writeFileSync(p, serializeNotebook(nb))
    ctx.fileState.set(p, fs.statSync(p).mtimeMs)
    return `已编辑 notebook ${p}（${editMode} cell ${input.cell_id}）。`
  },
}
```

`src/tools/index.ts`：加 import + 注册：

```ts
import { notebookEditTool } from './notebookEdit.js'
```

```ts
export const allTools: Tool<any>[] = [readTool, globTool, grepTool, bashTool, editTool, writeTool, notebookEditTool, configTool]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tools.notebookEdit.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/notebookEdit.ts src/tools/index.ts test/tools.notebookEdit.test.ts
git commit -m "feat(c4): NotebookEdit 工具（replace/insert/delete）+ 注册 allTools"
```

---

### Task 6: edit.ts 拒绝 .ipynb

**Files:**
- Modify: `src/tools/edit.ts`
- Test: `test/tools.edit.test.ts`（追加）

**Interfaces:**
- Produces: Edit 对 `.ipynb` 路径返回重定向错误（不执行替换）

- [ ] **Step 1: Write the failing test**

追加到 `test/tools.edit.test.ts`：

```ts
describe('Edit 拒绝 .ipynb', () => {
  it('.ipynb → 重定向 NotebookEdit，不改文件', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dc-'))
    const f = path.join(dir, 'n.ipynb')
    const original = JSON.stringify({ cells: [], metadata: {} })
    writeFileSync(f, original)
    const ctx = makeCtx(dir)
    await readTool.call({ file_path: f }, ctx)
    const out = await editTool.call({ file_path: f, old_string: 'cells', new_string: 'CELLS' }, ctx)
    expect(out).toContain('NotebookEdit')
    expect(readFileSync(f, 'utf8')).toBe(original) // 未被改
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tools.edit.test.ts -t "拒绝 .ipynb"`
Expected: FAIL（Edit 当前会替换 .ipynb 文本）

- [ ] **Step 3: Write minimal implementation**

`src/tools/edit.ts` 的 `call` 内，`const p = path.resolve(...)` 之后、`checkFileState` 之前插入：

```ts
    if (p.endsWith('.ipynb')) {
      return '错误：.ipynb 是 Jupyter notebook，请用 NotebookEdit 工具编辑（Edit 的纯文本替换会破坏 notebook JSON 结构）。'
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tools.edit.test.ts && npx tsc --noEmit`
Expected: PASS（含既有 Edit 测试回归）

- [ ] **Step 5: Commit**

```bash
git add src/tools/edit.ts test/tools.edit.test.ts
git commit -m "feat(c4): Edit 拒绝 .ipynb，重定向 NotebookEdit"
```

---

### Task 7: 全量门禁

**Files:** 无（验证）

- [ ] **Step 1: 全量回归**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: 全绿（既有 EPIPE flaky 不计）。

- [ ] **Step 2: 收尾**

按 `superpowers:finishing-a-development-branch` 合 main；更新 master roadmap（C4 → ✅ 收尾）+ 记忆。纯逻辑件免真机冒烟。

---

## Self-Review

**1. Spec coverage:**
- §3.1 notebook.ts 类型/parse/serialize/generateCellId → Task 1 ✓
- §3.1 resolveCellIndex/applyCellEdit → Task 2 ✓
- §3.1 formatNotebookForRead（图像占位/大输出截断/cell-N 回退/language）→ Task 3 ✓
- §3.2 read.ts .ipynb 增强（回退/fileState）→ Task 4 ✓
- §3.3 notebookEdit.ts（read-before-edit/非法 JSON/insert 需 cell_type/recordBeforeImage）→ Task 5 ✓
- §3.4 edit.ts .ipynb 门控 → Task 6 ✓
- §3.5 注册 allTools → Task 5 ✓
- §5 测试 → 各任务 ✓

**2. Placeholder scan:** 无 TBD/TODO；每个代码步骤含完整代码。

**3. Type consistency:** `NotebookContent`/`NotebookCell`/`NotebookOutput`/`CellEditArgs`/`parseNotebook`/`serializeNotebook`/`generateCellId`/`resolveCellIndex`/`applyCellEdit`/`formatNotebookForRead`/`notebookEditTool` 跨任务命名一致；`applyCellEdit` 入参 `{cellId,newSource,cellType,editMode}` 与 Task 5 调用一致；工具 schema 字段 `notebook_path/cell_id/new_source/cell_type/edit_mode` 与测试一致。
