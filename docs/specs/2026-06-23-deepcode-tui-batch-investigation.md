# TUI 攒最后批 · 调研报告（2026-06-23）

派 6 个并行 agent 实读 CC bundle（`/opt/homebrew/lib/node_modules/@anthropic-ai/.claude-code-2DTsDk1V/cli.js` v2.1.76 + `sdk-tools.d.ts`）+ 摸 deepcode 现状判真实增量。方法论=不信 roadmap 标题、实读 CC 真实行为、TUI 触发键验可达性、辨 DeepSeek N/A。

## 锁定范围 = 9 件（用户拍板 2026-06-23）
核心 7：1.4 / 1.7 / 2.7 / 3.6(fork+rename) / 5.3 / 5.4 / 5.9。加餐 2：1.6 Task 依赖图薄片 / 5.7 /statusline 自定义。

## 实读推翻的 roadmap 标题水分（重要校正）
- **1.4**：CC 无 `EnterPlanModeTool`——plan 是 permission **mode**（`sdk-tools.d.ts:297` mode enum 含 `"plan"`），只有 `ExitPlanMode` 工具（d.ts:349 输入含 `allowedPrompts?:{tool:"Bash";prompt}[]`，d.ts:2227 输出 `plan/isAgent/filePath`，计划写盘）。进入靠 TUI Shift+Tab 三态循环或 `--permission-mode plan`。ExitPlanMode 校验 `mode==="plan"` 否则拒。
- **2.7**：`/fast` 在 CC **不是命令**（bundle 命中全是无关上下文）。`/effort` enum 正好 low/medium/high，deepcode 已对齐完成。
- **3.6**：`/branch`、`/share` 是臆想名——真实命令是 `fork`（在当前点分叉副本）和 `session`/`remote`（云 URL+QR，Anthropic 专属）。
- **4.11**：DeepSeek 公共 API **不支持图像输入**（deepseek-vl 仅 HF 权重不在 API）；GLM-4.5V 支持但属长尾。CC 图像走 osascript/wl-paste/xclip 读 OS 剪贴板（非 bracketed paste）。
- **5.1**：实为 **L**（中央 dispatcher 重构触及 6+ 组件），非 roadmap 标的 M。bundle 有两个同名 `keybindings.json`：VSCode 终端 setup vs 真配置系统（chord 状态机 `Z$1`/`Hl3`，~14 context）。deepcode `keybindings.ts` 只是静态展示 formatter。
- **5.5**：STT 走 Anthropic conversation-engine + `deepgram-nova3` 云专属（bundle `stt_provider:deepgram-nova3`）；capture 可移植（spawn sox/arecord）但 STT 后端硬阻塞。
- **5.9**：`/good-claude`/`/summary`/`/files`/`/ctx_viz` 多为伪命令或已有等价物（ctx_viz=`/context` grid 视图、summary=`/compact` 范畴）；真缺只有 `/add-dir`。

