# deepcode ↔ Claude Code 全机制对齐 Master Roadmap

**日期：** 2026-06-17
**用途：** CC 源码 `/Users/silas/Desktop/src`（1884 个 TS 文件）穷尽盘点（4 区并行扫描去重）得出的**全集**。用户目标：**对齐 CC 的全部机制，第 1-5 层全做，第 6 层也记录（未来可能做云管平台）**。
**取代：** 旧版 `2026-06-16-cc-mechanisms-roadmap.md`（仅 11 项编排件，已并入本表第 1 层）。
**既定流程：** 对齐 CC（派 agent 实读源码）→ brainstorm/spec → writing-plans → subagent 双审 + 架构件 opus 终审 → 非 TUI 免冒烟/碰 TUI 真机冒烟 → 合 main → bump/tag/push。
**策略（用户 2026-06-17 钦定）：** 非 TUI 件先做；碰 TUI 件全攒最后一批一起真机冒烟。

图例：状态 ✅完成 / 🟡部分 / ⬜无　｜　TUI? 标「碰TUI」者留最后批　｜　工作量 S/M/L
**⚠️ 状态列语义：✅/🟡/⬜ 描述的是 **deepcode 的对齐进度**，不是 CC 是否存在该机制。`⬜无` = deepcode 还没建（CC 一定有，否则不会上表）。复审时勿误读为"CC 没有"。**

---

## ✅ 已完成（存档，不重复列）

文件工具(Read/Glob/Grep/Edit/Write)、Bash、WebFetch、AskUserQuestion、TodoWrite、Agent(L-040A)、自定义 agent(L-040B `agentsLoader.ts`)、StructuredOutput(L-044，已与 hook 关联)、后台任务 L-041(TaskList/Output/Stop)、Hooks 27 事件 4 类型(L-042 ①a-①d，command/prompt/agent/http)、compact、sessionEnv(DEEPCODE_ENV_FILE)、权限基础模式(default/acceptEdits/yolo + matchRule)、单文件 config、export、session。

---

## 🔄 进度更新（2026-06-22 最新，下表状态列已同步本块）

**2026-06-22**：✅2.5 Token 计数已 push（`7dc78ea`，main=origin=`c8de188` 全同步）+ 状态栏 Row 2 加 contextBar 迷你进度条（`c8de188`）。✅C1（3.9+4.5）+ C2 记忆四件均已整批完成。**⭐新增 2.8 通用多 provider / GLM（用户钦定通用 preset，但拍板⏳后置——先把 CC 第 1-5 层对齐做完整再做）**——见第 2 层 2.8 详述。**剩余非 TUI 下一步（先做完 CC 对齐）= 2.1 余 / 2.3 余 / C4 工具批 / C5 Steering；CC 全做完后才做 2.8。**

**⭐2026-06-22 派 4 agent 实读 CC+摸现状调研，roadmap 大修正（又一次「别照标题盲做」）：** ①**2.3 自动 compact = 已端到端做完**（2.5 顺手做，标 ✅，唯一可选=413 兜底）。②**3.5 Rewind = 主干已完成**（存储+还原+/rewind+两级选择器+三模式，标 🟢主干，真实剩余=1M Summarize+4S，其中 #4 防覆盖手改=数据安全建议补）。③**5.6 权限弹窗 = 主体已做**（三态+always 写规则+危险警告+diff 全有，标 🟢主体，真实剩余=1M deny/来源展示+3S 文案）。④**2.1 = adaptive thinking 对 DeepSeek N/A，真实剩余只剩 CC token budget 自动续跑(`+500k`/跨turn结转/收益递减熔断)，S-M 纯逻辑**。**净结论：当初选的 3.5/5.6 主干已完成；真正值得做的高价值低风险件=【2.1 token budget(新功能,S-M,非TUI)】+【5.6 deny/来源展示(M,TUI)】+【3.5 #4 防覆盖手改(S,非TUI,数据安全)】。**

**🚀执行进度（2026-06-22）：✅3.5 #4 restore-only-if-differs(`19762b3`)✅2.1 Token budget 自动续跑(`a104f45`,opus 终审+真机签收)✅5.6 deny/来源层级展示(merge `31e5deb`,8 任务 TDD+opus 全分支终审 READY+TUI 真机冒烟过,已 push)✅C4 Notebook(merge `54a8ff9`,6 任务 TDD+opus 全分支终审 READY,1037 测试,纯逻辑免冒烟)✅✅C5 1.3 Steering(merge `32612a1`,1060 测试,opus 全分支终审 READY+真机冒烟 PASS,已 push)。🚀已 push，main=origin=`32612a1` 全同步。**

