# TUI 权限可见性收口小批（/permissions 合并视图 + 规则文本内嵌 + allow 来源行）设计

日期：2026-06-24
对齐目标：Claude Code 权限弹窗规则文本展示 + `/permissions` 规则可见性。**经 opus 专家实读 CC bundle（`@anthropic-ai/.claude-code-2DTsDk1V/cli.js`）逐点核对**，剔除臆造，剪到 deepcode 实有模型。
所属：master roadmap 第 5 层「TUI 收口小批」（3.7 /permissions UI + 5.6 文案）。执行序 #1。

## 1. 背景与目标

deepcode 的权限内核已具备来源层级追踪（`ruleSources`/`denySources`，5.6 合并 `31e5deb`）与 deny 规则强制（`deny.ts`），但这些能力**未暴露到 UI**：
- `/permissions` 命令（useChat.ts:1123-1140）只列 **user 层 allow 规则**，不显示来源、不显示 deny 规则。
- 权限弹窗（PermissionDialog.tsx）批准「总是允许」前，**看不到将保存的规则文本**——规则在 `pc.ask` 之后才在 permissions.ts:270-277 生成。

本批 = **把已有内核能力暴露到 UI 的 2 件纯可见性改动**，不改权限判定逻辑、不改既有规则生成/写层约定：
1. `/permissions` 合并多层视图 + deny 段 + `deny-rm` 子命令 + 按值删除。
2. 弹窗「总是允许」选项 label **内嵌将保存的规则文本**（对齐 CC「Yes, and don't ask again for `<rule>`」内联呈现）。

> **2026-06-24 写 plan 时核对真实代码砍掉的原 item 3（forceAsk 窄路径 allow 来源行）**：`forceAsk` 在 permissions.ts 仅第 212 行设 true，而该行在 deny 命中分支内（`denyHit = hit` 之后），即 **`forceAsk === true` 必然伴随 `denyHit` 已设值**。askReason 中 deny 永远优先于 allow → allow 来源行**永远不可达（死代码）**。唯一「命中 allow 又仍弹窗」的场景不存在（非 forceAsk 命中 allow 在 permissions.ts:250 提前放行、不弹窗）。调研/专家均漏看此 `forceAsk ⟹ denyHit` 耦合。要做须新增 forceAsk 触发条件=改判定行为，超本批范围 → **剔除**。

## 2. 范围裁剪（实证后剔除 / 不做）

opus 专家实读 CC 后，以下**剔除或不做**，理由附证据：
- ❌ **Tab-amend 编辑规则** —— CC `"Tab to amend"` 真实语义是「切到向 Claude 补充指令」模式，**不是编辑规则**；CC 规则编辑是 `yes-prefix-edited` 常驻 input 行、直接打字、无需 Tab。原「Tab 进入编辑」是臆造，整件砍掉（用户拍板，规则要改去 `/permissions` 删了重授）。
- ❌ **独立「将保存规则：X」预览行** —— CC 把规则文本内嵌选项 label，无独立预览行。(b) 改为内嵌 label。
- ❌ **`Tool(content)` 格式校验** —— 无编辑即无需校验。
- ❌ **ask 返回值升级为 `{decision, editedRule}`** —— 无编辑，`ask` 返回值**保持 `Decision`**。连带：`onDecide` 签名不变 → **App.tsx / FullscreenApp.tsx 的 resolveAsk 不用改**（双组件接线铁律本批不触发）；围栏 ask 调用点（permissions.ts:233 `=== 'no'`）不受影响。
- ⏸️ **对齐 CC 写 local 层**（CC 内联弹窗硬编码 `destination:"localSettings"`）—— deepcode `saveRule` 既有写 **user 层**，改写层是独立决定，超本批，保持 user。
- ⏸️ **prefix 取首词**（CC `indexOf(" ")` 首空格前）—— deepcode 既有 `slice(0,2)` 前 2 词，动它=改既有行为，超本批，保持现状。
- ⏸️ **CC `/permissions` 四 Tab 面板（allow/deny/ask/workspace）+ 增规则三层 destination picker** —— deepcode 权限模型只有 allow/deny + workspace 围栏，**无独立 ask-rule 层**；照搬交互式 JSX 面板=大工程，超「小批」。deepcode 用命令式两段视图适配。

