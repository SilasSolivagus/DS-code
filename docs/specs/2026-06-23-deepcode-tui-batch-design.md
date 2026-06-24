# TUI 攒最后批 · 设计 spec（2026-06-23，opus 终审后修订）

调研依据见 `docs/specs/2026-06-23-deepcode-tui-batch-investigation.md`（6 agent 实读 CC bundle v2.1.76 + sdk-tools.d.ts + 摸 deepcode 现状）。本批是 CC 第 1-5 层「碰 TUI 件」的收官批，全部一次真机冒烟。

**修订史（2026-06-24 计划3 起步实读 CC 校准两点）**：① 3.6 /fork memdir 推翻旧 🟢-3「forked 物理隔离」→ 改**共享项目 memdir**（实读 CC `commands/branch/branch.ts`：fork 不碰记忆目录、记忆按 git-root 收敛；旧判断把会话 fork 误同 C2 forked-agent 写隔离）+ 自动 (Branch) 标题；② 5.7 statusline 刷新模型由「turn 边界」精确化为 CC 真实的**事件驱动 + 300ms 去抖 + 在途 abort + 缓存**（实读 `components/StatusLine.tsx`），输出由「首行截断」改为 CC 的**多行 trim 解析 + 保留上次缓存绝不抛**。详见各节内联修订。

**修订史（2026-06-23）**：opus 专家对抗终审挖出 3 🔴 + 5 🟡（实证 CC 符号 + deepcode 行号），已逐条落地：①1.4 **保留写盘**作为团队/云前向兼容底座（用户产品愿景=国内最强团队 vibe coding harness：团队 leader 审批/云 resume 回填等未来消费方将接入；专家「单机无消费方」推理基于当前单机，被产品路线图覆盖）；②5.9 改为「工作目录围栏 + /add-dir」（用户拍板本批引入围栏）+ deny 不可击穿红线；③1.4 plan 门修 forceAsk 交互；④5.7 补超时/截断+澄清执行加固非权限判定；⑤5.4 消费点更正 12；⑥5.3 钉注入点 + 静态 prompt 重建。

## 范围（9 件，用户 2026-06-23 拍板）
忠实镜像 CC，按共享基建聚成 4 组。设计开放点已敲定：1.4=完整对齐 CC（Shift+Tab + allowedPrompts + **写盘留团队/云底座**）、5.3=内置 Explanatory+Learning、5.4=六套主题热切全做、5.9=**本批引入工作目录围栏 + /add-dir**。

| 组 | 件 | 量 |
|---|---|---|
| A SelectList picker 族 | 2.7 /model 选择器 · 5.3 Output styles · 5.4 /theme 热切 | S·M·M |
| B 会话命令族 | 3.6 /fork · 3.6 /rename · 5.9 工作目录围栏+/add-dir | S·S·**M** |
| C 权限/执行族 | 1.4 Plan mode · 1.6 Task 依赖图薄片 · 5.7 /statusline | M+·S·S |
| D 显示层 | 1.7 Hooks 进度 | S |

**架构件（需 opus 终审）**：1.4 Plan mode 权限门、5.9 工作目录围栏（新权限门）、5.4 theme context 化。

**红线（不在本批，已 DEFER/SKIP）**：1.5 worktree（L，需 ToolContext 独立 cwd 重构，独立成批）· 5.1 keybindings（L dispatcher）· 重型 1.6 Team/teammate（归第6层）· 5.2 vim · 5.5 语音 · 4.11 多模态（DeepSeek 无视觉 API）· 5.8 promptSuggestion · 3.6 /tag · 5.10 tips · 5.11 buddy。

---

## ⭐ permissions.ts 集成次序（1.4 plan 门 + 5.9 围栏门共享，先定）
`checkPermission`（permissions.ts:192-258）现有判定链：deny(201-215) → isReadOnly 早返(216) → needsPermission false(217-219) → yolo(220) → acceptEdits(221) → rule(222-228) → PermissionRequest hook(229-239) → ask(240-257)。

本批插入两道新门，**必须置于 deny 门之后（deny 永远最高优先、绝不被绕过/凌驾）、isReadOnly 早返(:216) 之前**：

```
1. deny 门 (201-215)                      ← 不动（🔴-3 红线）
2. [新] plan 门：mode==='plan' && !tool.isReadOnly → 拒（不带 !forceAsk）
3. [新] 围栏门：mode!=='yolo' && tool 工作路径在 cwd∪白名单外 → 走 ask（只读工具需独立分支，见下）
4. isReadOnly 早返 (216) ...原链不变
```