**⭐⭐拐点（2026-06-22，C5 Steering 收官后）：CC 第 1-5 层「非 TUI 件」全部做完或已裁决（跳过/推迟）。** 非 TUI 对齐件清单：第1层 1.1/1.2/1.3/1.8 ✅；第2层 2.1/2.3/2.4/2.5/2.6 ✅（2.2 跳过）；第3层 3.1-3.4/3.5主干/3.7deny/3.9 ✅（3.8/3.10 推迟）；第4层 4.1/4.5/4.8 ✅（4.2/4.3/4.4 跳过，4.6/4.7/4.9 推迟/跳过，4.10→第6层）；第5层 5.6 ✅。**前置满足：⏳2.8 多 provider（当初钦定"等第1-5层做完才做"）现已解锁。** 下一会话三候选：①**2.8 通用多 provider/GLM**（底层抽象非 TUI 可全做）②**TUI 攒最后批**（1.4/1.5/1.6[依赖刚做完的1.3]/1.7/2.7/3.6/4.11/第5层）③回捡 C4 推迟件(LSP/Cron/Sandbox)或第6层云平台单独立项。**开新会话与用户确认挑哪个。**

**✅✅C5 1.3 Steering 详情（merge `32612a1`，2026-06-22）：** 采纳 **CC 真实模型**（两次实读 pivot：①Alt+Enter=`\x1b\r` 经实读 ink `parse-keypress.js` 是死键 ②实读 CC 触发机制发现 CC 无 now 热键、Enter 恒入队 next、有 in-flight tool 时 Enter 同时 abort('interrupt')）。**实现**：新模块 `src/steering.ts`（SteeringQueue FIFO + formatSteeringMessage `<queued-user-message>`）；busy Enter→入队 next + toolInFlight 时软中断（abort 'interrupt'）；loop 按原生 `signal.reason` 二分 interrupt 续跑/user-cancel 硬中断 + `ctx.resetSignal` 重建信号 + mid-stream partial 保留；**三点 drain**（tool 边界/no-tool turn-end/中断点，drainAll 互斥不重复不丢，no-tool turn-end 那点是冒烟前置核对挖出的真缺口）；ESC 双语义（队列非空→拉回编辑/空→硬中断）；列队展示。spec/plan `docs/{specs,plans}/2026-06-22-deepcode-1.3-steering*`（spec §1 有设计修订段记录 pivot）。SDD 全仪式 6 任务+CC 模型 rework+gap fix，Task3 架构件+全分支 opus 终审 READY，**真机冒烟 PASS**（sleep20 软中断被杀退出码1+转向/纯文本无-tool 续跑答补充/ESC 拉回+列队展示三路验证）。**教训**：①TUI 触发键先实读 ink `parse-keypress.js` 验可达性 ②交互模型先实读 CC 真实做法别照直觉/roadmap ③冒烟前置核对能挖出设计缺口。**follow-up 非阻塞**：toolsRunning hook 异常 mid-RO-batch 理论泄漏（崩溃级前置，留 hardening）；Point A mid-stream 中断分支经 Enter 不可达=将来 SDK now 预留。

**🔍 完整性重审（2026-06-22，C5 收官后用户发起，派 4 agent 分区重扫 CC 源码 commands/tools/services/顶层 双向 diff）：结论=roadmap ~96-97% 完整，无重大机制缺失（Plan mode=1.4 在、thinking/MCP/hooks/记忆/compact/steering/权限/会话全在）。** 原始 4-agent 初扫经得起复核。**修正落地**：①4.5 Config 表格行陈旧（标 ⬜ 实已 `87a1dab` 完成）→ 已改 ✅。②补图例：状态列 ⬜=deepcode 未建，非 CC 无（复审者易误读，本次 4 agent 里 2 个踩了）。③真遗漏小件补表：3.9b Settings/模型版本迁移(`migrations/` 11 脚本,S,低优先)、5.10 spinner tips 轮播(`services/tips/`,S)、5.11 吉祥物伴侣 gamified(`buddy/`,可选趣味,最低优先)、5.9 补 /btw 旁问不打断+/clear+/summary+/ctx_viz。④6.2 /rate-limit 已改名 /rate-limit-options + rateLimitMessages 文案中心。**确认非遗漏（agent 误报已澄清）**：MCP auth/资源(McpAuth/List/ReadMcpResource)=1.1 已记"留 spec §5 增量"；Config/LSP/PowerShell/Cron 的 ⬜=deepcode 状态非 CC 缺失；TaskOutput/Team/StructuredOutput 已覆盖(L-041/1.6/L-044)。**基础设施层**（bootstrap/cli 主循环/query 编排）=CC 与 deepcode 各有等价实现（deepcode loop.ts/state），非待对齐 CC 专属机制，不单列。internalLogging=Anthropic 专属，超范围。

