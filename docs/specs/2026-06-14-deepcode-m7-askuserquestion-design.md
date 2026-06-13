# deepcode M7 子项 1：AskUserQuestion 工具设计

2026-06-14。M7 = 三个独立子系统，按小→大顺序各自 spec→plan→实现：**①AskUserQuestion（本文）②/rewind ③可写 subagent+worktree**。差距依据：`docs/specs/2026-06-14-cc-gap-analysis.md`（AskUserQuestion 浮现为最高性价比项，治长期痛点「模型自作主张」）。

## 目标与决策

用户拍板：**CC 全平奇**（含 preview 并排 + 备注 notes，不砍）；**headless 不注册该工具**（无人可问）。

工具让模型在歧义/需选择时，弹结构化多选题问用户，而非自作主张或只能纯文本提问。复用 deepcode 现有两套机制：**权限弹窗的 `pendingAsk`/`resolveAsk` 挂起-解锁桥** + **工厂工具注入**（同 `makeAgentTool` 注入 client）。

## Schema（zod）

```ts
const schema = z.object({
  questions: z.array(z.object({
    question: z.string(),                         // 完整问句
    header: z.string(),                           // ≤12 字短标签（chip）
    multiSelect: z.boolean(),
    options: z.array(z.object({
      label: z.string(),
      description: z.string(),
      preview: z.string().optional(),             // markdown，聚焦时侧边渲染
    })).min(2).max(4),
  })).min(1).max(4),
})
```
每题运行时自动追加一个「其他（自由输入）」项（不在 schema 里，UI 注入）。

## 工具（src/tools/askUserQuestion.ts 新建，工厂，仅 TUI 注册）

- `makeAskUserQuestionTool(deps: { ask: (questions) => Promise<Answer[] | null> }): Tool<typeof schema>`（`null` = 用户取消）。
- `name:'AskUserQuestion'`、`isReadOnly:true`、`needsPermission:()=>false`（问问题无副作用，不走权限闸门）。
- `call(input)`：`const answers = await deps.ask(input.questions)`；`if (!answers) return '用户取消了提问，请自行按最佳判断继续'`；否则格式化为文本返回模型（见「结果格式」）。
- **注册**：`src/tui/useChat.ts` 工具列表加 `makeAskUserQuestionTool({ ask: questionAsk })`；`src/headless.ts` **不加**（headless 无人可答）。

## 交互管线（镜像 pendingAsk/resolveAsk）

现有权限桥参照 `useChat.ts:297-300`：`ask` 建挂起 Promise + 置 `pendingAsk` 状态 → UI 渲染 PermissionDialog → `resolveAsk` 解锁。AskUserQuestion 平行加一套：

- `ChatState` 新增 `pendingQuestion: PendingQuestion | null`；`ChatCore` 新增 `resolveQuestion(answers: Answer[] | null): void`（`null`=取消）。
- `PendingQuestion = { questions: Question[]; resolve: (a: Answer[] | null) => void }`。
- useChat 内 `questionAsk(questions)`：`new Promise(res => { pendingQuestion = { questions, resolve: res }; setState() })`。
- `resolveQuestion(answers)`：`pendingQuestion.resolve(answers); pendingQuestion = null; setState()`。
- **Esc/Ctrl+C 取消**：镜像 `useChat.ts:534-536` 对 pendingAsk 的兜底——loop 中断时若 `pendingQuestion` 挂起，`resolve(null)`，工具据此返回取消文案。
- `App.tsx` 渲染：`pendingQuestion` 存在时渲染 `<QuestionDialog>`（与 PermissionDialog 同级，互斥——同一时刻只挂一个）。

## QuestionDialog 组件（src/tui/components/QuestionDialog.tsx 新建，镜像 PermissionDialog）

- **逐题**展示，顶部进度 `(i/N)`；答完一题进下一题，末题答完调 `onDone(answers)`。
- 单选：↑↓ 移动 + Enter 确认；数字键 1..n 直选。多选（multiSelect）：↑↓ 移动、空格勾选/取消、Enter 提交（至少选一项）。
- 每题末追加「其他（自由输入）」项；选中它 → 进自由输入态（复用 InputBox 式 useInput 收字符，Enter 提交该题答案为自由文本）。
- **preview**：当前题任一选项带 `preview` → 切左右并排（左：选项列表 + accent 选中态；右：渲染**聚焦项**的 preview，复用 `src/tui/markdown.ts`）。无 preview → 纯竖列表。
- **note**：选定后可加一句自由备注（触发键与流程**对齐 CC 的 AskUserQuestionTool**，实现时参照 `/Users/silas/Desktop/src/tools/AskUserQuestionTool`）。
- **preview 列宽 / note 键 / 整体交互细节对齐 CC**（实现参照 CC 源码，不自创）。
- accent 蓝主题；问句白、描述 dim；与 PermissionDialog 视觉一致。

## Answer 结构与结果格式（对齐 CC：结构化）

```ts
type Answer = { header: string; question: string; selected: string[]; note?: string; freeText?: string }
```
返回模型的是 **JSON 字符串**（对齐 CC 的结构化 answers，模型好解析），按 question 文本为键：
```json
{
  "{question 文本}": { "selected": ["{label}"], "note": "{备注}", "other": "{自由输入}" }
}
```
（`note`/`other` 仅在有值时出现；multiSelect 时 `selected` 多元素。）模型读 JSON 做后续决策。

## 测试

- `askUserQuestion.test.ts`：schema 校验（1–4 题、2–4 项、multiSelect 类型）；`call` 在 mock `ask` 下返回正确 JSON（单选/多选/自由输入/带备注，解析后断言键值）；取消路径（ask resolve `null` → 返回取消文案）。
- `tui.questionDialog.test.tsx`（ink-testing）：渲染问句/选项/进度；数字键选中 → onDone 带正确 answers；multiSelect 空格勾选 + Enter；「其他」进自由输入；有 preview 时并排渲染（断言 preview 文本出现）；note 流程。
- `headless` 工具表**不含** AskUserQuestion 的断言（headless.ts 测试或新增断言）。
- useChat：`questionAsk` 设 `pendingQuestion`、`resolveQuestion` 解锁、Esc 兜底 resolve 的单测。

## 文件结构（增量）

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/tools/askUserQuestion.ts` | 新建 | 工厂工具 + schema + 结果格式化 |
| `src/tui/components/QuestionDialog.tsx` | 新建 | 逐题菜单/多选/Other/preview 并排/note |
| `src/tui/useChat.ts` | 改 | pendingQuestion/resolveQuestion + questionAsk + Esc 兜底 + 注册工具 |
| `src/tui/App.tsx` | 改 | 挂 QuestionDialog（pendingQuestion 时） |
| `test/tools.askUserQuestion.test.ts` | 新建 | 工具/schema/格式化/取消 |
| `test/tui.questionDialog.test.tsx` | 新建 | 组件交互 |

## 不碰 / 范围边界

- headless/loop/session/permissions/api 逻辑零改动（headless 仅「不注册」该工具）。
- 不做 /rewind、worktree（M7 子项 2/3，独立 spec）。
- preview 仅渲染纯 markdown 文本（不做图片/复杂布局）；并排列宽固定折中即可，不过度工程。
