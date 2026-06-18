# deepcode Skills 清单预算 + scope 配置 设计 spec

**日期：** 2026-06-17
**机制：** 1.2 Skills 终审 follow-up（合并未阻断的两件，用户钦定「先做这两件再 1.8」）。
**前置：** 1.2 Skills 已合 main（merge `0685ecb`）。
**对齐依据：** CC 源码 `commands.ts:563-581`（getSkillToolCommands 过滤）+ `SkillTool/prompt.ts`（formatCommandsWithinBudget，per-entry 250 char + 总 ~8000 char + 优先级）+ `loadSkillsDir.ts:216/255`（可见性默认）。**专家实读核实**：CC 无任何「按来源」的可见性默认差异（所有来源默认 user-invocable:true + disable-model-invocation:false），对「清单灌满」的唯一解法是**预算截断**，非来源隔离。
**TUI：** 否（纯逻辑 + 配置 + 清单格式化；接线走已有 loadSkills 调用点）。

---

## 1. 目标与范围

解决 1.2 Skills 终审挑出的两个产品级问题，**默认行为保持对齐 CC**：

1. **fix #1 清单 token 预算**（对齐 CC）：当前 prompt.ts 和 skill.ts 的 skill 清单**无上限**地全列——用户机器上 `~/.claude/skills` 几十个 gstack 技能被每次请求塞进 system prompt + Skill 工具 description，白烧 token（回退 deepcode 的省 token 卖点）。照 CC 的 `formatCommandsWithinBudget` 加预算截断。
2. **fix #2 scope 配置**（opt-in 控制，默认 = CC）：CC 无来源级隔离，对齐 CC 的默认 = 全扫全可调用。但 deepcode 里 gstack 技能正文引用跑不动的 bash 基建，模型可能挑到。给 **opt-in 配置**让在意的用户收窄发现范围；**默认保持 CC 行为**（全扫、双可调用）。

### 做
- `formatSkillListing` 纯函数：per-entry description 截 250 字符 + 总预算（默认 8000 字符，可配）+ 优先级排序 + 超出丢弃并在清单末尾留「另有 N 个省略」一行（不静默截断）。
- `Settings.skills` 配置：`sources`（扫哪些目录家族，默认全部）+ `deny`（按名排除）+ `listingBudgetChars`（预算上限，默认 8000）。
- `loadSkills` 应用 sources/deny 过滤；为优先级排序加 `priority` 字段。
- prompt.ts + skill.ts 两处清单改用 `formatSkillListing`。
- useChat/headless 把 `settings.skills` 传给 loadSkills。

### 不做（YAGNI / 留增量）
- `allow` 白名单（`deny` + `sources` 已够覆盖需求，避免双向语义复杂度）。
- glob/正则 deny（按**精确名**排除；gstack 技能无共同前缀，真要批量排除用 `sources:['deepcode']` 一刀切）。
- 按来源设不同的 modelInvocable **默认**（= 偏离 CC，用户已选 B 否决）。
- 清单按 token（非 char）精确计量（CC 用 char×4 估算，照搬 char 预算即可）。

---

## 2. 配置：`Settings.skills`

```ts
// src/config.ts
export interface SkillsConfig {
  /** 扫哪些目录家族；缺省 = 两者都扫（对齐 CC 全扫）。
   *  'claude' = <home|proj>/.claude/{skills,commands}；'deepcode' = <home|proj>/.deepcode/{skills,commands}。
   *  `['deepcode']` 一刀切跳过所有 .claude 源（干掉 ~/.claude 的 gstack 灌入）。 */
  sources?: Array<'claude' | 'deepcode'>
  /** 按精确 skill 名排除（不加载→不在任何清单、不可调用）。 */
  deny?: string[]
  /** 模型清单 + Skill 工具 description 的总字符预算上限；缺省 8000（对齐 CC）。 */
  listingBudgetChars?: number
}
export interface Settings {
  // …现有字段…
  skills?: SkillsConfig
}
```

`parseSkillsConfig(raw): SkillsConfig | undefined`（config.ts，宽松解析，对齐 `parseMcpServers` 风格）：
- `sources`：数组、元素仅留 `'claude'|'deepcode'`，空/非法 → undefined（落默认全扫）。
- `deny`：数组、留 string、trim 非空。
- `listingBudgetChars`：正整数才取，否则 undefined（落默认 8000）。
- 整个对象非法 → undefined。

---

## 3. `loadSkills` 应用 sources/deny + priority

```ts
// src/skillsLoader.ts
export interface SkillDefinition {
  // …现有字段…
  priority: number   // 清单优先级（小=高）：项目=0，user(home)=1，legacy=2。listing 排序用。
}

export function loadSkills(cwd, home, config?: SkillsConfig): SkillDefinition[]
```

- **sources 过滤**：`config.sources` 给定时，只扫选中家族的目录。映射：
  - `'deepcode'` → `<home>/.deepcode/commands`、`<cwd>/.deepcode/commands`、`<home>/.deepcode/skills`、`<cwd>/.deepcode/skills`
  - `'claude'` → `<home>/.claude/skills`、`<cwd>/.claude/skills`（注：deepcode 无 `.claude/commands` legacy 源，对齐现状）
  - 缺省（undefined/空）→ 两者全扫（= 现状目录序）。
