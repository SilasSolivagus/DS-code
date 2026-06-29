# Design — deepcode 输入框附件：文本粘贴折叠（1:1 CC）+ 图片识别注入

**日期**：2026-06-26
**背景**：两部分。①用户指出拖/粘贴文件进输入框时 deepcode 显示一长串绝对路径。实读 CC（bundle v2.1.76）确证：**CC 对拖入文本文件也显示绝对路径，不相对化、不读内容**；CC 真正做的是「超长粘贴折叠成 `[Pasted text #N]` 占位符 + 发送时内联展开」→ 本件**文本部分 = 1:1 复刻 CC**。②用户追加：要能**直接拖拽图片文件 + 粘贴剪贴板截图**。因 deepcode 主模型常是 DeepSeek（无视觉 API），用户钦定**「不切会话模型，发送时调 GLM-4.6v 视觉识别图片→把识别文字注入会话」**架构（专家背书，6 条精炼见下）→ 图片部分**有意偏离 CC**（CC 是发原图 block 给会话模型）。
**流程**：brainstorm（本文）→ writing-plans → SDD → opus 终审 → 真机冒烟（碰 TUI）→ 合并。

---

## 用户已拍板

- **文本部分 = 严格 1:1 照搬 CC**，不做我方取舍（不额外相对化路径、不超越）。已确认接受：单个拖入文件路径（<800 字符、0 换行）保持绝对、不变短（= CC 真实行为）。
- **图片部分 = 「描述并注入」架构**（非切模型、非发原图 block）：拖图片文件 / 粘贴剪贴板截图 → 发送时调 GLM-4.6v 识别（带用户问题作上下文）→ 识别文字注入会话给 active model。专家 6 条精炼全部采纳：①识别在发送时 + 带用户文本上下文 ②注入包裹来源 `<图片#N 识别…>` ③像工具步可见 `⏺ 识别图片 #N · glm-4.6v` ④无 GLM key 提示不静默 ⑤诚实损耗边界（主模型见文字非像素）⑥砍掉切视觉模型/发原图 block，统一一条路。

---

## CC 真实行为（确证级实读，bundle v2.1.76）

**粘贴入口 `q5q`**（line 4091）：ink 把一次粘贴合并为单事件交进来；按 `/ (?=\/|[A-Za-z]:\\)/` + `\n` 切 token，图片扩展名（`XG1=/\.(png|jpe?g|gif|webp|bmp)$/i`）走 base64 图片分支，**非图片/文本一律走 `onPaste`（`d8`）纯文本路径**。

**文本折叠判定 `d8`**（line 14671）：
```js
WA = sY(paste).replace(/\r/g,"\n").replaceAll("\t","    ")  // 清洗：\r→\n、tab→4空格、剥控制符
_4 = b06(WA)                          // 换行数 = (match(/\r\n|\r|\n/g)||[]).length
H4 = Math.min(rows - 10, 2)           // 行数阈值；正常终端(rows≥12)恒=2
if (WA.length > 800 || _4 > H4) {     // ★ 字符>800 或 换行>min(rows-10,2)
  id = T4.current++
  pastedContents[id] = { id, type:'text', content: WA }   // 真内容存内存 map
  insert(JX1(id, _4))                 // 草稿插占位符
} else insert(WA)                     // 未超阈值原样插入
```

