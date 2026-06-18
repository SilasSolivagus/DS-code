# deepcode ↔ Claude Code 全机制对齐 Master Roadmap

**日期：** 2026-06-17
**用途：** CC 源码 `/Users/silas/Desktop/src`（1884 个 TS 文件）穷尽盘点（4 区并行扫描去重）得出的**全集**。用户目标：**对齐 CC 的全部机制，第 1-5 层全做，第 6 层也记录（未来可能做云管平台）**。
**取代：** 旧版 `2026-06-16-cc-mechanisms-roadmap.md`（仅 11 项编排件，已并入本表第 1 层）。
**既定流程：** 对齐 CC（派 agent 实读源码）→ brainstorm/spec → writing-plans → subagent 双审 + 架构件 opus 终审 → 非 TUI 免冒烟/碰 TUI 真机冒烟 → 合 main → bump/tag/push。
**策略（用户 2026-06-17 钦定）：** 非 TUI 件先做；碰 TUI 件全攒最后一批一起真机冒烟。

图例：状态 ✅完成 / 🟡部分 / ⬜无　｜　TUI? 标「碰TUI」者留最后批　｜　工作量 S/M/L

---

## ✅ 已完成（存档，不重复列）

文件工具(Read/Glob/Grep/Edit/Write)、Bash、WebFetch、AskUserQuestion、TodoWrite、Agent(L-040A)、自定义 agent(L-040B `agentsLoader.ts`)、StructuredOutput(L-044，已与 hook 关联)、后台任务 L-041(TaskList/Output/Stop)、Hooks 27 事件 4 类型(L-042 ①a-①d，command/prompt/agent/http)、compact、sessionEnv(DEEPCODE_ENV_FILE)、权限基础模式(default/acceptEdits/yolo + matchRule)、单文件 config、export、session。

---

## 🔄 进度更新（2026-06-18，下表状态列已同步本块）

自本表 2026-06-17 快照以来合并的件（按层）：
- **第 1 层**：✅1.1 MCP(`e93cf54`)、✅1.2 Skills(`0685ecb`+预算/scope`c882d14`)、✅1.8 Task todo-V2(`2558c61`)。
- **第 2 层**：✅2.4 Prompt 缓存(`841b264`)、✅2.6 Cost 告警(`fa2cade`)；🟡2.1 思考预算(只做 effort 档位/ultrathink 关键词,adaptive budget/跨compact结转余)；🟡2.3 自动compact(做了熔断器+预警色,自动触发余)；⏭️2.2 Microcompact 判**不适用 DeepSeek 跳过**。
- **第 3 层**：🟡3.7 权限 deny 规则层 —— **安全加固 B 批(`e5f403d`)做了 deny 规则(BUILTIN_DENY+permissions.deny+isDeniedPath+硬拒/降级ask+Glob/Grep输出过滤)+denial tracking(onDenied)**；还缺**来源层级**(归 3.9)+`/permissions` UI(碰TUI)。
- **第 4 层**：✅4.1 WebSearch(`c58ff77`,双源 Bocha+Tavily)；⏭️4.2 ToolSearch **暂缓存档**(价值正比 MCP 工具数,触发=挂 30+工具 MCP)、4.3 Sleep **跳过**(`Bash(sleep)`已等价)、4.4 Brief **跳过**(CC 双输出面契约,deepcode 单面不映射)。
- **另**：安全加固 B 批还含 #1 复合命令前缀绕过修复(shell-quote 逐段授权,关联权限层)、#2 工具结果注入守则、#4 sanitize C1 缺口+威胁模型文档——非 roadmap 单项,记入 [[deepcode-next-session]]。

---

## 第 1 层 · 核心 agent 编排机制（roadmap 内，最高优先）