**⭐C4 工具批 ROI 复评（2026-06-22，6 agent 实读 CC+摸现状，用户拍板「只做 Notebook 其余归档」）：6 件坍缩成 1 件。**①**✅已完成 = Notebook（NotebookRead+NotebookEdit，编辑版不执行）merge `54a8ff9`**：`src/notebook.ts`(parse/serialize indent1/generateCellId/resolveCellIndex/applyCellEdit replace·insert·delete 无 kernel/formatNotebookForRead cell 视图+图像文本占位+大输出 jq 截断)+Read 检测 .ipynb→cell 视图(解析失败回退纯文本)+NotebookEdit 工具(复用 read-before-edit 闸门)+Edit 拒绝 .ipynb 重定向+注册 allTools+**NotebookEdit 加 GLOBAL_SUBAGENT_DENY(集成期发现写工具泄漏子代理缺口,已修)**。6 任务 TDD+opus 全分支终审 READY(4 命名风险全 PASS:安全边界三装配路径无法绕过/path-key 一致/round-trip 完整/优雅降级),1037 测试,零依赖纯逻辑免冒烟。**教训:新增写工具务必同步 GLOBAL_SUBAGENT_DENY+既有工具计数/列表断言测试(tools.registry/agent.test)。**②**⏭️推迟 LSP**：全套 LSP infra(server manager+vscode-jsonrpc+诊断聚合 7 文件,~1500-2000 行+3 依赖+**常驻进程**)，CLI↔daemon **架构冲突**(CC 靠 IDE daemon，deepcode 一次性会话)。③**⏭️推迟 Cron**：本地 tick loop 靠 REPL 保活；deepcode 会话型 CLI 退出即死、**无会话外触发**(需守护进程/systemd)，架构冲突，归预留。④**⏭️推迟 Sandbox**：@anthropic-ai/sandbox-runtime(mac Sandbox.framework/Linux bwrap+socat)；deepcode 已有 deny+权限+sanitize 三层防御，OS 级边际收益低+平台依赖重。⑤**🚫跳过 PowerShell**：CC 独立工具但**仅 Windows 门控**，darwin/linux/WSL 用户零价值。⑥**🚫跳过代码 REPL/PTY**：CC 的"REPL"其实是工具隐藏层+WebSocket bridge **非代码解释器**，CC 自己都不做 PTY；真 PTY 需 node-pty 原生编译，市场信号=一次性执行已够。**净结论：C4 实质=Notebook 一件，做完 C4 收尾→C5 1.3 Steering。** main=origin=`e203ff9` 全同步。**

---

## 🔄 进度更新（2026-06-18，历史快照）

