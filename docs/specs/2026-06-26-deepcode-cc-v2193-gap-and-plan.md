# CC v2.1.76 → v2.1.193 完整 gap 清单 + 专家优先级实施计划

**日期**：2026-06-26
**方法**：本地装的 CC 与 master roadmap 基准均为 **v2.1.76**；npm 最新 **v2.1.193**（差 117 版）。拉最新原生二进制（`@anthropic-ai/claude-code-darwin-arm64@2.1.193`，222M，`grep -a` 可搜，存 scratchpad/cc-latest），派 4 个 agent 多轮对比新旧 bundle（命令/工具/服务/模式/settings/env/UI/提示词/hook/feature-flag），全确证级带原文证据。`tengu_` feature flag 净增 **735 个**、env flag **158→358**、settings 新增 **~45 键**、hook 事件 **22→30**、system-reminder 串 **19→91**。
**用途**：回答「CC 还有什么没做」+ 给出可执行的分批实施序。配合 master roadmap「第 7 层」段。

---

## 一、deepcode 已有 / 部分（核对，**不重做**）

- **权限模式**：default / acceptEdits / yolo(=bypassPermissions) / plan ✅；**auto 档无**（见下 T1）。
- **hook 事件**：deepcode 已有 CwdChanged / TaskCreated / WorktreeCreate / WorktreeRemove（1.5/①b 批做的）；CC 新增 8 个里这几个 deepcode 已有，**剩 MessageDisplay / PostToolBatch / UserPromptExpansion / StopFailure / PermissionDenied 未做**。
- **记忆**：autoDream（C2 已做，CC 同名 `auto_dream`）✅；**team memory multistore / memdir prefetch / slim subagent CLAUDE.md 未做**。
- **全屏**：FullscreenApp 双组件已做 ✅，但**无 `/tui` 切换命令、无 focus 视图、未作为正式 viewMode**。
- **compact**：2.3 自动 compact 主体 ✅；**precomputed/reactive/circuit-breaker/time-based microcompact 增量未做**。
- **subagent+worktree**：1.5 已做 ✅ = **Workflow（T1）与 Kairos（T2）的现成底座**。
- **steering**：1.3 已做 ✅（CC 此 diff 内非新增）。

---

## 二、完整新增清单（按「能不能本地做 + 价值」分层）

### 🌟 T1 · 本地高价值大件（CC 这两版的灵魂，roadmap 零覆盖）

| # | 机制 | 是什么 | 量 | deepcode 落点/依赖 |
|---|------|--------|----|------|
| **7.1 Workflow** | 确定性 JS DSL 编排多 subagent（`agent()/parallel()/pipeline()/phase()/budget`），沙箱 VM 禁 Date.now/random 保 resume，`resumeFromRunId` 增量重跑，`/workflows` 浏览，`ultracode` 触发 | 工具+DSL+VM+UI | L-XL | 1.5 worktree+subagent 底座；需沙箱 VM + 调度器 |
| **7.5 Auto mode** ⭐ | 新 permissionMode 枚举 `auto`：**模型分类器逐 tool call 查风险+prompt injection**，低风险放行/其余拦/无法评估拦；Shift+Tab 新档 `auto mode on ⏵⏵`；**CC 已设为默认**；自定义规则四类 allow/soft_deny/hard_deny/environment | 分类器+权限轴+TUI | L | permissions.ts 加 auto 档；分类器用 fast 模型(DeepSeek/GLM)；`disableAutoMode` 键 |
| **7.2 Kairos 自主循环** | `ScheduleWakeup`（自定步唤醒 /loop dynamic，delaySeconds [60,3600]，durable→`.deepcode/scheduled_tasks.json`）+ `Monitor`（后台监控脚本 stdout→`<task-notification>` 事件）+ autonomous-loop 哨兵（首次全文/后续短提醒）+ `doneMeansMerged`(干到 PR ready) | 工具×2+调度+注入 | L | loop.ts + 后台任务底座(已有 BgTask) |
| **7.3 后台会话生命周期** | `/background`(会话转后台释放终端)+`/stop`+`/daemon`(常驻 daemon/worker 池/adopt/respawn/PTY host)+`/loops`；`tengu_bg_*`~80+`daemon_*`~20=新版最大隐形子系统 | 命令×4+daemon 子系统 | XL | 重型；可只做 /background+/stop 薄片，daemon 全套归后置 |
| **7.4 FleetView** | 多 agent 队列 UI（`FleetViewScreen`/`mountFleetView`）+`fleet_view_dispatch` 调度器（group/PR-batch）+ coordinator mode | TUI 屏+调度 | L | 依赖 7.1/7.3 |

### 🖥️ T2 · 本地中价值（视图/交互模式 + compact + hook 增量）