| # | 机制 | CC 源码 | deepcode | 状态 | TUI? | 工作量 | 依赖 |
|---|---|---|---|---|---|---|---|
| 1.1 | **MCP 客户端（stdio MVP 已完成）** ✅ | `tools/MCPTool` `services/mcp` | `src/mcp.ts`（stdio + 工具发现注入 + 容错，真机冒烟过；http-sse/认证/资源/agent级 留 spec §5 增量） | ✅ | 否 | L | — |
| 1.2 | **Skills**（SkillTool + 模型自主触发 + frontmatter description/allowed-tools + fork） | `tools/SkillTool` `skills/loadSkillsDir.ts` | ✅ `skillsLoader.ts`+`skill.ts`(`0685ecb`)+预算/scope(`c882d14`) | ✅ | 否 | M | — |
| 1.3 | **Steering/续聊**（SendMessage 工具 + 子循环回合边界消费 pendingMessages） | `tools/SendMessageTool` `tasks/InProcessTeammateTask` | pendingMessages 字段在,工具/消费无 | 🟡 | 部分 | M | L-041✅ |
| 1.4 | **Plan mode**（EnterPlanMode/ExitPlanMode + 只读门 + 审批弹窗） | `tools/EnterPlanModeTool` `tools/ExitPlanModeTool` | 权限三模式有,plan 门无 | 🟡 | 碰TUI | M | — |
| 1.5 | **可写 subagent + git worktree**（EnterWorktree/ExitWorktree + isolation 字段 + 类型级 deny） | `tools/EnterWorktreeTool` `utils/worktree.ts` | 强制全局只读 | ⬜ | 碰TUI | L | L-040✅ |
| 1.6 | **多 agent 工作流**（TeamCreate/TeamDelete + TaskUpdate 依赖图 blocks/blockedBy + 成员寻址） | `tools/TeamCreateTool` `tools/TaskUpdateTool` | 仅 fan-out | ⬜ | 碰TUI | L | 1.3 |
| 1.7 | **Hooks TUI 进度（①e）** | `hooks/` 渲染 | 引擎已全,无进度显示 | 🟡 | 碰TUI | M | L-042✅ |
| 1.8 | **TaskCreate/TaskGet/TaskUpdate 工具暴露** | `tools/Task*Tool` | ✅ `taskList.ts` System A todo-V2 替换 TodoWrite(`2558c61`) | ✅ | 否 | S | L-041✅ |

## 第 2 层 · 运行时/推理层（roadmap 外，对 DeepSeek 有意义）

| # | 机制 | CC 源码 | deepcode | 状态 | TUI? | 工作量 |
|---|---|---|---|---|---|---|
| 2.1 | **思考预算 / ultrathink**（adaptive budget + 关键词触发 + 跨 compact 边界结转；DeepSeek reasoner 模型可对齐） | `utils/thinking.ts` | 🟡 effort 档位/ultrathink 关键词(`fa2cade`),adaptive/跨compact 余 | 🟡 | 否 | M |
| 2.2 | **Microcompact**（逐消息清理旧工具结果占位，省 token） | `services/compact/microCompact.ts` | 无(仅整体 compact) | ⏭️跳过(不适用 DeepSeek) | 否 | M |
| 2.3 | **自动 compact 触发 + 告警 UI**（超 token 阈值自动压 + 提示） | `services/compact/autoCompact` | 🟡 熔断器+预警色(`fa2cade`),自动触发余 | 🟡 | 部分 | M |
| 2.4 | **Prompt caching / cache_control 头** | `utils/cacheBreak.ts` | ✅ cacheSavings 纯函数+状态栏 cache 段(`841b264`) | ✅ | 否 | S |
| 2.5 | **Token 计数/估算**（精确计数 + 多后端） | `services/tokenEstimation.ts` | 无 | ⬜ | 否 | M |
| 2.6 | **Cost 告警 hook**（累计 + 阈值告警；settings 已有 costWarnUSD） | `costHook.ts` `cost-tracker.ts` | ✅ costWarnUSD 阈值告警(`fa2cade`) | ✅ | 部分 | S |
| 2.7 | **/model /effort /fast 模型切换** | `commands/{model,effort,fast}` | 无 | ⬜ | 碰TUI | S |

## 第 3 层 · 记忆/会话/权限/配置（roadmap 外，价值高）