- **priority 赋值**：扫描时按目录定：legacy（commands/）→ 2；skills 目录下，`skillDir` 在 cwd 内（项目）→ 0，否则（home/user）→ 1。
- **deny 过滤**：merge（last-wins）后，剔除 `config.deny` 里精确命中 name 的项。
- 默认（无 config）行为与现状**字节级一致**（priority 字段新增不影响发现/合并语义）。

---

## 4. `formatSkillListing` 预算截断（对齐 CC）

```ts
// src/skillsLoader.ts（纯函数）
export const MAX_LISTING_DESC_CHARS = 250
export const DEFAULT_LISTING_BUDGET_CHARS = 8000

export function formatSkillListing(
  skills: SkillDefinition[],          // 已是要列的集合（调用方先按 modelInvocable/userInvocable 过滤）
  opts?: { maxDescChars?: number; budgetChars?: number },
): { text: string; shown: number; dropped: number }
```

逻辑（对齐 CC formatCommandsWithinBudget）：
1. 按 `priority` 升序稳定排序（项目 < user < legacy；同级保持发现序）。
2. 逐条构造行 `- ${name}：${truncate(description, maxDescChars)}${whenToUse ? ` — ${truncate(whenToUse, maxDescChars)}` : ''}`（description 与 whenToUse 各截 `maxDescChars`，对齐 CC per-entry 上限；`truncate` 超长加 `…`）。
3. 累加字符数；若加入下一条会超 `budgetChars` 则停止，其余计入 `dropped`。
4. `dropped > 0` 时末尾追加一行：`…（另有 ${dropped} 个技能因清单预算省略；用 settings.skills.deny / sources 收窄，或写更短的 description）`（不静默截断，对齐「no silent caps」）。
5. 返回 `{ text: 行 join('\n'), shown, dropped }`。空集合 → `{ text:'', shown:0, dropped:0 }`。

**两处复用**：
- `src/prompt.ts` `buildSystemPrompt`：现内联 `callable.map(...).join('\n')` → 改调 `formatSkillListing(callable, { budgetChars })`，清单节用返回的 text；空 text 不加节。预算从哪来？buildSystemPrompt 不持有 settings——**新增可选参 `budgetChars?`**，由调用方（useChat/headless）从 `settings.skills?.listingBudgetChars` 传入（缺省 8000）。
- `src/tools/skill.ts` `makeSkillTool`：description 里的清单（现 `callable.map(...).join('\n')`）→ 改调 `formatSkillListing(callable, { budgetChars: deps.listingBudgetChars })`；deps 加可选 `listingBudgetChars?`。

> 注：两处都只列各自该列的集合——prompt/skill 工具列 `modelInvocable`（与现状一致）。预算独立作用于这个已过滤集合。

---

## 5. 接线

| 文件 | 改动 |
|---|---|
| `src/config.ts` | `SkillsConfig` 类型 + `Settings.skills` + `parseSkillsConfig`，loadSettings 接入 |
| `src/skillsLoader.ts` | `SkillDefinition.priority` + `loadSkills` 加 config 参（sources/deny/priority）+ `formatSkillListing` + 常量 |
| `src/prompt.ts` | `buildSystemPrompt` 加 `budgetChars?` 参 + 清单改用 `formatSkillListing` |
| `src/tools/skill.ts` | `makeSkillTool` deps 加 `listingBudgetChars?` + description 清单改用 `formatSkillListing` |
| `src/tui/useChat.ts` | `loadSkills(cwd, undefined, settings.skills)` + buildSystemPrompt 传 budgetChars（3 处调用点）+ makeSkillTool deps 传 listingBudgetChars |
| `src/headless.ts` | 同上（loadSkills 传 config + buildSystemPrompt budgetChars + skill deps） |

---

## 6. 测试计划（TDD）

- `parseSkillsConfig`：sources 合法/非法元素过滤、deny trim、listingBudgetChars 正整数校验、整体非法→undefined。
- `loadSkills` config：`sources:['deepcode']` 跳过 .claude 源、`deny` 精确排除、priority 赋值（项目 0/user 1/legacy 2）、无 config 字节级同现状。
- `formatSkillListing`：per-entry 250 截断（description + whenToUse）、总预算超出丢尾部、dropped 计数 + 末尾省略行、优先级排序（项目先）、空集合空串、预算够时全列无省略行。
- `prompt.ts`：清单经 formatSkillListing（超预算时含省略行、传入小 budgetChars 触发截断）。
- `skill.ts`：description 清单经 formatSkillListing（deny 的 skill 既不在 description 也不可调用）。
- 现有 skills/prompt/skill/useChat/headless 测试零回归。

---

## 7. 记录偏离 / 取舍

1. **scope 是 deepcode 特有配置**：CC 无来源级 scope（专家核实确认）。deepcode **默认对齐 CC**（全扫全可调用），scope 纯 opt-in，不偏离默认行为。
2. **预算按 char 非 token**：对齐 CC 的 char×4 估算法，不做精确 token 计量。
3. **deny 按精确名、无 glob**：批量排除用 `sources:['deepcode']`，避免 glob 复杂度。
4. **listing 优先级**：项目>user>legacy 的粗排序；同源内保持发现序，不做更细的相关性排序（CC 有 bundled-first，deepcode 无 bundled）。

---

## 8. 执行流程

writing-plans 出 bite-sized TDD 计划 → subagent-driven 每任务双审 → 纯逻辑免冒烟（无 TUI 改动）→ finishing 合 main。合并前全量 test + typecheck + build 全绿。完后接 1.8。