自本表 2026-06-17 快照以来合并的件（按层）：
- **第 1 层**：✅1.1 MCP(`e93cf54`)、✅1.2 Skills(`0685ecb`+预算/scope`c882d14`)、✅1.8 Task todo-V2(`2558c61`)。
- **第 2 层**：✅2.4 Prompt 缓存(`841b264`)、✅2.5 Token 计数(`7dc78ea`,CJK 感知估算+模型感知 window+发送前预估,CC countTokens API/多后端 N/A)、✅2.6 Cost 告警(`fa2cade`)；🟡2.1 思考预算(只做 effort 档位/ultrathink 关键词,adaptive budget/跨compact结转余)；🟡2.3 自动compact(做了熔断器+预警色,自动触发余)；⏭️2.2 Microcompact 判**不适用 DeepSeek 跳过**。
- **第 3 层**：🟡3.7 权限 deny 规则层 —— **安全加固 B 批(`e5f403d`)做了 deny 规则(BUILTIN_DENY+permissions.deny+isDeniedPath+硬拒/降级ask+Glob/Grep输出过滤)+denial tracking(onDenied)**；还缺**来源层级**(归 3.9)+`/permissions` UI(碰TUI)。
- **第 4 层**：✅4.1 WebSearch(`c58ff77`,双源 Bocha+Tavily)；⏭️4.2 ToolSearch **暂缓存档**(价值正比 MCP 工具数,触发=挂 30+工具 MCP)、4.3 Sleep **跳过**(`Bash(sleep)`已等价)、4.4 Brief **跳过**(CC 双输出面契约,deepcode 单面不映射)。
- **另**：安全加固 B 批还含 #1 复合命令前缀绕过修复(shell-quote 逐段授权,关联权限层)、#2 工具结果注入守则、#4 sanitize C1 缺口+威胁模型文档——非 roadmap 单项,记入 [[deepcode-next-session]]。

---

## 第 1 层 · 核心 agent 编排机制（roadmap 内，最高优先）

| # | 机制 | CC 源码 | deepcode | 状态 | TUI? | 工作量 | 依赖 |
|---|---|---|---|---|---|---|---|
| 1.1 | **MCP 客户端（stdio MVP 已完成）** ✅ | `tools/MCPTool` `services/mcp` | `src/mcp.ts`（stdio + 工具发现注入 + 容错，真机冒烟过；http-sse/认证/资源/agent级 留 spec §5 增量） | ✅ | 否 | L | — |
| 1.2 | **Skills**（SkillTool + 模型自主触发 + frontmatter description/allowed-tools + fork） | `tools/SkillTool` `skills/loadSkillsDir.ts` | ✅ `skillsLoader.ts`+`skill.ts`(`0685ecb`)+预算/scope(`c882d14`) | ✅ | 否 | M | — |
| 1.3 | **Steering/用户中途转向** ✅ | `tools/SendMessageTool` `messageQueueManager` | ✅ `src/steering.ts`(SteeringQueue)+CC 真实模型(Enter 入队 next + toolInFlight 软中断,无 now 键)+loop signal.reason 二分续跑/硬中断+resetSignal+三点 drain+ESC 双语义+列队展示(merge `32612a1`,opus 终审+真机冒烟 PASS) | ✅ | 部分 | M | L-041✅ |
| 1.4 | **Plan mode**（EnterPlanMode/ExitPlanMode + 只读门 + 审批弹窗） | `tools/EnterPlanModeTool` `tools/ExitPlanModeTool` | 权限三模式有,plan 门无 | 🟡 | 碰TUI | M | — |
| 1.5 | **可写 subagent + git worktree**（EnterWorktree/ExitWorktree + isolation 字段 + 类型级 deny） | `tools/EnterWorktreeTool` `utils/worktree.ts` | 强制全局只读 | ⬜ | 碰TUI | L | L-040✅ |
| 1.6 | **多 agent 工作流**（TeamCreate/TeamDelete + TaskUpdate 依赖图 blocks/blockedBy + 成员寻址） | `tools/TeamCreateTool` `tools/TaskUpdateTool` | 仅 fan-out | ⬜ | 碰TUI | L | 1.3 |
| 1.7 | **Hooks TUI 进度（①e）** | `hooks/` 渲染 | 引擎已全,无进度显示 | 🟡 | 碰TUI | M | L-042✅ |
| 1.8 | **TaskCreate/TaskGet/TaskUpdate 工具暴露** | `tools/Task*Tool` | ✅ `taskList.ts` System A todo-V2 替换 TodoWrite(`2558c61`) | ✅ | 否 | S | L-041✅ |

## 第 2 层 · 运行时/推理层（roadmap 外，对 DeepSeek 有意义）