| # | 机制 | CC 源码 | deepcode | 状态 | TUI? | 工作量 |
|---|---|---|---|---|---|---|
| 3.1 | **记忆索引系统**（memdir：type/section/tags 标记 + 扫描 + relevance 查询 + 加载） | `memdir/` | ✅ C2(2026-06-19) | ✅ | 否 | M |
| 3.2 | **自动记忆提取**（会话末提取持久记忆文件） | `services/extractMemories` | ✅ C2(2026-06-19) | ✅ | 否 | L |
| 3.3 | **SessionMemory**（会话记忆 markdown 维护） | `services/SessionMemory` | ✅ C2(2026-06-19) | ✅ | 否 | L |
| 3.4 | **autoDream**（后台记忆合并，时间/会话门槛） | `services/autoDream` | ✅ C2(2026-06-19) | ✅ | 否 | L |
| 3.5 | **Checkpoint/rewind**（回合级文件备份 + content-addressable blob + /rewind 还原） | `utils/fileHistory.ts` `commands/rewind` | checkpoint.ts 存在,完整度待核实 | 🟡 | 部分 | M |
| 3.6 | **会话管理**（/resume /branch /rename /tag /share + history） | `commands/{resume,branch,rename,tag,share}` `history.ts` | 部分(export/session) | 🟡 | 碰TUI | M |
| 3.7 | **权限 deny 规则层 + 来源层级 + denial tracking + /permissions** | `utils/permissions/*` | 🟡 deny 规则+denial tracking(安全批`e5f403d`);缺来源层级(归 3.9)+/permissions UI | 🟡 | 部分 | M |
| 3.8 | **Sandbox 网络隔离 + /sandbox-toggle** | `commands/sandbox-toggle` | 无 | ⬜ | 否 | M |
| 3.9 | **Settings 分层**（user/project/local/enterprise 合并 + 校验）+ /config /env | `utils/settings/*` | 单文件 | 🟡 | 部分 | M |
| 3.10 | **Cron 定时任务**（ScheduleCron 工具 + cronScheduler 后台执行 + 持久化） | `utils/cronScheduler.ts` `tools/ScheduleCronTool` | 无 | ⬜ | 否 | M |

## 第 4 层 · 工具扩展（roadmap 外）

| # | 工具 | CC 源码 | deepcode | 状态 | TUI? | 工作量 |
|---|---|---|---|---|---|---|
| 4.1 | **WebSearch** | `tools/WebSearchTool` | ✅ 双源 Bocha+Tavily(`c58ff77`) | ✅ | 否 | M |
| 4.2 | **ToolSearch** | `tools/ToolSearchTool` | ⏭️暂缓存档(触发=挂 30+工具 MCP) | ⏭️ | 否 | S |
| 4.3 | **Sleep**（可打断等待） | `tools/SleepTool` | ⏭️跳过(`Bash(sleep)`已等价) | ⏭️ | 否 | S |
| 4.4 | **Brief**（工具描述摘要） | `tools/BriefTool` | ⏭️跳过(CC 双输出面契约,单面不映射) | ⏭️ | 否 | S |
| 4.5 | **Config 工具**（读写配置） | `tools/ConfigTool` | 无 | ⬜ | 否 | M |
| 4.6 | **LSP 工具 + 诊断**（代码智能/IDE 诊断） | `tools/LSPTool` `services/lsp` `services/diagnosticTracking` | 无 | ⬜ | 否 | L |
| 4.7 | **REPL 工具**（交互式 Python/Node REPL） | `tools/REPLTool` | 无 | ⬜ | 否 | M |
| 4.8 | **NotebookEdit**（Jupyter 单元格编辑） | `tools/NotebookEditTool` | 无 | ⬜ | 否 | M |
| 4.9 | **PowerShell**（Windows shell） | `tools/PowerShellTool` | 无 | ⬜ | 否 | M |
| 4.10 | **RemoteTrigger**（远程触发工作流） | `tools/RemoteTriggerTool` | ↗️归第6层(云/平台编排,用户2026-06-18 拍板) | ↗️ | 否 | L |
| 4.11 | **多模态附件输入**（图片/PDF/Jupyter paste + MIME 检测，嵌消息体） | `utils/attachments.ts` | 无(纯文本) | ⬜ | 碰TUI | L |

## 第 5 层 · 体验层（几乎全碰 TUI，留最后批一起真机冒烟）