| 机制 | 是什么 | 量 |
|------|--------|----|
| **Fullscreen 正式模式 + /tui** | `tui:"fullscreen"` alt-screen 无闪烁渲染器作为正式 viewMode + `/tui` 切换 + upsell 遥测 | M（deepcode 已有 FullscreenApp，formalize） |
| **Focus 视图 + /focus** | `viewMode:"focus"`：只显示 prompt+summary+response | S-M |
| **Compact 演进** | precomputed compact(后台预算摘要预计算)+reactive compact(按需,复用 precomputed)+熔断器(连续失败/快速回填跳闸)+time-based keep-recent microcompact | M-L |
| **5 个新 hook 事件** | MessageDisplay/PostToolBatch/UserPromptExpansion/StopFailure/PermissionDenied | M |
| **Agent/Prompt hook 类型** | hook 新增 `type:"agent"`(带工具跑 agent)/`type:"prompt"`(LLM 评估条件) | M |
| **Advisor** | `/advisor`+`advisorModel`+`--advisor`：关键时刻咨询更强模型 | M（映射 smart 模型） |
| **/goal + /recap** | /goal 设停止前自检目标(`<goal>`注入)；/recap 离开返回 40 词内摘要 | S |
| **Context-tip 分类器** | transcript 内主动 nudge（如 correction-spiral 来回拉锯→建议 /clear） | M |
| **Brief mode（=4.4 坐实）** | 输出通道模式：`SendUserMessage`/Brief 工具 + stop hook 强制 + `/brief` 切换。CC 双输出面 | M（deepcode 单面，需建第二面，重评） |

### 🧩 T3 · 本地小命令/低成本

`/cd`(切目录)·`/recap`·`/focus`·`/tui`·`/scroll-speed`·`/pause-memory`·`/reload-skills`(热加载 skills)·`/powerup`(功能教学)·`/wellbeing`(休息提醒)·`/update`+`/version`·`SendUserFile`(文件作交付物)·`showMessageTimestamps`·`/radio`(彩蛋)。多数 S。

### 🔧 T4 · 增量加固（本地，质量件）

refusal fallback 子系统(拒答回退/撤回)·malformed-tool-use 自愈重试·structured-output retraction·thinking-signature strip retry·cache eviction hint(会话末发缓存驱逐)·elevated auth(敏感会话二次鉴权)·verified-vs-assumed 报告纪律注入·session_metadata 注入·cross-session-message(`<cross-session-message>` peer 消息隔离)。

### ☁️ T5 · 云/managed/N/A（归第 6 层，需自建后端或不适用）

Artifact(发 claude.ai 网页)·Projects(云 RAG)·/teleport·/web-setup·ultraplan/ultrareview(云 fleet)·RemoteTrigger·DesignSync/design-login·Cowork 引导(RolePicker/ShareGuide/team-onboarding)·CCR(会话云回放)·fallback credits/usage-credits/pro-trial/extra-usage(计费)·managed 企业设置(requiredMin/MaxVersion/strictPluginOnly/disableRemoteControl…)·setup-bedrock/vertex/mantle(N/A 第三方)·voice(STT 云,用户已定走国产)·Chrome 桥。

---

## 三、专家优先级实施序（推荐）

**判据**：依赖拓扑 → 本地可行 → 用户价值 → 主题聚类。云/managed 全押后第 6 层。

### 阶段 A（先清在途小队列，已 plan-ready，快赢收尾）
栅格化 → Sleep+tips → paste-fold（含图片）。**理由**：已全 plan-ready，沉没成本低，且都碰 TUI，连续做一次性冒烟收掉，不打断后面大件。Sleep(4.3) 顺带把 SKIP 件清了。

### 阶段 B（T1 灵魂大件，按依赖排）
1. **7.5 Auto mode**（独立、价值最高、模式层最实质变化、CC 已设默认）——先做，因它不依赖别的，且立刻提升日常体验。分类器走 DeepSeek fast 模型。
2. **7.1 Workflow**（最大空白，1.5 worktree 底座现成）——deepcode 自己就能跑多 agent 工作流。
3. **7.2 Kairos**（ScheduleWakeup+Monitor，依赖后台任务底座，已有 BgTask）——自主长跑。
4. **7.3 后台会话薄片**（/background+/stop，daemon 全套押后）。
5. **7.4 FleetView**（依赖 7.1/7.3）。

### 阶段 C（T2 模式/compact/hook 增量，主题聚类）
Fullscreen 正式化+/tui+/focus 视图（一批，碰 TUI）→ compact 演进（precomputed/reactive/熔断器）→ 5 新 hook 事件+Agent/Prompt hook 类型（一批）→ Advisor+/goal+/recap+context-tip → Brief mode（重评是否值得建第二输出面）。

### 阶段 D（T3 小命令一批冒烟 + T4 加固件）
T3 小命令凑一批；T4 加固按 ROI 穿插。

### 第 6 层（T5）
单独立项，进入前与用户确认是否启动自建云/managed。voice 走国产 STT（用户已定）。

---

## 四、待用户拍板

1. **阶段 A 要不要先清**（在途 3 件 plan-ready）还是**直接跳到阶段 B 大件**（Workflow/Auto mode 插队）。
2. **阶段 B 起点**：推荐 **Auto mode**（独立、默认级体验提升）或 **Workflow**（最大空白、最像 CC 灵魂）——你点。
3. 第 6 层云/managed：暂记录，待启动自建云阶段再说。
4. 流程：每件仍走 brainstorm→spec→writing-plans→SDD（subagent 双审+opus 全分支终审）→真机冒烟（碰 TUI 双组件）。大件（Workflow/Auto mode/Kairos）建议各自独立 spec。

---

## 五、证据存档
- 新旧 bundle：旧 `/opt/homebrew/lib/node_modules/@anthropic-ai/.claude-code-2DTsDk1V/cli.js`(v2.1.76) / 新 scratchpad/cc-latest/package/claude(v2.1.193)。
- agent 原始报告含 verbatim 证据：命令&工具 diff、服务&机制 diff、模式&settings&env diff、UI&提示词&hook&flag diff。
- feature flag 全列表 scratchpad/new_tengu.txt（735 净增）。