| # | 机制 | CC 源码 | deepcode | 状态 | TUI? | 工作量 |
|---|---|---|---|---|---|---|
| 2.1 | **思考预算 / ultrathink**（adaptive budget + 关键词触发 + 跨 compact 边界结转） | `utils/thinking.ts` `utils/tokenBudget.ts` | ✅ effort 三档/ultrathink 关键词(`fa2cade`)+ **Token budget 自动续跑(`a104f45`)：+500k/use 2M sticky 目标→未达90%自动续跑+收益递减熔断+状态栏 budget 段，opus 终审 PASS+真机签收**。adaptive thinking 对 DeepSeek N/A | ✅ | 部分 | S-M |
| 2.2 | **Microcompact**（逐消息清理旧工具结果占位，省 token） | `services/compact/microCompact.ts` | 无(仅整体 compact) | ⏭️跳过(不适用 DeepSeek) | 否 | M |
| 2.3 | **自动 compact 触发 + 告警 UI**（超 token 阈值自动压 + 提示） | `services/compact/autoCompact` | ✅ **已端到端做完**（2.5 顺手做：useChat.ts:746 预估→shouldAutoCompact→doCompact('auto')→熔断+失败计数+90%预警+状态栏预警色全闭环）。调研(2026-06-22)确认。**唯一可选增量=413 reactive 兜底(M,另立条目)** | ✅ | 部分 | M |
| 2.4 | **Prompt caching / cache_control 头** | `utils/cacheBreak.ts` | ✅ cacheSavings 纯函数+状态栏 cache 段(`841b264`) | ✅ | 否 | S |
| 2.5 | **Token 计数/估算**（精确计数 + 多后端） | `services/tokenEstimation.ts` | ✅ CJK 感知估算+模型感知 window+发送前预估 compact(`7dc78ea`)。CC 的 countTokens API/多后端 N/A(DeepSeek 无此端点) | ✅ | 否 | M |
| 2.6 | **Cost 告警 hook**（累计 + 阈值告警；settings 已有 costWarnUSD） | `costHook.ts` `cost-tracker.ts` | ✅ costWarnUSD 阈值告警(`fa2cade`) | ✅ | 部分 | S |
| 2.7 | **/model /effort /fast 模型切换**（DeepSeek 内 flash↔pro 切换命令） | `commands/{model,effort,fast}` | 🟡 useChat.ts:812 仅 flash↔pro 翻转 | 🟡 | 碰TUI | S |
| 2.8 | **通用多 provider / 第三方模型切换（GLM 等任意 OpenAI 兼容后端）** ⭐用户钦定，⏳**后置（CC 对齐做完整后再做）** | （无 CC 对应；deepcode 专属扩展） | 🟡 `baseURL` 通道已在(api.ts:95)可指任意 OpenAI 兼容端点；但缺一等公民抽象 | 🟡 | 部分 | M |

### 2.8 通用多 provider 详述（2026-06-22 用户钦定新增；⏳排序后置）
**目标**：做成**通用 provider preset**（不只 GLM）——deepcode 不绑死 DeepSeek，可加任意 OpenAI 兼容后端（deepseek/glm/其它），切 provider 即带出 baseURL + 模型列表。
**排序（用户 2026-06-22 拍板）**：**先把第 1-5 层 CC 对齐做完整、该做的都做完，再回头做 2.8。** 不进当前 C3 收尾批，不抢 CC 对齐件的位。

**现状（已能勉强用）**：`createClient`(api.ts:88-99) 读 `settings.baseURL`（默认 `https://api.deepseek.com`）+ `apiKey` + `model`。GLM 是 OpenAI 兼容端点（`https://open.bigmodel.cn/api/paas/v4`，模型如 `glm-4.6`），**今天设这三项就能指过去**。

**缺口（要做成一等公民）**：
1. **解除 `deepseek-v4-flash` 硬编码** ~10 处（session.ts:90/103、compact.ts:19、headless.ts:40、tools/constants.ts:3 `SUB_MODEL`、useChat.ts:216/499/500、usageLog）→ 改 provider/model 感知，从配置取。
2. **per-provider/model 表**：`pricing.ts`（GLM 单价不同 → 否则成本显 0）、`tokenEstimate.ts MODEL_CONTEXT_WINDOWS`（GLM window → 否则落 200k 默认）、token 估算比例（GLM 也 CJK 但比例待核）。
3. **provider preset / 抽象**：`{ provider, baseURL, apiKey, models[] }`，内置 deepseek/glm preset，settings 选 provider 即带出 baseURL+模型列表（`config.ts:30` 已有闲置 `provider` 字段，目前只给 webSearch 用）。
4. **切换入口**：`/model` 扩展到跨 provider（碰 TUI 部分）；2.7 的 flash↔pro 翻转(useChat.ts:812) 并入 provider-aware 选择器。
5. **未知模型 fail-safe**：无价格表→成本标「未知」不崩；无 window→合理默认 + 提示。