| # | 机制 | CC 源码 | deepcode | 状态 | TUI? | 工作量 |
|---|---|---|---|---|---|---|
| 5.1 | **Keybindings 系统**（`~/.deepcode/keybindings.json` + chord + 冲突检测） | `keybindings/` | 无 | ⬜ | 碰TUI | M |
| 5.2 | **Vim 模式**（motions/operators/textObjects 状态机） | `vim/` | 无 | ⬜ | 碰TUI | L |
| 5.3 | **Output styles**（自定义输出样式 markdown + 注入 + 降级） | `outputStyles/` `constants/outputStyles.ts` | 无 | ⬜ | 碰TUI | M |
| 5.4 | **/theme /color 主题切换** | `commands/{theme,color}` | 无 | ⬜ | 碰TUI | S |
| 5.5 | **语音模式**（音频录制 + STT 流 + keyterms） | `voice/` `services/voice*.ts` | 无 | ⬜ | 碰TUI | L |
| 5.6 | **权限弹窗 UI**（always/yes/no 决策 + 规则记忆） | `components/PermissionPrompt.tsx` | 权限逻辑全,无 UI | 🟡 | 碰TUI | M |
| 5.7 | **Statusline**（成本/token/模型/模式/任务进度实时栏 + /statusline） | `commands/statusline.tsx` | 极简状态行 | 🟡 | 碰TUI | M |
| 5.8 | **AI 辅助摘要**（AgentSummary 子代理进度 / toolUseSummary / awaySummary / PromptSuggestion 下一步建议） | `services/{AgentSummary,toolUseSummary,awaySummary,PromptSuggestion}` | 无 | ⬜ | 碰TUI | M |
| 5.9 | **交互小命令**（/copy /good-claude /context viz /files /add-dir /status /help 增强） | `commands/*` | 部分 | 🟡 | 碰TUI | S |

## 第 6 层 · Anthropic 云/平台专属（记录在案；做 = 改造成 DeepSeek/自建后端的「云管平台」版）

> ⚠️ 这些原样连的是 Anthropic 后端，**无法"对齐 CC"原物**。未来若做云管平台，须替换为 DeepSeek/自建后端 + 自建商业逻辑。逐项记录以备将来。

| # | 机制 | CC 源码 | 云管平台改造方向 | 工作量 |
|---|---|---|---|---|
| 6.1 | **OAuth 登录/账户**（/login /logout /oauth-refresh + PKCE） | `services/oauth` `commands/login` | 接自建账户体系 | L |
| 6.2 | **用量/限额**（claudeAiLimits/policyLimits/usage/extra-usage/rate-limit） | `services/{claudeAiLimits,policyLimits}` | 接自建计量/配额 | L |
| 6.3 | **遥测/可观测**（OTel + BigQuery + Perfetto + analytics/Datadog + diagnosticTracking） | `utils/telemetry/` `services/analytics` | 接自建数据管道 | L |
| 6.4 | **Plugins 市场**（发现/加载/版本/依赖 + marketplace + /plugin /reload-plugins） | `plugins/` `services/plugins` | 自建插件市场 | L |
| 6.5 | **IDE 集成**（/ide + bridge/ + DesignSync + diff 面板） | `bridge/` `commands/{ide,diff}` | VS Code/JetBrains 桥 | L |
| 6.6 | **GitHub 集成**（/issue /pr_comments /review /commit /commit-push-pr /install-github-app /autofix-pr） | `commands/*` | 接 GitHub API | L |
| 6.7 | **Slack 集成**（/install-slack-app） | `commands/install-slack-app` | 接 Slack API | M |
| 6.8 | **远程/云会话**（/teleport /desktop /mobile /bridge /session QR + upstreamproxy + remote/ + server/ + coordinator 多窗口协调） | `remote/` `server/` `coordinator/` `upstreamproxy/` | 自建会话云 + relay | L |
| 6.9 | **企业设置同步**（remoteManagedSettings + settingsSync + teamMemorySync） | `services/{remoteManagedSettings,settingsSync,teamMemorySync}` | 自建企业控制台 | L |
| 6.10 | **商业运营件**（/upgrade /stickers /passes /privacy-settings /feedback /release-notes /referral /overageCreditGrant） | `commands/*` `services/api/*` | 自建商业系统 | M |
| 6.11 | **诊断/调试运维**（/doctor + internalLogging + vcr 录放 + heapdump + diagLogs/crash dump） | `commands/doctor` `services/vcr.ts` | 本地版可独立做（部分非云） | M |
| 6.12 | **MagicDocs**（标记 markdown 自动更新） | `services/MagicDocs` | 本地可做 | M |
| 6.13 | **项目引导**（/init /onboarding + init-verifiers + advisor + bughunter + security-review + ultraplan） | `commands/*` | 本地可做（部分非云） | M |
| 6.14 | **notifier/通知**（渠道路由 + PushNotification）+ **preventSleep**（caffeinate） | `services/notifier` `preventSleep.ts` | 本地可做 | S |
| 6.15 | **API 基础设施层**（bootstrap 配置拉取 / withRetry / errorUtils / filesApi / grove 向量检索） | `services/api/*` | 接 DeepSeek API 对应件 | M |