**关键集成陷阱（实施必读）**：
- **plan 门不带 `!forceAsk`**（🟡-3）：plan 模式语义=非只读一律拒，严于 deny 降级 ask。一个触发 deny 的非只读 Bash（forceAsk=true）在 plan 模式下必须被 plan 门拒，不能落到 :243 ask。测试覆盖「plan 模式 + 触发 deny 的非只读 Bash → 拒」。
- **围栏门对只读工具不能复用 forceAsk**：Read/Glob/Grep 是 isReadOnly，:216 `isReadOnly && !forceAsk` 即便 forceAsk=true 也会被 :219 `if(desc===false) return ok:true` 短路放行（现有「forceAsk 仅对 Bash」注释）。故围栏门对路径在外的**只读文件工具需自己直接发 `pc.ask`**（或重构 :219 短路），不能依赖 forceAsk 透传。这是 5.9 的架构核心，opus 终审重点。
- yolo（bypassPermissions）旁路围栏（CC 一致）；deny 不受围栏/yolo 影响（始终最前）。

---

## 组 A · SelectList picker 族
三件共用 `tui/components/SelectList.tsx` + config 字段 + picker 渲染模式。

### 2.7 /model 选择器（S）
**现状**：`useChat.ts:836-852` 无参 `/model` 走 `rotateModel`（`resumeModel.ts:10`）盲翻转 fast↔smart；有参直赋。2.8 已把底层数据全做（`providers.ts`：`activeProvider().meta` 多档表、`modelMeta()`、价格、window、归属校验）。
**改动**：
- 新 core 方法 `modelList()`：返回 `activeProvider().meta` 全档 + fast/smart 别名行，每行带 `contextWindow`/价格。
- 无参 `/model` → SelectList picker（复用 App.tsx resume/rewind 同款分支）→ 写 meta（`appendMeta` 已带 `providerId`）。
- 有参 `/model <名>` 保留现行为。帮助文本 `useChat.ts:210` 旧措辞更新。
- **不做**运行期跨 provider 热切（与 2.8 provider 锁定 memoize 冲突）。
**测试**：`modelList()` 纯函数（glm 8 档 + deepseek 档 + 别名行 + 价格/window 列）；无参→picker、有参→直赋。

### 5.3 Output styles（M）
**现状**：无 `outputStyle` 配置；`prompt.ts:34 buildSystemPrompt` **注释明写「只在会话启动调用一次，产物必须整会话静态——KV 缓存命中前提」**；工作守则块在 :51-62。
**改动**：
- config 加 `outputStyle?: string`（settingsLayers，普通可移植字段，非 DANGEROUS_TOP_KEYS）。
- 内置两样式（deepcode 适配 prompt，**非照抄 CC 措辞**）：**Explanatory**（解释实现选择与代码库模式，`keepCodingInstructions:true`=追加在工作守则后）、**Learning**（教学式，`keepCodingInstructions:true`）。`default`=不注入（空段）。
- 用户样式：`~/.deepcode/output-styles/*.md` 加载（复用 `skillsLoader.ts` 目录加载 + frontmatter 解析），字段 name/description/prompt/可选 keepCodingInstructions。
- **注入点 + 替换语义（🟡-5 钉死）**：`buildSystemPrompt` 内，按 `outputStyle` 取样式 → `keepCodingInstructions:true` 时在工作守则块(:51-62)**后追加**样式 prompt 段；`keepCodingInstructions:false` 时用样式 prompt **替换**工作守则块(:51-62)（对齐 CC `keepCodingInstructions` 门控）。
- **静态 prompt × 热切（关键设计）**：`/output-style` 切换需**重建 system prompt 并替换 messages[0]**，接受一次性 KV 缓存重置（显式用户动作，合理代价；同 memory/skills 变更）。实施须确认 buildSystemPrompt 可被重新调用且 useChat 能替换 messages[0]——若现架构不支持 mid-session 重建，则降级为**会话启动时定（config/flag）+ `/output-style` 改了下次生效**（二选一，实施期按架构现状定，spec 默认走重建）。
- `/output-style` picker（SelectList 列 default + 内置 + 用户样式）。
**测试**：样式加载（内置 + md + 缺失优雅回退）；注入（default 空 / keepCodingInstructions=true 追加 / =false 替换工作守则块）；picker 分发；重建路径 messages[0] 替换。

