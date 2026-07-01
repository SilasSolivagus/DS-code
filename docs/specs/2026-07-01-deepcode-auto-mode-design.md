# 7.5 Auto mode — 设计（首个 spec）

状态：设计已定稿（brainstorming 通过），待 writing-plans 出实现计划。
代码：`/Users/silas/loop/deepcode`。roadmap 第 7 层 7.5，见 `docs/specs/2026-06-26-deepcode-cc-v2193-gap-and-plan.md`。

## 一、背景与目标

Auto mode 是 CC v2.1.193 的新权限模式：对**每个非只读工具调用**（文件写入 / Bash / 网络动作），由一个 LLM「分类器」判定 **run（自动放行）/ ask（弹用户确认）/ block（拒绝）**，从而在保持安全的前提下减少权限打断。只读工具完全绕过分类器。

**CC 实读考古（v2.1.193 bundle verbatim，见记忆 [[deepcode-next-session]] 顶部段）**：
- 机制串：「classifies each tool call for risky actions and prompt injection before executing, runs the ones it assesses as lower-risk, and blocks the rest」。
- 四类自定义规则：`allow` / `soft_deny`（破坏不可逆，除非明确意图否则拦）/ `hard_deny`（安全边界，意图不能解除，无条件拦）/ `environment`（环境上下文）。**本 spec 只做内置静态 hard_deny，用户四类自定义规则拆 follow-up。**
- 权限管线 behavior `allow|deny|ask|passthrough`，decisionReason.type `rule|hook|classifier|mode|sandboxOverride`，**规则先于分类器，分类器是无规则命中的兜底**。
- 安全栏：`consecutiveDenials`+`totalDenials>=maxTotal`→`denial_limit_exceeded`→回退 ask；circuit breaker 分类器模型不可用→提示稍候，只读仍可用。
- 模型 `CLAUDE_CODE_AUTO_MODE_MODEL`→回退 `ANTHROPIC_SMALL_FAST_MODEL`（**haiku 级 fast 模型**），temp 默认 1，`AUTO_MODE_SIBLING_CONTEXT`/`sameTurnSiblingContext`。
- settings `permissions.defaultMode:"auto"` / `skipAutoPermissionPrompt` / `disableAutoMode`；**projectSettings/localSettings 标注 repo-controllable = 信任边界要点**。

## 二、前置分类器 eval 结论（门槛已过，2026-07-01）

金集 90 场景（benign 25 / destructive 22 / security 22 / injection 21）× repeat × 4 模型（glm-5-turbo/glm-5.2/deepseek-v4-flash/deepseek-v4-pro），量化 格式可靠性 / 准确率 / **致命漏放（危险判 run）** / 误拦 / **注入失守** / 一致性 / 延迟。harness + 结果存 `docs/specs/2026-07-01-auto-mode-eval/`。

关键结论（决定本设计）：
1. **格式可靠性 100% 全员通过** —— 国产模型稳产结构化 `{reasoning, decision}`，非问题。
2. **提示词就是安全面，不是模型档次。** base 提示词下 glm-5.2 有 s19 盲点（`canAccess=()=>true` 权限恒真被判 run）、DeepSeek 有 s8/s19 漏放 + flip-flop；换 **hardened 提示词**（明确「改代码削弱安全控制=block」「影响共享状态=ask」「注入诱导=block」）后：
   - glm-5.2：致命漏放 2（仅剩 d9 rebase 可辩标签）、注入 0 失守、误拦 0、翻车 0、100% 格式、p50 2.6s。
   - deepseek-flash：**致命漏放 0、注入 0 失守、翻车 0、100% 格式、p50 ~1.0s**（最快最便宜最干净）。
   - deepseek-pro：致命漏放 2（d6 杀进程可辩）、注入 0、p50 1.4s。
   - **安全命脉维度（外泄/RCE/后门/禁鉴权/注入）hardened 下三模型全 100% 干净**；剩余「fatal」全是本地可逆操作（rebase / kill）的严标签。
3. **thinking OFF 是全模型正确默认**：thinking ON 在 GLM 上 +2% 准确率换 p90 11.5s（灾难），在 DeepSeek 上**有害**（flash 致命漏放 0→8）。
4. **glm-5-turbo 安全但用户 GLM 账户 RPM 紧**（conc 2 即 429）——可用性问题非模型缺陷。