**与 2.7 关系**：2.7 = DeepSeek 内切换命令的 TUI 壳；2.8 = 底层多 provider 能力。建议 2.8 先做底层抽象（非 TUI，可全做），切换 UI 与 2.7 一起在 TUI 批落。

## 第 3 层 · 记忆/会话/权限/配置（roadmap 外，价值高）

| # | 机制 | CC 源码 | deepcode | 状态 | TUI? | 工作量 |
|---|---|---|---|---|---|---|
| 3.1 | **记忆索引系统**（memdir：type/section/tags 标记 + 扫描 + relevance 查询 + 加载） | `memdir/` | ✅ C2(2026-06-19) | ✅ | 否 | M |
| 3.2 | **自动记忆提取**（会话末提取持久记忆文件） | `services/extractMemories` | ✅ C2(2026-06-19) | ✅ | 否 | L |
| 3.3 | **SessionMemory**（会话记忆 markdown 维护） | `services/SessionMemory` | ✅ C2(2026-06-19) | ✅ | 否 | L |
| 3.4 | **autoDream**（后台记忆合并，时间/会话门槛） | `services/autoDream` | ✅ C2(2026-06-19) | ✅ | 否 | L |
| 3.5 | **Checkpoint/rewind**（回合级文件备份 + content-addressable blob + /rewind 还原） | `utils/fileHistory.ts` `commands/rewind` | ✅ **主干已完成**（checkpoint.ts sha1 blob 备份+GC、restoreFiles 还原、/rewind 命令、两级 TUI 选择器、conversation/code/both 三模式全有）。调研(2026-06-22)。**真实剩余=1×M(Summarize-from-here)+4×S，其中 #4 还原前防覆盖用户手改=数据安全建议补(S,不碰TUI)** | 🟢 主干 | 部分 | S(余) |
| 3.6 | **会话管理**（/resume /branch /rename /tag /share + history） | `commands/{resume,branch,rename,tag,share}` `history.ts` | 部分(export/session) | 🟡 | 碰TUI | M |
| 3.7 | **权限 deny 规则层 + 来源层级 + denial tracking + /permissions** | `utils/permissions/*` | 🟡 deny 规则+denial tracking(安全批`e5f403d`);缺来源层级(归 3.9)+/permissions UI | 🟡 | 部分 | M |
| 3.8 | **Sandbox 网络隔离 + /sandbox-toggle** | `commands/sandbox-toggle` | 无 | ⬜ | 否 | M |
| 3.9 | **Settings 分层**（user/project/local/enterprise 合并 + 校验）+ /config /env | `utils/settings/*` | ✅ 4 层合并+SSRF（`c24ed0e`） | ✅ | 部分 | M |
| 3.9b | **Settings/模型版本迁移**（schema 升级脚本，如 migrateSonnet45ToSonnet46 / migrateOpusToOpus1m / 旧 settings 字段迁移） | `migrations/`（11 脚本） | 无 | ⬜ | 否 | S | ⭐重审补遗(2026-06-22)：deepcode 单 provider 暂无版本漂移压力，但做 2.8 多 provider/将来加模型档时需要轻量迁移机制。低优先。 |
| 3.10 | **Cron 定时任务**（ScheduleCron 工具 + cronScheduler 后台执行 + 持久化） | `utils/cronScheduler.ts` `tools/ScheduleCronTool` | 无 | ⬜ | 否 | M |

## 第 4 层 · 工具扩展（roadmap 外）