### 5.4 /theme 热切六套（M）
**现状**：`tui/theme.ts`（15 行）单一 `as const` `T`（accent `#6E8BFF` + ok/err/warn/dim），**实测 12 个文件**直接 `import {T}`（🟡-4 更正，spec 旧说 ~10）：QuestionDialog/PermissionDialog/Banner/StatusFooter + **withBullet.tsx/setup.tsx/renderItem.tsx/ToolLine.tsx** 等。
**改动**：
- 六套主题：`dark`/`light`/`dark-daltonized`/`light-daltonized`/`dark-ansi`/`light-ansi`（ansi 套用 ANSI 安全色保无 truecolor 终端可读；daltonized 色盲友好）。
- `T` const → React context（`ThemeProvider`+`useTheme()`）；**12 处消费点全部改读 `useTheme()`**——**getter/proxy 捷径对热切无效**（ink 重渲染依赖 React state 触发，纯 getter 不触发），必须 context 化。实施 grep 穷举 `import.*theme`/`\bT\.` 核对 12 处全覆盖；`setup.tsx` 须确认在 ink 树内（否则单独处理）。
- config 键 `theme?: string`（settingsLayers，默认 dark）；`/theme` picker → state 驱动即时热切。
**测试**：六套形状（含 accent/ok/err/warn/dim）；ansi 套色在 ANSI 安全集；context 切换触发重渲染；config 默认 dark；12 消费点无漏（快照或断言）。

---

## 组 B · 会话命令族

### 3.6 /fork（S）
**现状**：`/rewind` 有 turnId 游标；无用户级 `/fork`。memdir（`memdir/paths.ts memdirFor`）按 git-root/cwd per-project，**所有会话本就共享**。
**改动**：`/fork` → 拷贝当前 messages 切片到 `newSession`（`session.ts:75` 系），沿用 meta，切新会话继续，自动加 `" (Branch)"` 标题（复用 /rename 的 title 机制，碰撞升级 Branch 2/3…）。
**🔧 memdir 归属（2026-06-24 实读 CC 修订，推翻旧 🟢-3）**：新会话 memdir **共享项目 memdir，不做特殊隔离**——对齐 CC `/branch`（`commands/branch/branch.ts createFork`）：fork 只换 sessionId+新 transcript 文件，记忆目录键=git root，fork 全程不碰记忆目录、无隔离参数（CC 刻意让记忆按仓库收敛，见 `memdir/paths.ts` 注释）。旧 spec 把会话级 fork 误同于 C2 autoDream 的 forked-agent 写隔离（那是后台子 agent 的 memdir 写隔离，两码事）。「fork 污染原会话」担忧不成立：任意两个同 repo 会话本就共享记忆。
**测试**：fork 产出独立 session 文件 + messages 切片正确 + meta 继承 + 原会话 transcript 不受影响 + 自动 (Branch) 标题（碰撞升级）。**不测 memdir 隔离**（已确认共享）。

### 3.6 /rename（S）
**现状**：`SessionMeta`（`session.ts:6-13`）无 title；`listSessions`（:147,160）预览硬编码首句 60 字。
**改动**：`SessionMeta` 加可选 `title`；`/rename <名>` 写 meta；`listSessions` 预览优先 `title ?? 首句60字`。
**测试**：rename 写 meta + 预览优先 title + 无 title 回退首句。

### 5.9 工作目录围栏 + /add-dir（M，架构件）
**现状（🔴-2 更正）**：**deepcode 当前无任何工作目录围栏**——Glob(glob.ts:20)/Grep(grep.ts:62)/Read·Edit·Write(read.ts:26 系)全接受任意绝对/相对路径、无 cwd 包含校验；`checkPermission` 无 path-inside 门，唯一路径保护是 deny。即模型现可 `Read /etc/passwd`。CC `/add-dir`（`cBY`）dispatch `addDirectories`，默认 session（auto-suggest 恒 session），可选 localSettings 持久；围栏判定 `kI`/`Iv` 做祖先包含（目标须是某允许根后代、相对路径不含 `..`）。
**用户拍板（2026-06-23）：本批引入围栏**（非 DEFER），故 5.9 = 新建围栏 + add-dir 开口，两部分：
1. **工作目录围栏**：
   - 文件工具加 `workspacePaths(input, cwd)`（返回该工具要访问的路径集，类比现有 `deniablePaths`）：Read/Edit/Write/Glob/Grep 实现之。
   - `PermissionContext` 加 `cwd`（已有）+ `additionalDirs: string[]`（会话内白名单）。
   - 新纯函数 `isInsideWorkspace(p, cwd, additionalDirs)`：p 是 cwd 或某 additionalDir 的后代（resolve 后无 `..` 逃逸）。
   - 围栏门（见上「集成次序」）：路径在外 → `pc.ask`（**非硬 deny**，用户可批，对齐 CC + 非破坏性）；只读工具走独立 ask 分支（绕 :219 短路）。