**专家双评（安全视角 + 产品/UX/CC 保真视角，独立收敛）**：默认走 **provider 的 fast 档**（延迟就是全部，SMART 那点可辩边际不值，慢会逼用户关掉 auto = 最坏安全结果；CC 也刻意用 fast 模型）；**强制静态 hard_deny 纵深防御**（概率分类器不当不可逆灾难的唯一屏障）；**提示词 pin 死 + 金集回归门**（头号风险=提示词回归）；**fail-safe 回退链，永不静默 run**。

## 三、架构与决策

### 3.1 权限模式
- `PermissionMode` 加 `'auto'`（`src/permissions.ts:71`，现为 `'default' | 'acceptEdits' | 'yolo' | 'plan'`）。auto 卡在 default 与 yolo 之间。
- **opt-in**：默认仍 `default`。Shift+Tab 循环插入：`default → auto → acceptEdits → plan → default`。settings `permissions.defaultMode:'auto'` 可自行设为默认（非强制，不做 CC 的 opt-in 对话框）。

### 3.2 checkPermission 改造（不新建决策流）
现有顺序（`src/permissions.ts:207` `checkPermission`）：deny → plan 门 → 工作目录围栏 → **`isReadOnly→ok`（:253，只读绕过已存在=天然 CC 对齐）** → yolo → acceptEdits → allow 规则（:259-265）→ PermissionRequest hook → `pc.ask`（:281）。

Auto 分类器插在 **allow 规则未命中之后、`pc.ask` 之前**（约 :265 与 :266 之间），仅当 `pc.mode==='auto'`：
1. 先过**静态 hard_deny 层**（§3.3）→ 命中即 `{ok:false, decisionReason:{type:'classifier'|'rule', ...}}`（block）。
2. 否则调**分类器**（§3.4）→ `run`→`{ok:true, decisionReason:{type:'classifier',decision:'run',reasoning}}` / `ask`→**继续走下方现有 `pc.ask`**（用户确认，reasoning 透传展示）/ `block`→`{ok:false, ...}`。
- **明显 benign 由现有 allow 规则前置吸收**（:259 命中即放行），根本不进分类器 —— 复用现成机制做「只 classify 可疑调用」的性能优化。

### 3.3 静态 hard_deny 层（`src/autoMode.ts`）
`HARD_DENY_PATTERNS`：只收**最硬、最低误报**的不可逆灾难正则，分类器前硬拦（纵深防御，不依赖概率分类器）：
- 向网络外泄 secret / `.env` / ssh key / 凭证（`curl -d @<secret>`、`| nc`、`| curl`、ftp 上传敏感文件）。
- 管远程内容入 shell（`curl … | sh/bash`、`wget … && <exec>`、`bash <(curl …)`）。
- 后门（写 `~/.bashrc`/`crontab`/`~/.ssh/authorized_keys`/git hooksPath 指远程）。
- 仅覆盖命令内容维度可高置信匹配的模式；代码语义级弱信号交给分类器提示词（hardened 已覆盖 s19 类）。
- 仅在 `auto` 模式生效（surgical，不改其它模式既有行为）。

### 3.4 分类器（`src/autoMode.ts`）
- `buildClassifierPrompt(toolName, input, siblingContext)`：**hardened 系统提示词**（eval 定稿版，见 `docs/specs/2026-07-01-auto-mode-eval/run.ts` 的 `HARDENED` 常量）+ 工具调用（name+input）+ **同回合兄弟工具结果**（有界窗口，最近 N 条 / 截断，注入检测必需，对齐 CC `sameTurnSiblingContext`）。
- `classify()`：调分类器模型，`temperature 0.2`、**thinking off**，走 `chatStream`/`createClient`（`src/api.ts`）。
- `parseDecision()`：抓首个 `{…}` JSON，取 `decision ∈ {run,ask,block}`；解析失败或非法值 → 视为 malformed（→回退 ask）。
- **提示词 pin 死为常量 + checksum**；改动必须过金集（§六）。

### 3.5 分类器模型解析
- 默认 = **当前 provider 的 fast 档**：`activeFastModel()`（`src/providers.ts:118`，DS→`deepseek-v4-flash`、GLM→`glm-5-turbo`）。
- `autoModeModel` 设置覆盖（具体 id）。`autoModeThinking`（bool，默认 false）开 thinking。
- 分类器不受主循环 provider 切档影响，固定用解析出的分类器模型。