| # | 工具 | CC 源码 | deepcode | 状态 | TUI? | 工作量 |
|---|---|---|---|---|---|---|
| 4.1 | **WebSearch** | `tools/WebSearchTool` | ✅ 双源 Bocha+Tavily(`c58ff77`) | ✅ | 否 | M |
| 4.2 | **ToolSearch** | `tools/ToolSearchTool` | ⏭️暂缓存档(触发=挂 30+工具 MCP) | ⏭️ | 否 | S |
| 4.3 | **Sleep**（可打断等待） | `tools/SleepTool` | ⏭️跳过(`Bash(sleep)`已等价) | ⏭️ | 否 | S |
| 4.4 | **Brief**（工具描述摘要） | `tools/BriefTool` | ⏭️跳过(CC 双输出面契约,单面不映射) | ⏭️ | 否 | S |
| 4.5 | **Config 工具**（读写配置） | `tools/ConfigTool` | ✅ `src/tools/configTool.ts`(6 键白名单 deny-by-default GET/SET，合 main `87a1dab`，837 测试) | ✅ | 否 | M |
| 4.6 | **LSP 工具 + 诊断**（代码智能/IDE 诊断） | `tools/LSPTool` `services/lsp` `services/diagnosticTracking` | 无 | ⬜ | 否 | L |
| 4.7 | **REPL 工具**（交互式 Python/Node REPL） | `tools/REPLTool` | 无 | ⬜ | 否 | M |
| 4.8 | **NotebookEdit + NotebookRead**（Jupyter 单元格编辑/读取，不执行） | `tools/NotebookEditTool` | ✅ **完成**（merge `54a8ff9`：src/notebook.ts + Read 检测 .ipynb + NotebookEdit 工具 + Edit 拒绝 .ipynb + GLOBAL_SUBAGENT_DENY；6 任务+opus 终审，1037 测试） | ✅ | 否 | ✅ |
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
| 5.6 | **权限弹窗 UI**（always/yes/no 决策 + 规则记忆 + deny/来源展示） | `components/PermissionPrompt.tsx` | ✅ **完成**（PermissionDialog 三态+快捷键+always 写 user 规则+危险警告+diff；**+deny/来源层级展示 merge `31e5deb`**：PermissionDecisionReason 联合+settingsLayers per-rule provenance+buildDenySourceMap+checkPermission 携带/透传 decisionReason+硬拒绝文本带来源+弹窗渲染来源行；镜像 CC PermissionRuleExplanation，源 builtin/user/project/local/flag）。**余 3×S 文案(always 写哪层反馈/规则粒度预览/Tab-amend)留将来** | ✅ | 碰TUI | ✅ |
| 5.7 | **Statusline**（成本/token/模型/模式/任务进度实时栏 + /statusline） | `commands/statusline.tsx` | 极简状态行 | 🟡 | 碰TUI | M |
| 5.8 | **AI 辅助摘要**（AgentSummary 子代理进度 / toolUseSummary / awaySummary / PromptSuggestion 下一步建议） | `services/{AgentSummary,toolUseSummary,awaySummary,PromptSuggestion}` | 无 | ⬜ | 碰TUI | M |
| 5.9 | **交互小命令**（/copy /good-claude /context viz /files /add-dir /status /help /btw[旁问不打断] /clear /summary /ctx_viz 增强） | `commands/*` | 部分 | 🟡 | 碰TUI | S |
| 5.10 | **Spinner tips 轮播**（CLI spinner 上按会话轮播提示 + 历史去重） | `services/tips/`（tipScheduler/tipRegistry/tipHistory） | 无 | ⬜ | 碰TUI | S | ⭐重审补遗(2026-06-22)。纯 UX 增强，低优先，TUI 批。 |
| 5.11 | **吉祥物伴侣**（gamified companion：稀有度/帽子/属性的 ASCII 宠物 + 通知） | `buddy/`（companion/CompanionSprite/sprites） | 🟡 已有蓝鲸 mascot 静态图 | 🟡 | 碰TUI | M | ⭐重审补遗(2026-06-22)。纯装饰彩蛋；deepcode 已有静态蓝鲸欢迎图，gamified 版属可选趣味件，最低优先（可不做）。 |

## 第 6 层 · Anthropic 云/平台专属（记录在案；做 = 改造成 DeepSeek/自建后端的「云管平台」版）

> ⚠️ 这些原样连的是 Anthropic 后端，**无法"对齐 CC"原物**。未来若做云管平台，须替换为 DeepSeek/自建后端 + 自建商业逻辑。逐项记录以备将来。

| # | 机制 | CC 源码 | 云管平台改造方向 | 工作量 |
|---|---|---|---|---|
| 6.1 | **OAuth 登录/账户**（/login /logout /oauth-refresh + PKCE） | `services/oauth` `commands/login` | 接自建账户体系 | L |
| 6.2 | **用量/限额**（claudeAiLimits/policyLimits/usage/extra-usage/`/rate-limit-options`[原 /rate-limit 已改名]/rateLimitMessages 文案中心） | `services/{claudeAiLimits,policyLimits}` | 接自建计量/配额 | L |
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

