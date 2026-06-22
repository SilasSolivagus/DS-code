# C4 Notebook（NotebookRead + NotebookEdit，编辑版不执行）设计

日期：2026-06-22
对齐目标：Claude Code `NotebookEditTool` + `FileReadTool` 对 .ipynb 的处理 + `utils/notebook.ts`。
所属：master roadmap 第 4 层工具件，C4 工具批 ROI 复评后**唯一现在做的一件**（其余 LSP/Cron/Sandbox 推迟、PowerShell/REPL 跳过，见 roadmap C4 裁决 `e203ff9`）。

## 1. 背景与目标

deepcode 当前把 `.ipynb` 当**纯文本**处理：`read.ts` 按行号输出原始 JSON，`edit.ts` 字符串替换会破坏 notebook 的 JSON 结构（缩进 / cell id / outputs / execution_count 字段）。这是真实 bug——模型对 notebook 做编辑后文件常不可读。

CC 的做法（实读 `src/tools/NotebookEditTool/` + `src/utils/notebook.ts`）：
- `FileReadTool` 检测 `.ipynb` → `readNotebook` 解析 → 每 cell 渲染为 `<cell id="...">source</cell>` + outputs。
- `NotebookEditTool` 独立工具，`{notebook_path, cell_id, new_source, cell_type, edit_mode}`，三模式 replace/insert/delete，**纯 JSON 编辑不执行 kernel**；replace 清空 outputs + execution_count；写回 `JSON.stringify(nb, null, 1)`。
- `FileEditTool` 检测 `.ipynb` → 拒绝，重定向用 NotebookEdit。

**目标**（用户钦定，对齐 CC）：
1. 增强 `read.ts`：检测 `.ipynb` → 输出 cell 视图（不新增工具）。
2. 新建 `NotebookEdit` 工具：cell 级 replace/insert/delete，纯 JSON 编辑不执行。
3. `edit.ts` 拒绝 `.ipynb` → 重定向 NotebookEdit（根治纯文本编辑破坏 JSON）。
4. 零依赖、不碰 TUI、无平台特定代码。

## 2. 范围裁剪（N/A / 不做）

- **不执行 cell**（无 jupyter kernel / nbconvert 依赖）——CC 的 NotebookEdit 也只编辑不执行。
- **图像输出不返回图像块**：deepcode 是文本终端（OpenAI string content，无 Anthropic ImageBlockParam），cell 的图像输出渲染为文本占位 `[图像输出已省略]`（CC 返回 image block，deepcode N/A）。
- **Write 不门控 .ipynb**：整文件合法 JSON 覆盖是合法用法，保持允许。
- **Read 的 offset/limit 对 .ipynb 不适用**（cell 非行概念），忽略，返回全 cell 视图，靠 per-output 截断控量。
- 不引 CC 的 attachment/diagnostic 系统。

## 3. 组件设计

### 3.1 `src/notebook.ts`（新，纯工具模块）

类型（最小够用，宽松解析）：
```ts
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
```
`NotebookOutput` 宽松（`output_type` + 可选 text/data/ename/evalue/traceback），渲染时按 output_type 分支。

函数：
- `parseNotebook(content: string): NotebookContent | null` —— `JSON.parse` + 形状守卫（对象、有 `cells` 数组）；任何失败返回 `null`（供 read.ts 优雅回退）。
- `formatNotebookForRead(nb: NotebookContent): string` —— 每 cell：
  - cell id 缺失回退 `cell-{index}`；source 数组 join('')。
  - 头：`<cell id="{id}"{markdown 时 type="markdown" / code 非 python 时 language="{lang}"}>` ... `source` ... `</cell>`（对齐 CC `cellContentToToolResult` 文本形态，闭合标签简化为 `</cell>`）。
  - code cell 附 outputs：`stream`→text；`execute_result`/`display_data`→`data['text/plain']` 文本，含 `image/png|jpeg` → 追加 `[图像输出已省略]`；`error`→`{ename}: {evalue}\n{traceback}`。
  - 单 cell outputs 合计 >10000 字符 → 替换为 `输出过大，用 Bash: cat <notebook_path> | jq '.cells[{index}].outputs'`（对齐 CC `LARGE_OUTPUT_THRESHOLD`）。
- `resolveCellIndex(nb, cellId: string): number` —— 先按 `cell.id === cellId` 匹配；否则解析 `cell-N`（`/^cell-(\d+)$/`）→ index；否则 `-1`。
- `applyCellEdit(nb, args): { ok: true } | { ok: false; error: string }`（就地改 nb）：
  - `args = { cellId, newSource, cellType?, editMode }`
  - **replace**：`resolveCellIndex`，-1→error；设 `cell.source = newSource`；若 `cell_type === 'code'` 重置 `execution_count = null`、`outputs = []`；`cellType` 传入时改 `cell.cell_type`。
  - **insert**：`cellType` 必填（缺→error）；`resolveCellIndex`（-1→error）→ 在该 index **之后** splice 插入 `{ cell_type: cellType, source: newSource, id: generateCellId(), metadata: {}, ...(code 时 execution_count:null, outputs:[]) }`。
  - **delete**：`resolveCellIndex`（-1→error）→ `cells.splice(index,1)`。