> 未确证项（专家诚实标注，本批不依赖）：CC `/permissions` 面板列表是否逐行显示来源标签、是否限制仅某层可删。deepcode 自行决定：显示来源 + 仅用户层可删（见 §3）。

## 3. 组件设计

### 3.1 `suggestRule` 纯函数（permissions.ts，新导出）

把现 permissions.ts:270-277 的规则生成逻辑**原样抽出**为纯函数，供预览与保存共用（规则单一来源、不重算）：

```ts
export function suggestRule(toolName: string, desc: string): string {
  const firstLine = desc.split('\n')[0]
  const compound = toolName === 'Bash' && splitBashCommand(desc).commands.length > 1
  const pat = toolName === 'Bash'
    ? (isDangerous(desc) || compound)
      ? desc.replace(/\n/g, ' ')
      : firstLine.split(' ').slice(0, 2).join(' ') + ':*'   // deepcode 既有：前 2 词，本批不改
    : desc.replace(/\n/g, ' ')
  return `${toolName}(${pat})`
}
```

`splitBashCommand` / `isDangerous` 已在 permissions.ts 内可用。

### 3.2 `ask` 加 previewRule 通道（返回值不变）

- `PermissionContext.ask` 类型（permissions.ts:104）加**可选第 4 参**，返回值仍 `Promise<Decision>`：
  ```ts
  ask: (toolName: string, desc: string, reason?: PermissionDecisionReason, previewRule?: string) => Promise<Decision>
  ```
- permissions.ts 主路径（现 268-278）：
  ```ts
  const previewRule = suggestRule(tool.name, desc)
  const decision = await pc.ask(tool.name, desc, askReason, previewRule)
  if (decision === 'always') { pc.saveRule(previewRule); return { ok: true } }
  ```
- 围栏 ask（permissions.ts:233）不传 previewRule，`=== 'no'` 判断不变。`askReason` 沿用现有 denyHit 构造（permissions.ts:265-267），**本批不动**。

### 3.3 PendingAsk + PermissionDialog（useChat.ts:166 + PermissionDialog.tsx）

- `PendingAsk`（useChat.ts:166）加 `previewRule?: string`。
- `ask` 实现（useChat.ts:601-610）加 `previewRule` 形参并写入 `pendingAsk.previewRule`。headless.ts:123 `ask: async () => 'no'` 忽略入参，不受影响。
- PermissionDialog.tsx **「总是允许」label 内嵌规则**：OPTIONS 由组件内按 `ask.previewRule` 构建——有则 `总是允许 — ${ask.previewRule}`，无则回退原文案 `总是允许（本会话不再询问）`（围栏 ask 等无 previewRule 场景）。

### 3.4 `/permissions` 合并视图（useChat.ts:1123-1140 重写）

展示合并后的 allow + deny 两段，每行带来源标签，按值删除、仅用户层可删：

- **Allow 段**：源 = 内存合并 `settings.permissions.allow`，来源 = `ruleSources[r] ?? 'user'`。
- **Deny 段**：源 = `resolveDenyList(settings.permissions.deny)`，来源 = `denySources[p] ?? 'builtin'`（`denySources` 即 useChat 已构造的 `buildDenySourceMap(layered.permissionSources.deny)`，构造于 useChat.ts:242、传入权限 ctx 于 702）。
- 渲染：两段各自独立编号 `N. 规则 [来源中文名]`（`permissionSourceName`）。
- 子命令：
  - `/permissions rm <n>`：取 Allow 段显示索引 n 的规则 `r` → 若 `ruleSources[r] ?? 'user' === 'user'`：`removeUserAllowRuleByValue(r)` + 内存 `settings.permissions.allow` splice + `fireConfigChange()`；否则提示 `该规则来自{来源}，请在对应配置文件修改`。
  - `/permissions deny-rm <n>`：取 Deny 段索引 n 的 pattern `p` → 若来源 `=== 'user'`：`removeUserDenyRuleByValue(p)` + 内存同步；否则提示（builtin/project/local 不可删）。
  - 无参：渲染两段 + 操作提示行。空规则：`没有已保存的权限规则`。

### 3.5 config.ts 新增 helper

按值删除（因显示是合并视图，索引不对应 user 文件行）：