2. **/add-dir 命令**：`/add-dir <path>` → 解析绝对路径加进会话内 `additionalDirs`（**不落盘 user settings**，对齐 CC session 默认 + 避免越权持久化）。
**🔴-3 安全红线（不可违反）**：
   - add-dir 白名单**绝不凌驾 deny**：围栏门在 deny 门(201-215)**之后**，deny 始终最前生效。`/add-dir ~` 后 `~/.ssh/id_rsa` 仍被 BUILTIN_DENY 拒——**禁止任何 add-dir/围栏改动触碰 permissions.ts:201-215 deny 早返段**。
   - 围栏只放宽「问不问」，deny 决定「能不能」，两套正交（CC `kI` 围栏 vs `alwaysDenyRules` deny 独立）。
**非破坏性注记**：围栏对 cwd 内操作零影响（最常见路径）；仅 cwd 外触发 ask。yolo 旁路。
**测试**：`isInsideWorkspace` 纯函数（后代/逃逸/白名单命中/相对解析）；围栏门（cwd 内放行 / cwd 外 ask / 只读工具 cwd 外也 ask 不被 :219 短路 / yolo 旁路 / **deny 路径即便在白名单内仍拒**——/add-dir ~ 后 ~/.ssh/id_rsa 拒）；/add-dir 加白名单后该目录内放行；不落盘。**架构件 opus 终审（新权限门 + deny 正交性 + :219 短路绕过）。**

---

## 组 C · 权限/执行族

### 1.4 Plan mode 完整对齐 CC（M+，架构件）
**CC 真实模型**（实读）：plan 是 permission **mode**（d.ts:297 enum 含 `"plan"`），**无 EnterPlanModeTool**；只有 `ExitPlanMode` 工具（d.ts:349 输入 `allowedPrompts?:{tool:"Bash";prompt}[]`，d.ts:2227 输出 `plan/isAgent/filePath`，校验 `mode==="plan"` 否则拒）。CC 写盘门控在 team/agent/byoc 云（`$Y()`/`VP1()`），用途=团队 leader 审批/云 resume 回填。**deepcode 当前单机无这些消费方，但用户产品愿景（国内最强团队 vibe coding harness）把团队/云列为路线图——故保留写盘作前向兼容底座**，当前审批仍喂弹窗、无额外消费。进入靠 Shift+Tab 三态 / `--permission-mode plan`。
**现状**：`PermissionMode='default'|'acceptEdits'|'yolo'`（permissions.ts:70）；`checkPermission` 无 plan 分支；`/accept`（useChat.ts:877）仅 default↔acceptEdits。
**改动**：
1. `PermissionMode` 加 `'plan'`。
2. **plan 门**（见上「集成次序」，🟡-3 修正）：`if (pc.mode==='plan' && !tool.isReadOnly) 拒`（**不带 `!forceAsk`**），置 deny 门后(:215 后)、isReadOnly 早返(:216) 前。语义=plan 模式非只读一律拒，严于 deny 降级。
3. **进入机制**：
   - `/plan` 命令切态（保底可达，复用命令分发）。
   - **Shift+Tab 三态循环** default→acceptEdits→plan→default：**实施第一步先验 `\x1b[Z` 经 ink `parse-keypress` 可达性**（一次性探针确认收到 shift+tab 事件）；可达则接 App.tsx；**不可达则降级仅 `/plan`**，spec 不卡住。