- `serializeNotebook(nb): string` —— `JSON.stringify(nb, null, 1)`（对齐 CC indent=1）。
- `generateCellId(): string` —— 随机短十六进制 id（app 代码可用 Math.random）。

### 3.2 `read.ts` 增强

`call` 内 stat 后、读取前：若 `p` 以 `.ipynb` 结尾：
- 读 content，`parseNotebook`；
- 成功 → `ctx.fileState.set(p, mtimeMs)`（与现有一致，使 NotebookEdit 的 read-before-edit 闸门可用）+ 返回 `formatNotebookForRead(nb)`；
- 失败（非法 JSON / 非 notebook 结构）→ 落到现有纯文本读取分支（优雅回退，不报错）。

offset/limit 对 .ipynb 分支不应用。

### 3.3 `src/tools/notebookEdit.ts`（新工具）

```ts
schema = { notebook_path, cell_id, new_source, cell_type?: 'code'|'markdown', edit_mode?: 'replace'|'insert'|'delete' }
```
- `name: 'NotebookEdit'`、`isReadOnly: false`、`needsPermission: i => 编辑 ${i.notebook_path}`、`deniablePaths: (i,cwd)=>[resolve(cwd,i.notebook_path)]`。
- `call`：
  1. resolve path。
  2. `checkFileState(p, ctx)`（复用 edit.ts 导出）—— read-before-edit 闸门；非 null 返回错误。
  3. 读 content，`parseNotebook`；`null` → 返回 `错误：${p} 不是合法的 Jupyter notebook（JSON 解析失败）。`
  4. `applyCellEdit(nb, { cellId: cell_id, newSource: new_source, cellType: cell_type, editMode: edit_mode ?? 'replace' })`；`ok:false` → 返回 error。
  5. `ctx.recordBeforeImage?.(p)` → `fs.writeFileSync(p, serializeNotebook(nb))` → `ctx.fileState.set(p, mtimeMs)`。
  6. 返回 `已编辑 notebook ${p}（{editMode} cell {cell_id}）。`

### 3.4 `edit.ts` 门控

`call` 顶部（resolve 后、checkFileState 前）：若 `p.endsWith('.ipynb')` → 返回
`错误：.ipynb 是 Jupyter notebook，请用 NotebookEdit 工具编辑（Edit 的纯文本替换会破坏 notebook JSON 结构）。`

### 3.5 注册

`src/tools/index.ts` 的 allTools 数组加入 `notebookEditTool`。（注册进 allTools 后，useChat/headless/子代理按现有装配自动获得，与 configTool 同路径。）

## 4. 数据流

```
Read(.ipynb) → parseNotebook → 成功:formatNotebookForRead + set fileState / 失败:纯文本回退
NotebookEdit → checkFileState(read-before-edit) → parseNotebook → applyCellEdit → serializeNotebook(indent 1) → write + set fileState
Edit(.ipynb) → 拒绝 + 重定向 NotebookEdit
```

## 5. 测试策略（纯逻辑，免冒烟）

- `notebook.ts`：parseNotebook（合法 / 非法 JSON / 非 notebook 对象 → null）；formatNotebookForRead（code+markdown cell / outputs 各类型 / 图像占位 / 大输出截断+jq 提示 / cell id 回退 cell-N）；resolveCellIndex（按 id / cell-N / 未命中 -1）；applyCellEdit（replace 改 source + 清 outputs/execution_count、insert 需 cell_type + 生成 id + 位置在后、delete、各 error 分支）；serializeNotebook（indent 1 + round-trip parse 不变）。
- `read.ts`：.ipynb → cell 视图（含 fileState 设置）；非法 .ipynb → 纯文本回退；普通文件不受影响。
- `notebookEdit.ts`：replace/insert/delete 成功；read-before-edit 闸门（未 Read → 拒绝）；非法 JSON 报错；insert 缺 cell_type 报错；recordBeforeImage 调用。
- `edit.ts`：.ipynb → 拒绝重定向；非 .ipynb 不受影响（回归）。

## 6. 向后兼容与风险

- 纯新增工具 + Read 分支增强 + Edit 一个守卫 + 新工具注册；无依赖、无平台代码、不碰 TUI。
- Edit 拒绝 .ipynb 是行为变化（对齐 CC，根治破坏 JSON）；Write 保持允许。
- 图像输出降级为文本占位是 deepcode 文本终端的固有限制（CC 用 image block，N/A）。
- 教训沿用：新工具注册后子代理自动获得（同 4.5 Config）；改 read/edit 的测试用临时文件 try/finally 清理。

## 7. 偏离 CC 记录

- 工具结果为字符串（非 CC 的 TextBlockParam/ImageBlockParam 数组）；图像输出 → 文本占位。
- `</cell>` 闭合标签简化（CC 用 `</cell id="...">` 非标准闭合形态，deepcode 用规整 `</cell>`）。
- insert 语义明确为"在 cell_id 之后插入"（文档化）。
- 不引 attachment/diagnostic 系统、不执行 kernel。