**主题聚类批次（剩余非 TUI，按此序；2026-06-22 状态已同步）：**
- **C1 · 配置与权限层** → ✅**已整批完成**（3.9 Settings+SSRF `c24ed0e` / 4.5 Config `87a1dab`；3.7 余「来源层级」+ `/permissions` UI 留 TUI 批）。
- **C2 · 记忆子系统** → ✅**已整批完成**（3.1/3.3/3.2/3.4 全闭合 `af47aab`+followup `c10300e`）。
- **C3 · Token/Compact 收尾**：2.5 Token 计数 ✅(`7dc78ea`+迷你进度条 `c8de188`) → **剩 2.1 余 adaptive budget + 2.3 余自动触发**。
- **C4 · 独立工具件**（互相独立，可并行 worktree 丢 agent，降仪式）：4.6 LSP、4.7 REPL、4.8 Notebook、4.9 PowerShell、3.10 Cron、3.8 Sandbox。
- **C5 · Steering→多agent**：✅**1.3 Steering 已完成**（merge `32612a1`，CC 真实模型，为 B 批 1.6 多 agent 铺路）。
- **⏳ 后置 · 2.8 通用多 provider / GLM**（2026-06-22 用户钦定通用 preset，但拍板**后置**）：先把第 1-5 层 CC 对齐做完整再做。**⭐前置已满足（C5 收官后非 TUI 层 1-5 全完）→ 现已解锁，下一会话候选之一。**

**真实剩余下一步（2026-06-22 C5 收官后同步）**：①2.1 余 adaptive budget(N/A,DeepSeek无API) ②2.3 余自动触发(已端到端完成) ③✅C4 工具批已收尾(只做 Notebook `54a8ff9`，LSP/Cron/Sandbox 推迟、PowerShell/REPL 跳过) ④✅**C5 1.3 Steering 已完成**(merge `32612a1`，CC 真实模型) ⑤TUI 批余项（✅3.5 Rewind UI / ✅5.6 权限弹窗 deny/来源 已破例先做完；余 `/permissions` UI + 其它 TUI 件）。**⭐拐点：CC 第 1-5 层非 TUI 件全完→下一会话三候选**：(a) ⏳2.8 通用多 provider/GLM（已解锁，底层非 TUI 可全做）(b) TUI 攒最后批（1.4/1.5/1.6/1.7/2.7/3.6/4.11/第5层一起冒烟）(c) 回捡 C4 推迟件(LSP/Cron/Sandbox) 或第6层云平台。**开新会话与用户确认挑哪个。**

**TUI 批 · 两件提前破例（用户拍板，其余仍攒最后一起冒烟）：**
- 🔓 **3.5 Rewind UI 提前**（安全网，让后面可写 subagent 1.5/autoDream 敢做）。
- 🔓 **5.6 权限弹窗 UI 提前**（点亮已做的重权限逻辑 deny/来源层级，否则用户感知不到）。
- 攒最后批（不破例）：1.4 Plan mode、1.5 可写 subagent+worktree、1.6 多 agent（依赖 1.3）、1.7 hooks TUI(①e)、2.7 模型切换（轻量，DeepSeek 档位少）、3.6 会话管理、4.11 多模态、第 5 层其余(5.1-5.5/5.7-5.9)。

**裁决（用户拍板）：4.10 RemoteTrigger → 归第 6 层**（远程触发工作流本质偏云/平台编排，与 6.8 远程会话同类）。专家另建议砍 4.9 PowerShell、降 3.10 Cron/3.8 Sandbox、4.6 LSP 单独评估——**用户选择保留**（暂不砍，做到时再按 ROI 复评）。

**仪式分层提醒（专家盲点）：剩余件分「能力件」（记忆批/Steering/可写subagent/rewind，用全仪式 opus 终审）vs「对齐件」（Notebook/PowerShell/Config 等表面对齐，可降仪式、并行 worktree）——别对 4.8 Notebook 和 3.1 记忆索引用一样重的流程。**

**第 6 层**：单独立项「云管平台」，本表记录在案，待用户启动。新增 4.10 RemoteTrigger 归入。