4. **ExitPlanMode 工具**（`src/tools/exitPlanMode.ts`，`isReadOnly:true`）：校验当前 plan mode；输入 `plan:string` + `allowedPrompts?:{tool:'Bash',prompt}[]`；**写盘**计划到 `~/.deepcode/projects/<projectKey>/plans/<session-slug>.md`（镜像 CC slug-keyed 路径，复用 memdir 的 projectKey sanitize），同时 `plan` 文本喂 5.6 `PermissionDialog` 审批渲染（弹窗读 plan 文本、非读盘文件）；批准后 `setMode` 回 prePlanMode/default + allowedPrompts 注入 Bash 语义放行规则（复用 saveRule/matchRule 前缀）；输出 `{plan, isAgent, filePath}`。注册 allTools + **加 GLOBAL_SUBAGENT_DENY**。**写盘=团队/云前向底座**：未来 leader 跨 agent 审批 / cloud resume 回填的消费方接入点，当前仅持久化、无额外消费。
5. system prompt 注入 plan 指引段（plan mode 时：探索→写计划→禁落地修改→ExitPlanMode 请批准）。
**🟢-2 防呆**：`GLOBAL_SUBAGENT_DENY`（agentTypes.ts:19）加 ExitPlanMode 后，**agent.ts:47 + skill.ts:46 两处调用点**的工具计数/列表断言测试都要更新。
**测试**：plan 门（拒非只读 / 放只读 / **plan + 触发 deny 的非只读 Bash → 拒不落 ask**）；ExitPlanMode（非 plan mode 拒 / plan mode 写盘 plans 目录 + slug 命名 + 喂弹窗 / 批准 setMode + allowedPrompts→规则 / 输出含 filePath）；mode 枚举；GLOBAL_SUBAGENT_DENY 含 ExitPlanMode（两处计数断言）。**架构件 opus 终审。**

### 1.6 Task 依赖图薄片（S）
**现状**：`taskList.ts:6-13` Task 无 blocks/blockedBy；status `'pending'|'in_progress'|'completed'`（+update 接 `'deleted'`，软删 `_deleted` :65）。
**改动**：Task 加 `blocks?:string[]`/`blockedBy?:string[]`；`TaskUpdate` 加 `addBlocks`/`addBlockedBy`（taskTools.ts）；`TaskList` 过滤已 completed 的 blockedBy 项；claim/start（→in_progress）前校验「blockedBy 全 completed」。**🟢-1**：blockedBy 项若被软删（`_deleted`）**视同已清**，否则删掉的依赖永久卡死后继。**不动** Team/teammate/SendMessage（归第6层）。
**测试**：加依赖 + blockedBy 未清拒 in_progress + 依赖完成可 claim + TaskList 过滤已完成依赖 + **软删依赖视同已清**。

### 5.7 /statusline 自定义（S）
**现状**：StatusFooter 展示侧已覆盖 95%。CC statusLine 走 `vS1`（与 hook 命令执行同函数，带 `CLAUDE_PROJECT_DIR` env），**强制传 `AbortSignal.timeout`**（不吃 10min 默认）+ `stdout.trim().split('\n')` 取行；只从 policy/user 读、不从 project 读、`disableAllHooks` 同禁。
**改动**：
- settings 加 `statusLineCommand?:string`；列入 `DANGEROUS_TOP_KEYS`（settingsLayers.ts:14）→ project + git-tracked local scope 剥离（与 hooks 同级，机制自洽）；仅 user/非跟踪 local 可设。**注**：CC 未压缩源码靠 trust gate 而非 scope 剥离防恶意 project statusLine；deepcode 无 trust gate，DANGEROUS_TOP_KEYS scope 剥离即 deepcode 等价信任边界（与 hooks/mcpServers 同 idiom），保留此法。parsePresent（settingsLayers.ts:147）注册新标量字段。
- **执行=加固通道非权限判定（🟡-2）**：statusLineCommand 是用户自设命令，CC 不弹窗/不过 deny（直接 spawn）。新建轻量 `execStatusLineCommand`（参考 execCommandHook 的 bash spawn + env 隔离，~30-40% 可复用，**不强行复用** execCommandHook 的 async/registerAsync 编排），**不走 splitBashCommand 前缀放行/不弹权限窗**。
- **刷新模型（2026-06-24 实读 CC `components/StatusLine.tsx` 修订）**：对齐 CC = **事件驱动 + 300ms 去抖 + 在途 abort + 结果缓存**，**非 interval、非每帧**。触发信号：最后一条 assistant 消息变化（turn 推进）/ 权限模式 / 模型 / （deepcode 无 vim 模式可略）。把 messages 大对象藏 ref，避免每帧/流式 token 触发。每次重跑先 abort 上一个在途子进程（单飞）。
- **超时 + 输出解析（🟡-1 修订）**：`AbortSignal.timeout(5000)`（CC 默认 5s）。stdout 解析对齐 CC：`trim() → split('\n') → 逐行 trim 丢空行 → join('\n')`（**保留多行**，非首行）；为 footer 紧凑再加总长度上限截断（deepcode 增量，防撑爆）。exit≠0 / 空输出 / abort / 抛异常 → 返回 undefined，**保留上次缓存值、绝不抛**（CC 静默吞）。
- 渲染：缓存的 stdout 段附加进 StatusFooter（展示侧主体不动；命令不在渲染路径上跑，渲染只读缓存）。
**测试**：有 statusLineCommand 渲染缓存 stdout 段 / 无则不显 / 命令失败保留上次缓存不抛 / 超时中止 / 多行 trim 解析 / 输出超限截断 / 300ms 去抖（连续触发只跑一次）/ 在途 abort / project scope 剥离该字段。