## 9 件真实增量与工作量
| 件 | 真实增量 | 量 | 关键文件/锚点 |
|---|---|---|---|
| 1.4 Plan mode | `PermissionMode` 加 `'plan'`；`checkPermission`(permissions.ts:216 后)加 1 行 `mode==='plan'&&!isReadOnly→拒`；新 ExitPlanMode 工具(isReadOnly,写盘计划,allowedPrompts→rules)；审批弹窗复用 5.6；system prompt 注入 plan 指引；TUI 切态(建议 `/plan` 命令先,Shift+Tab=`\x1b[Z` 需验可达再加) | M | permissions.ts:70,192-258; useChat.ts:236,877 |
| 1.7 Hooks 进度 | `runHooks` 加 `onProgress(label)` 回调,慢阶段(PreCompact/SessionStart/Stop)喂现成 Spinner;PreToolUse/PostToolUse 瞬时不显(对齐 CC 点缀式) | S | hooks.ts; tui/components/Spinner.tsx; loop.ts:98,127 |
| 2.7 /model 选择器 | 无参 `/model` 盲翻转→SelectList,列 `activeProvider().meta` 全档(+fast/smart 别名,可附 window/价格);不做运行期跨 provider 热切(与锁定设计冲突) | S | useChat.ts:836-852; resumeModel.ts:10; providers.ts(底座全现成) |
| 3.6 /fork | 拷贝当前 messages 切片→newSession 沿用 meta(基建八成在:forked 隔离+appendMessage) | S | session.ts:89,147; useChat.ts:1059 |
| 3.6 /rename | `SessionMeta` 加可选 `title`;`/rename` 写 meta;`listSessions` 预览优先 title(现硬编码首句 60 字 session.ts:160) | S | session.ts:6-13,160 |
| 5.3 Output styles | config 加 `outputStyle`;内置 2 样式(Explanatory/Learning)+`~/.deepcode/output-styles/*.md` 加载(复用 skillsLoader 范式);system 组装条件注入(keepCodingInstructions 门控);`/output-style` picker | M | config.ts; prompt.ts(注入点); SelectList.tsx |
| 5.4 /theme+light | `theme.ts` 单 const `T`→按主题名 getter/context(~10 处 `import{T}` 改读 context 才能热切);≥2 套(dark+light,可选 daltonized/ansi);config 键 `theme`;`/theme` picker;hex 要 ANSI fallback | S–M | tui/theme.ts(15 行单点); 消费点 QuestionDialog/PermissionDialog/Banner/StatusFooter |
| 5.9 /add-dir | cwd 白名单目录加权限/路径解析(复用 settingsLayers/permissions) | S | commands.ts; permissions.ts |
| 1.6 Task 依赖图薄片 | todo-V2 Task 加 `blocks`/`blockedBy` + claim 前"blockedBy 必须空"校验;`TaskUpdate` 加 addBlocks/addBlockedBy;**不动** Team/teammate/SendMessage/mailbox 重型件(归第6层) | S | taskList.ts:6-13; tools/taskTools.ts |
| 5.7 /statusline 自定义 | settings 加 `statusLineCommand`;spawn 用户 shell 命令→渲染 stdout 成状态行;**走 hook/permissions 命令执行加固**(任意命令面) | S | StatusFooter.tsx(展示侧已覆盖 95%); settingsLayers |

## DEFER（独立批/后置）
- **1.5 可写 subagent + worktree**（L）：货真价实——需 ToolContext/subagentRunner 引入**独立 cwd**(现全局共享)、git worktree 编排(建/清/discard 守卫/baseRef)、`resolveAgentTools` 条件 deny(isolation==='worktree' 移出 Edit/Write/NotebookEdit)。安全盲点:子代理写操作走 `subagentPermissionDecision` 自动放行(agent.ts:18),靠 worktree 文件系统隔离兜底。建议砍范围:仅 git 仓库+isolation 字段自动建清+不暴露独立 Enter/Exit 工具。**独立成批**。
- **1.6 重型 Team**（L/XL）：teammate 进程内 async 协程(bundle `KT8`/AsyncLocalStorage `ef8`,poll loop 500ms)+TeamCreate/Delete+mailbox/SendMessage+成员按 name 寻址+team memory。单输出面终端 fan-out 已吃 80% 价值,UI 难表达,与第6层云平台同源→归后置。
- **5.1 keybindings**（L）：中央 dispatcher 重构,chord 在 ink/终端可达性受限(ctrl+i=Tab/ctrl+m=Enter/ctrl+[=Esc 死键,Alt 需改 Terminal.app useOptionAsMetaKey)。
- **5.8 promptSuggestion**（M）：每轮额外付费调用,单输出面价值有限。
- **3.6 /tag**（M）：searchable 依赖未做的 resume 过滤 UI。

## SKIP
- **4.11 多模态**：DeepSeek 无视觉 API,默认路径 N/A,L 工作量服务长尾 GLM-4V。将来 DeepSeek 上线视觉或用户明确要 GLM-4V 再重评。
- **5.2 vim**（L）：终端 agent 非编辑器,输入框太小用不上 vim 杀手锏,服务极少数死忠。
- **5.5 语音**（L）：STT 后端硬阻塞 + 二进制安装引导。
- **5.10 tips / 5.11 buddy**：纯 UX 糖/纯彩蛋,deepcode spinner 动名词 + 静态蓝鲸已足够。

## 建议实施次序（9 件,共享基建聚类）
1. **SelectList picker 族**（2.7 /model、5.3 output-style、5.4 /theme）——共用 SelectList + config 字段 + picker 模式,一组做掉。
2. **会话命令族**（3.6 /fork、/rename、5.9 /add-dir）——共用 session meta / 命令解析。
3. **权限/执行族**（1.4 Plan mode、1.6 Task 依赖图、5.7 /statusline）——碰 checkPermission/taskList/命令执行加固。
4. **显示层**（1.7 Hooks 进度）——接 Spinner。
全部碰 TUI → 一次真机冒烟。1.4 审批弹窗 + Shift+Tab 可达性是冒烟重点。