**占位符生成 `JX1`**（line 1264）：
```js
JX1(id, lines) = lines === 0 ? `[Pasted text #${id}]` : `[Pasted text #${id} +${lines} lines]`
```

**发送时内联展开**（submit handler，line 14682，确证关键证据）：
```js
g = displayText; B = x06(g)           // x06 提取所有占位符
for (Q of B) { U = pastedContents[Q.id]
  if (U && U.type === 'text') g = g.replace(Q.match, U.content) }  // ★ 占位符→完整原文 内联回填
// g（完整文本）→ 构造 API user message 的 text block；模型看到完整原文
```

**占位符提取正则 `x06`**（line 1264）：
```js
/\[(Pasted text|Image|\.\.\.Truncated text) #(\d+)(?: \+\d+ lines)?(\.)*\]/g
```

**阈值常量**：`DG1 = 800`（字符数阈值）。

---

## 设计（deepcode 1:1 复刻）

### 技术前提（已核）
ink 5.2.1：**一次粘贴 = 单个 `useInput` 回调，整串作为 `input` 传入**（`node_modules/ink/build/hooks/use-input.d.ts:76` 官方注释）。故 deepcode 无需解析 bracketed-paste 转义码——直接对 `InputBox` 的 `if (input)` 分支（现 line 113-116）里这一 chunk 做折叠判定。

### 落点：自包含在 `InputBox`
粘贴折叠状态（`pastedContents` map + id 计数器）+ 折叠 + 展开**全部封装在 `src/tui/components/InputBox.tsx`**：
- 草稿里只存占位符；
- **submit/steer 前**（`onSubmit`/`onSteer` 调用前）把占位符展开回完整原文再外传。
- 之后照走 useChat 的 `@file` 展开等——互不干扰（占位符已先于 @ 展开）。

### 新增纯逻辑模块 `src/tui/pasteFold.ts`（便于单测）
```ts
export interface PastedEntry { id: number; content: string }

// —— 粘贴折叠（CC d8）——
export const PASTE_CHAR_THRESHOLD = 800        // CC DG1
export function countNewlines(s: string): number          // (s.match(/\r\n|\r|\n/g)||[]).length（CC b06）
export function normalizePaste(s: string): string          // \r→\n、tab→4空格、剥 C0/C1(留\n)（CC sY+清洗）
export function newlineThreshold(rows: number): number      // Math.min(rows - 10, 2)（CC H4）
export function shouldFold(text: string, rows: number): boolean   // len>800 || newlines>threshold
export function makePlaceholder(id: number, lines: number): string // [Pasted text #id] / [Pasted text #id +lines lines]（CC JX1）

// —— 整 buffer 截断（CC Cxq/Kfz/Yfz）——
export const TRUNCATE_LIMIT = 10000            // CC qfz：整个草稿超此长度触发
export const KEEP_WINDOW = 1000                // CC Rxq：保留头尾合计，对半 = 头500+尾500
export function makeTruncatePlaceholder(id: number, lines: number): string // [...Truncated text #id +lines lines...]（CC Yfz）
/** 若 text.length>TRUNCATE_LIMIT：返回 头500 + 截断占位符 + 尾500，中间存 entry；否则 null（不变） */
export function truncateBuffer(text: string, id: number): { newText: string; entry: PastedEntry } | null

// —— 提取 / 展开 / 删除（CC x06 / submit展开 / deleteTokenBefore）——
export const PLACEHOLDER_RE: RegExp   // /\[(Pasted text|\.\.\.Truncated text) #(\d+)(?: \+\d+ lines)?(\.)*\]/g（去 Image，无视觉）
export function expandPlaceholders(text: string, map: Map<number, PastedEntry>): string  // 两类占位符→content 内联回填
/** 若 text 末尾紧邻一个完整占位符（Pasted/Truncated）→ 返回删掉它后的文本；否则 null（交逐字退格） */
export function stripTrailingPlaceholder(text: string): string | null
```
注：`PLACEHOLDER_RE` 去掉 CC 的 `Image` 分支（deepcode 无图片折叠）；`stripTrailingPlaceholder` 末尾匹配正则 = `/(^|\s)\[(Pasted text #\d+(?: \+\d+ lines)?|\.\.\.Truncated text #\d+ \+\d+ lines\.\.\.)\]$/`（CC `deleteTokenBefore`，去 Image）。

### InputBox 接线（id 计数器：`useRef(1)`，每次挂载从 1 起——deepcode submit 即展开，history 永无占位符，无需像 CC 从历史推算）
1. **粘贴折叠**——`if (input)` 分支：先 `clean = normalizePaste(input)`；若 `shouldFold(clean, rows)` → `id = nextId.current++`；`map.set(id, {id, content: clean})`；`setVal(value + makePlaceholder(id, countNewlines(clean)))`。否则维持现状（append clean）。`rows` 取 `useStdout().stdout.rows ?? 24`。
2. **整 buffer 截断**（CC `Cxq`，独立机制）——`useEffect([value])`：若 `value.length > TRUNCATE_LIMIT` 且本轮未截断（once 标志，`value===''` 时重置）→ `const r = truncateBuffer(value, nextId.current)`；`r` 非空则 `nextId.current++`、`map.set(r.entry.id, r.entry)`、`setVal(r.newText)`、置 once。
3. **发送展开**——submit/steer/续行合并出 `full` 后：**先按 CC 在展开前做空守卫**（`if (!full.trim()) return`，对含占位符的显示文本判断，现有逻辑保留）→ 再 `full = expandPlaceholders(full, map)` → 交 `onSubmit(full)`/`onSteer(full)`；提交后清空 map + 重置 `nextId`。
4. **占位符删除**（CC `deleteTokenBefore`）——`key.backspace/delete` 分支：先 `const t = stripTrailingPlaceholder(valueRef.current)`；`t !== null` → `setVal(t)`（整块删占位符，**不清 map**——孤儿条目 submit 时 `x06` 不读即忽略，对齐 CC）；否则维持现状 `setVal(valueRef.current.slice(0, -1))`（逐字退格）。

### §A 占位符删除（已钉死 = 上方接线 4）
CC：普通 Backspace（+Ctrl+H）= `deleteTokenBefore() ?? backspace()`——光标紧邻占位符 `]` 后整块删，否则逐字回退；Meta/Ctrl+Backspace 是逐词删（deepcode InputBox 无逐词删、无中段光标，仅复刻「末尾占位符整块删 / 否则逐字」即足）。**删后不清 map**（对齐 CC）。

### §B 整 buffer 截断（已钉死 = 上方接线 2）
CC：与粘贴折叠**两套机制**。整个输入框字符串 `length > 10000`（`qfz`）时由独立 effect 触发，保留头 500 + 尾 500（`Rxq=1000` 对半），中间挖出存 map，占位符 `[...Truncated text #N +M lines...]`。**不丢内容**——submit 回填完整原文（头500+完整中间+尾500=原文），纯显示层折叠。每轮一次（once 标志，input 清空重置）。三条路径（`x06` 提取 / submit 展开 / `deleteTokenBefore` 删除）均同时支持 `Pasted text` 与 `...Truncated text` 两种占位符。

---

## 图片识别注入（用户钦定架构 — 有意偏离 CC）

GLM 视觉调研已确证（来源 docs.bigmodel.cn）：`glm-4.6v`（128K、thinking、¥1输入/¥3输出）/ `glm-4.6v-flash`（免费）；OpenAI 兼容 `content:[{type:'text'},{type:'image_url',image_url:{url:'data:…;base64,…'}}]`，接受 base64 data URL；同现有 GLM 端点（baseURL 零改）；支持 stream+thinking。单图 ≤5MB、≤5 图/消息、png/jpg/jpeg（不承诺 webp）、同消息不混文件/视频/图。

### 统一一条路（不切会话模型、不发原图 block）
拖图片文件 / 粘贴剪贴板截图 → **抓取** base64 + `[Image #N]` 占位符 → **发送时**对每个 `[Image #N]` 调 `describeImage(entry, 用户文本)`（GLM-4.6v 视觉，带用户问题作上下文）→ 识别文字 → 占位符替换为 `<图片#N 识别(glm-4.6v)>{desc}</图片#N>` → 整条**纯文本**消息发给 active model（DeepSeek/任意）。主流式管线（api.ts）不动。

### 抓取层
- **拖图片文件**：粘贴 token 是路径，扩展名 ∈ png/jpg/jpeg 且文件存在 → 读字节 → base64 + mime。
- **剪贴板截图**：粘贴动作但剪贴板是图片 → 读 PNG（mac 优先：`osascript`/`pngpaste`；其它平台优雅降级=无图，提示）。新模块 `src/clipboardImage.ts`。
- **附件 map**（与文本折叠**共用** id 计数器 `useRef(1)`，占位符全局唯一）：`Map<number, TextEntry | ImageEntry>`，`ImageEntry = {id, type:'image', base64, mime, source:'file'|'clipboard', filename?}`。
- 校验：单图 ≤5MB、png/jpg/jpeg；超限/格式不符 → 提示不抓取。

### 发送时编排（useChat submit，在文本占位符展开之后）
- `userText` = 去掉所有占位符后的用户文字（作识别上下文）。
- 对每个 `[Image #N]`：显示工具步 `⏺ 识别图片 #N · glm-4.6v` → `describeImage(entry, userText)` → 替换占位符为 `<图片#N 识别(glm-4.6v)>{desc}</图片#N>`。
- **无 GLM key / 识别失败**：notice 提示「配置 GLM key 以启用图片识别」/具体错误，占位符替换为 `<图片#N 无法识别：{原因}>`（不静默吞）。

### `describeImage`（新模块 `src/imageDescribe.ts`）
- 直连 GLM 视觉（用 GLM preset 的 baseURL/apiKey，**与 active provider 无关**），model 缺省 `glm-4.6v`（可配 `settings.visionModel`）。
- 非流式一次性请求，`content:[{type:'text',text: 识别提示+userText},{type:'image_url',image_url:{url:`data:${mime};base64,${b64}`}}]`。
- 识别提示（中文）：「结合用户的问题，转写并提取图中与问题相关的文字与关键信息；若是代码/报错/UI 截图，逐字转写关键文本，不要泛泛描述。」

### providers.ts
- GLM preset `meta` 加：`'glm-4.6v': {hit:1,miss:1,out:3,contextWindow:128_000,supportsThinking:true}` +（可选）`'glm-4.6v-flash': {hit:0,miss:0,out:0,contextWindow:128_000,supportsThinking:true}`。
- 新增 `ModelMeta.supportsVision?: boolean`（标 glm-4.6v*），供 describeImage 选模型/校验——**不门控主对话模型**（主模型只收文字）。

### 与 CC 的关系（明示）
文本折叠 = 1:1 CC；**图片 = 有意偏离 CC**（CC 发原图 block 给会话模型，要求会话模型本身有视觉）。deepcode 因主模型常无视觉，改「GLM 侧识别→文字注入」。损耗边界：主模型见 GLM 文字非像素（截图文本/报错/UI 够用，像素级任务弱）——用户已确认接受。

---

## 硬约束 / 与 CC 的不可避免差异（已确认非取舍）

- **图片不发原图 block 给会话模型**：见上「图片识别注入」——DeepSeek 等无视觉，故走 GLM 侧识别→文字注入（用户钦定架构，非 1:1 CC）。
- **paste-cache 落盘持久化**（CC `S84`，content >1024 字节存 `~/.claude/cache/paste-cache/<hash>.txt`）：CC 用于 history.jsonl 把大粘贴存成 hash 引用。**deepcode 在 submit 即把占位符展开成完整原文进消息**，session history 自然存完整文本——hash 缓存对 deepcode 的「发送 + 历史」均无功能必要（纯存储优化，history.jsonl 体积略大）。**本件不实现**（与 CC 用户可见行为完全一致；仅内部持久化策略不同）。

---

## 风险（真机冒烟）
1. **bracketed-paste 标记残渣**：若终端把 `\x1b[200~`/`\x1b[201~` 发进 `input`，现有控制符剥离会把 `\x1b` 删剩 `[200~` 文本残渣。冒烟验证；如出现，`normalizePaste` 前先剥这两个标记。
2. **ink 合并粒度**：超大粘贴 ink 是否一次性给全（vs 分块多次回调）——多块会致一次粘贴折成多个占位符。冒烟粘 1000+ 行日志验证。
3. **占位符展开 ↔ @file 展开次序**：先展开 paste 文本占位符、再 `[Image #N]` 识别、再 useChat `@` 展开，确认不互相吞。
4. **续行/历史**：占位符在草稿里参与续行（`\` 结尾）/历史回溯不被破坏。
5. **剪贴板读图平台**：mac `osascript`/`pngpaste` 是否装/可用；非 mac 优雅降级（无图+提示），不崩。冒烟在 mac 验截图粘贴。
6. **describeImage 时延/成本**：每图一次 GLM 调用、阻塞发送；工具步 `⏺ 识别图片` 给反馈；flash 免费可作默认省钱。
7. **无 GLM key / GLM 不通**：提示不静默吞，占位符降级为 `<图片#N 无法识别…>`，主消息仍可发。
8. **图片校验**：>5MB/非 png-jpg 拒抓 + 提示；多图（≤5）逐个识别。

---

## CC 边界事实（复刻须对齐，已钉死）
- **id 单调不复用**：CC 计数器 `T4` 从历史推算起始、之后 `++`、文本/图片共享。deepcode 简化为 `useRef(1)` 每挂载从 1 起（submit 即展开→history 无占位符，无需推算），同样**单调递增不复用**。
- **坏占位符 fallback**：用户手改坏占位符（删 `]`/改数字）→ `x06` 严格正则不匹配 → **当普通文本原样发送**，无报错、无特殊 fallback。map 条目被忽略。（deepcode 复刻 `PLACEHOLDER_RE` 含 `(\.)*` 容尾点 + `id>0` 过滤。）
- **空/空白粘贴**：折叠只看字符数/换行数——空 `""`/纯空格不折叠（原样）；纯空白含 ≥3 换行**会**折叠成 `[Pasted text #N +M lines]`。submit 空守卫对**含占位符的显示文本**判断（`full.trim()`），故纯空白占位符仍会发送（占位符文本非空白）——deepcode 接线 3「展开前空守卫」已对齐。
- **paste-cache（CC BN9=1024 history hash 缓存）**：deepcode 不做（已在硬约束论证）。

## Self-Review（定稿）
- **文本占位符**：§A（删除）/§B（截断）已由 CC 实读钉死并写入接线 2/4，无遗留「待确认」。
- **图片**：抓取（文件/剪贴板）→`[Image #N]`+共享 id map→发送时 describeImage→`<图片#N…>`注入，全链路 + providers.ts glm-4.6v + supportsVision + 无 key 降级 已写实；GLM 视觉格式/端点/定价均实读确证。
- **一致性**：阈值 800 / `min(rows-10,2)` / 截断 10000 / 头尾各 500 / 文本两格式 + `[Image #N]` / 三正则——文本部分引用 CC verbatim；附件 map 与 id 计数器 文本/图片共用；`describeImage` 用 GLM preset 与 active provider 解耦。
- **范围**：图片走 GLM 侧识别注入（用户钦定，非 1:1 CC，已论证损耗边界）；paste-cache 不做（submit 即展开使其 moot）；主流式 api.ts 不动。
- **歧义**：截断 vs 折叠两套独立机制（接线 1 vs 2）；删除「整块 vs 逐字」由 `stripTrailingPlaceholder` 二分；文本占位符 inline 展开 vs 图片占位符 describeImage 注入 两条解析路——均已明确。
- **拆分提示（给 writing-plans）**：本 spec 含两半——文本折叠（自包含 InputBox，小）+ 图片识别注入（跨 InputBox/clipboardImage/imageDescribe/providers/useChat，较大且依赖 GLM）。plan 任务应**文本折叠在前（可独立 ship），图片在后**。