---

## 组 D · 显示层

### 1.7 Hooks 进度（S）
**现状**：hooks 引擎全（hooks.ts/hookRuntime.ts）；`Spinner.tsx` 有 turn spinner 但不知 hook 在跑。
**改动**：`runHooks` 加可选 `onProgress(label?:string)` 回调；慢阶段（PreCompact/SessionStart/Stop）调用点传文案 → 喂现成 Spinner 渲染位；PreToolUse/PostToolUse 瞬时不显（对齐 CC 点缀式）。文案中文化「正在运行 PreCompact 钩子…」。
**测试**：onProgress 慢阶段被调 + label 透传 + 瞬时 hook 不触发进度。

---

## 交付与验证流程
- **既定 SDD 流程**：spec → writing-plans → subagent 双审（每件 sonnet/haiku）+ **架构件 opus 终审（1.4 plan 门、5.9 围栏门、5.4 theme context 化）** → 一次真机冒烟 → 合 main。
- **writing-plans 排布建议（🟢-4）**：1.4 与 5.9 各排成带 opus 终审 gate 的子计划（架构件、节奏重）；其余 7 件按组并行降仪式。
- **真机冒烟重点**（全碰 TUI）：① Shift+Tab 三态可达性（或确认降级 /plan）② ExitPlanMode 审批弹窗 + allowedPrompts 生效 + 计划落盘 plans/<slug>.md③ /theme 六套热切重渲染 ④ /model 选择器列全档 ⑤ output-style 注入实际改变响应风格（+ 切换重建 prompt）⑥ /fork 分叉独立 + memdir 隔离 ⑦ 围栏：cwd 外 Read 触发 ask、/add-dir 后放行、**`/add-dir ~` 后 ~/.ssh/id_rsa 仍被 deny 拒**（deny 不可击穿冒烟）⑧ Hooks 进度 spinner 文案。
- **教训防呆**：① 新写工具（ExitPlanMode）同步 GLOBAL_SUBAGENT_DENY + 两处调用点(agent.ts:47/skill.ts:46)计数断言；② 改读路径的测试同步 mock；③ TUI 触发键（Shift+Tab）先实读 ink parse-keypress 验可达；④ theme context 化穷举 grep 12 消费点防漏改；⑤ 围栏/plan 门置于 deny 门之后、isReadOnly 早返之前，围栏对只读工具走独立 ask 绕 :219 短路。

## 模块边界小结（隔离与清晰）
- `tui/components/SelectList.tsx`：picker 通用渲染（2.7/5.3/5.4/1.4-Shift+Tab 无关；3.6 /output-style/theme/model 复用，不复制）。
- `src/outputStyles.ts`（新）：样式加载 + 注入纯逻辑，buildSystemPrompt 调用。
- `tui/theme.ts`：六套主题定义 + context，12 消费点只读。
- `src/tools/exitPlanMode.ts`（新）：plan 退出工具（写盘 plans 目录作团队/云底座），权限 plan 门在 permissions.ts。
- `src/workspace.ts`（新）：`isInsideWorkspace` 纯函数 + 围栏判定，permissions.ts 围栏门调用；deny 正交独立。
- `taskList.ts`：依赖图字段 + 校验，taskTools.ts 仅透传。
- 各件接口清晰、可独立测试。