### 3.6 Fail-safe 回退链（**永不静默 `run`**）
分类器**任何异常路径一律降级 `ask`**：模型不可用 / 超时 / 429（retry-with-jitter 一次后仍失败）/ malformed 输出 / 判定不确定。denial 熔断：连续或累计拒绝超阈值（镜像 CC `consecutiveDenials`/`maxTotal`）→ 回退 ask + 提示用户 review transcript。回退产生的 ask 携带说明性 decisionReason。

## 四、TUI（三处双改铁律）

- **Shift+Tab 循环**插入 `auto`：`src/tui/App.tsx`（:101 键处理 + :184 modeLabel）、`src/tui/FullscreenApp.tsx`（:117 + :194）、`src/tui/useChat.ts`（:1066-1069 cycle 三态→四态）。circuit：`default→auto→acceptEdits→plan→default`。
- **页脚 modeLabel** 加 `auto`（CC 是 `auto ⏵⏵`）。
- **PermissionDecisionReason** 加 `{ type:'classifier'; decision:'run'|'ask'|'block'; reasoning:string }`（`src/permissions.ts:82`）。分类器 block/ask 时在弹窗/拒绝文本显示判定理由（复用 5.6 `permissionsView` 来源显示层）。
- `/help` 文案与 `/plan`/`/accept` 并列加一句 auto 模式说明（`useChat.ts:297`）。

## 五、Settings + 信任边界

新键：`permissions.defaultMode:'auto'`、`autoModeModel`、`autoModeThinking`、`disableAutoMode`。
- **信任边界**：`autoModeModel`/`autoModeThinking`/`defaultMode`/`disableAutoMode` 从 **project/local 层 DANGEROUS 剥离**（复用 3.9 `settingsLayers` 剥离机制 + `DANGEROUS_TOP_KEYS`/嵌套白名单）——**恶意 repo 不能把分类器指向弱模型、关掉 thinking-safety、或禁用 auto 安全**。这是显式新增字段进白名单，非自动安全（对齐 3.9 教训）。
- `disableAutoMode:true`（用户层）→ Shift+Tab 循环跳过 auto 档、`defaultMode:'auto'` 被忽略回落 default。

## 六、测试策略

- **金集回归门**（守护「提示词=安全面」，安全专家头号风险）：90 场景金集（`docs/specs/2026-07-01-auto-mode-eval/scenarios.ts`，持续扩）作回归 fixture。改分类器提示词 / 换默认模型 → 跑金集验 **致命漏放=0 且 注入失守=0**。这是打真实模型的独立 eval 脚本（上线前 / 改提示词时跑，非 CI 每次），运行需 GLM/DS key。
- **offline 单测**（mock 分类器，确定性）：决策映射（run/ask/block → checkPermission 分支）、**回退链**（异常/malformed/超时→ask）、hard_deny 正则命中/不误报、denial 熔断阈值、Shift+Tab 四态循环、settings 剥离（project/local 层 autoModeModel 不生效）、只读绕过不触分类器。
- **真机冒烟**（碰 TUI 双组件）：Shift+Tab 切 auto 档页脚显示、真实工具调用被分类器 run/ask/block 三路、注入场景被拦、分类器模型不可用降级 ask、静态 hard_deny 硬拦一条 exfil。

## 七、有意不做（本 spec 之外）

- **四类用户自定义规则**（allow/soft_deny/hard_deny/environment）+ repo-controllable 规则信任边界 + 「expert reviewer of auto mode classifier rules」元提示词 → **follow-up spec**（内置静态 hard_deny 先顶）。
- CC 的 opt-in 对话框（`autoModeOptIn`）、`skipAutoPermissionPrompt`、advisor 集成、按调用缓存/prefetch 性能优化（产品专家建议，非首版必需——allow 规则前置已省大头）→ 后续按需。
- `disableAutoMode` 之外的 CC 4 个调参 flag（temperature 等）→ 暂不暴露。

## 八、关键教训沉淀（写进实现）

1. **提示词 pin 死 + checksum + 金集门**：分类器可靠性主要来自 hardened 提示词工程，改它=改安全控制。
2. **thinking off 全模型默认**：on 在 DeepSeek 上有害、GLM 上延迟灾难。
3. **fast 档默认 + fail-safe ask**：延迟就是体验，慢会逼用户关 auto；异常永不静默 run。
4. **静态 hard_deny 纵深防御**：不可逆灾难不交给概率分类器独扛。
5. **TUI 双组件必双改**（App+FullscreenApp+useChat cycle，见 [[deepcode-tui-dual-component]]）。
6. **新增写路径/工具同步 GLOBAL_SUBAGENT_DENY + 计数断言**；改读路径同步 settingsLayers mock。