```ts
export function listUserDenyRules(): string[]                       // 读 raw user settings permissions.deny
export function removeUserAllowRuleByValue(value: string): boolean  // 从 raw user allow 删该值，返回是否删到
export function removeUserDenyRuleByValue(value: string): boolean   // 从 raw user deny 删该值
```

实现复用现有 raw RMW 模式（参 addUserAllowRule:267 / removeUserAllowRule:275）。**孤儿清理**：本批改完 `/permissions` 改用按值删后，`removeUserAllowRule(index)`（275）若不再被任何调用点引用，按「移除本次改动产生的孤儿」原则删除；删前 grep 确认无其它引用。

## 4. 数据流

```
工具请求 → checkPermission
  ├─ 命中 allow 且非 forceAsk → 直接放行（不弹窗，不变）
  ├─ previewRule = suggestRule(tool, desc)
  ├─ pc.ask(tool, desc, askReason, previewRule)  ← askReason 沿用既有 deny 构造；previewRule 入 PendingAsk
  │     → PermissionDialog：always label 内嵌 previewRule
  └─ decision==='always' → pc.saveRule(previewRule)  ← 与预览同一字符串

/permissions → 合并 allow(ruleSources) + deny(denySources) 两段带来源
  ├─ rm <n>   → 按值删 user 层 allow（非 user 警告）
  └─ deny-rm <n> → 按值删 user 层 deny（非 user 警告）
```

## 5. 测试策略

- **单测 `suggestRule`**：Bash 普通（前 2 词 + `:*`）/ 高危（精确整行）/ 复合（精确）/ 非 Bash（精确）。
- **单测 config helper**：`listUserDenyRules` / `removeUserAllowRuleByValue` / `removeUserDenyRuleByValue`（命中删、未命中返回 false、不误删其它值）。mock 文件层避免污染真实 `~/.deepcode`（沿用既有测试隔离教训）。
- **`/permissions` 格式化与删除**：合并两段渲染含来源标签、`rm`/`deny-rm` 按值删 user 规则、删非 user 规则走警告分支。
- **弹窗逻辑**（ink-testing-library render PermissionDialog 断言 lastFrame）：always label 在有 previewRule 时显示 `总是允许 — <rule>`、无 previewRule 时回退原文案。
- **真机冒烟**（默认全屏 FullscreenApp，配置文件放家目录非 harness scratchpad）：
  ① `/permissions` 显示合并 allow+deny+来源；rm 用户规则成功 / rm 项目（或内置 deny）规则走警告。
  ② 普通工具「总是允许」弹窗显示 `总是允许 — Tool(...)` 内嵌规则。

## 6. 向后兼容与风险

- `ask` 返回值不变（仍 `Decision`）→ 零调用点破坏；新增第 4 参可选 → 旧调用点（围栏）无需改。
- `onDecide` 签名不变 → 双组件接线不触发（区别于 TUI 计划 1/2/3 的双改铁律）。
- `/permissions` 合并视图显示项目/本地/内置规则但仅用户层可删——非用户层走友好提示，不静默失败。
- `saveRule(previewRule)` 复用预览字符串：批准的规则 = 用户在弹窗看到的规则，无「预览与实存不一致」风险。

## 7. 偏离 CC 记录

| 维度 | CC 真实做法（实证） | deepcode 本批 | 理由 |
|---|---|---|---|
| 规则编辑 | `yes-prefix-edited` 常驻 input 行直接编辑；Tab=向模型补充指令 | 不做编辑（去 `/permissions` 删了重授） | 用户拍板砍编辑；Tab 编辑系臆造已剔除 |
| 规则文本呈现 | 内嵌选项 label「Yes, and don't ask again for `<rule>`」 | 内嵌 always label `总是允许 — <rule>` | 对齐 |
| always 写层 | 内联硬编码 `localSettings` | user 层（既有） | 改写层超本批 |
| prefix 粒度 | 首词 + `:*` | 前 2 词 + `:*`（既有） | 改既有行为超本批 |
| `/permissions` 形态 | 交互式 JSX 面板 allow/deny/ask/workspace 四 Tab + 三层 destination picker | 命令式 allow/deny 两段 + 按值删 | deepcode 无 ask-rule 层；命令式适配，避大工程 |
| 建议来源 | server 端 `permissionResult.suggestions` + 本地组装 | 本地纯函数 `suggestRule` | deepcode 无 server-side suggestions |