> 注：6.11/6.12/6.13/6.14 里有一部分其实**纯本地、非云**（doctor/MagicDocs/notifier/preventSleep/init/bughunter），将来若不做云管平台也可单独拎到第 2-5 层做。

---

## 执行序（2026-06-18 重订：opus 专家建议 + 用户拍板取代旧逐层提案）

**排序原则（用户钦定，取代旧"非TUI先/逐层"）：依赖拓扑 → 可感知收益 → 主题聚类（共享子系统连做，省重复实读 CC）→ 小件穿插。** 理由：六层是机制分类轴非执行轴；单人+AI 一件一仪式流程下最贵的是上下文切换+重复实读同一 CC 子系统，主题聚类消灭浪费。**逐层独立做完已被否决。**

**主题聚类批次（剩余非 TUI，按此序）：**
- **C1 · 配置与权限层** ← 下一批起跑：**3.9 Settings 分层（捆绑 hook SSRF/URL 白名单加固）** → 3.7 余「来源层级」 → 4.5 Config 工具。
  - *3.9 是隐藏拓扑根*：解锁 3.7 来源层级 + 是所有未来「项目级配置」的安全前置（威胁模型已点名：共享 settings 启用前必须先补 hook SSRF，否则项目级文件=供应链 RCE）+ 越晚做读 config 件返工面越大。
- **C2 · 记忆子系统**（最该打包）：3.1 记忆索引（先定 schema）→ 3.3 SessionMemory → 3.2 自动提取 → 3.4 autoDream。四件共享 memdir，一次实读 CC memory 子系统连做，别拆开穿插。
- **C3 · Token/Compact 收尾**：2.5 Token 计数 → 2.1 余 adaptive budget → 2.3 余自动触发。
- **C4 · 独立工具件**（互相独立，可并行 worktree 丢 agent，降仪式）：4.6 LSP、4.7 REPL、4.8 Notebook、4.9 PowerShell、3.10 Cron、3.8 Sandbox。
- **C5 · Steering→多agent**：1.3 Steering 非 TUI 逻辑（为 B 批 1.6 铺路）。

**推荐下一步 6-8 件**：①3.9 Settings+SSRF ②3.7 来源层级 ③4.5 Config ④3.1 记忆索引 ⑤3.3 SessionMemory ⑥3.2 自动提取 ⑦3.4 autoDream ⑧2.5 Token 计数。（④-⑦ 是整个 memory 批，不拆。）

**TUI 批 · 两件提前破例（用户拍板，其余仍攒最后一起冒烟）：**
- 🔓 **3.5 Rewind UI 提前**（安全网，让后面可写 subagent 1.5/autoDream 敢做）。
- 🔓 **5.6 权限弹窗 UI 提前**（点亮已做的重权限逻辑 deny/来源层级，否则用户感知不到）。
- 攒最后批（不破例）：1.4 Plan mode、1.5 可写 subagent+worktree、1.6 多 agent（依赖 1.3）、1.7 hooks TUI(①e)、2.7 模型切换（轻量，DeepSeek 档位少）、3.6 会话管理、4.11 多模态、第 5 层其余(5.1-5.5/5.7-5.9)。

**裁决（用户拍板）：4.10 RemoteTrigger → 归第 6 层**（远程触发工作流本质偏云/平台编排，与 6.8 远程会话同类）。专家另建议砍 4.9 PowerShell、降 3.10 Cron/3.8 Sandbox、4.6 LSP 单独评估——**用户选择保留**（暂不砍，做到时再按 ROI 复评）。

**仪式分层提醒（专家盲点）：剩余件分「能力件」（记忆批/Steering/可写subagent/rewind，用全仪式 opus 终审）vs「对齐件」（Notebook/PowerShell/Config 等表面对齐，可降仪式、并行 worktree）——别对 4.8 Notebook 和 3.1 记忆索引用一样重的流程。**

**第 6 层**：单独立项「云管平台」，本表记录在案，待用户启动。新增 4.10 RemoteTrigger 归入。
