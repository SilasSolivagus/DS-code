# CC 能力差距分析——deepcode 还需要抄什么（按价值排序）

日期：2026-06-12。基准：deepcode v0.3.0-m3（1167 行 src）对比 Claude Code 全量能力。
价值评估视角：单人本地使用 + 终局目标（专业级全量测试套件、"达到 CC 差不多效果"）。

排序原则：**价值/成本比**，不是绝对价值。CC 的几十万行里大部分对本项目是负价值（见 Tier 4）。

## Tier 1：该做，已纳入 M4 或排进 M5（高价值低成本）

| # | 能力 | 价值 | 成本 | 去向 |
|---|---|---|---|---|
| 1 | **headless `-p` 模式**（`deepcode -p "..." --json`） | bench 现在靠 stdin pipe + 从 REPL 噪音里正则扒输出，脆弱且难做 N≥5 统计跑。`-p --json` 输出机器可读结果，直接服务终局目标；附带解锁脚本化/CI 用法 | ~80 行 | **提进 M4**（原 spec §8 列为第一版不做，因 bench v1 需要而提前；架构已预留） |
| 2 | **Edit/Write 权限弹窗显示 diff 预览** | 现在批准编辑时只看到操作描述，等于盲签。看到改动内容再按 y 是信任与安全的核心 UX，CC 的弹窗体验一半价值在这 | ~60 行（无依赖的简易 old/new 对照渲染） | M5 |
| 3 | **模型/baseURL 可配置**（settings.json） | 解锁用同一 harness A/B 任意 OpenAI 兼容模型（GLM/Qwen/Kimi），bench 从"deepcode vs CC"升级为"任意模型对照"——直接服务终局目标 | ~20 行 | M5 |
| 4 | **`!` 前缀直跑 bash + `@文件` 引用** | 输入 UX：`!npm test` 不经模型直接跑、`@src/loop.ts` 自动展开为文件内容。高频小便利 | ~40 行 | M5 |

## Tier 2：值得做，M5/M6（高价值中成本）

| # | 能力 | 价值 | 成本 | 备注 |
|---|---|---|---|---|
| 5 | **可写 subagent + git worktree 隔离** | 并行干活（M4 的 subagent 是只读探查版）。subagent-driven 开发流的基础设施 | 中（权限冒泡 + worktree 生命周期） | spec 已标"二期" |
| 6 | **WebFetch**（先不做 Search） | 查在线文档是编码任务的真实高频需求，DeepSeek 无原生联网 | 中（HTML→文本 + 注入面扩大需防护） | 工具结果不可信原则已有，复用 |
| 7 | **checkpoint / rewind（写前文件快照）** | yolo 跑长活的后悔药；M4 之后长任务变多，价值上升 | 中（Edit/Write 前快照到 ~/.deepcode/checkpoints + /rewind 命令） | spec §8 曾列不做，长任务时代建议重估 |
| 8 | **Bash 后台任务**（run_in_background） | dev server / watch 场景，长任务常踩 | 中 | |

## Tier 3：等真实需求出现再做（中价值高成本）

| # | 能力 | 为什么不急 |
|---|---|---|
| 9 | MCP 客户端（只做 stdio 传输） | 生态接入价值大，但协议+服务器生命周期管理成本高；目前没有非用不可的 MCP 服务器 |
| 10 | hooks（PreToolUse/PostToolUse 跑 shell） | 自动化护栏，单人用户用权限规则已覆盖大半 |
| 11 | skills/插件框架 | M4 的自定义命令（markdown + $ARGUMENTS）已覆盖 80% 场景 |
| 12 | 视觉 sidecar（ImageRead 挂第三方视觉模型） | 已在 README roadmap M4+，截图排错场景才解锁，等场景出现 |

## Tier 4：明确不抄（对本项目零价值或负价值）

- **ink/React TUI**：CC 行数的大头，readline 已够用——这是 deepcode 存在的前提假设
- **多供应商适配**（Bedrock/Vertex）、登录/计费、企业策略 settings、telemetry、自动更新：单人本地工具不需要
- **IDE 集成**：成本极高，终端工作流不需要
- **沙箱**（seatbelt/bubblewrap）：权限门已覆盖主要威胁面；做对的成本极高
- **Windows 支持**：无此环境

## 与既有 roadmap 的关系

- M4 范围 = spec §7 原计划（compact/TodoWrite+reminder/subagent/斜杠命令全套/自定义命令）**+ 本分析提前的 #1 headless `-p`**
- M5 候选 = #2 diff 预览、#3 模型可配、#4 输入 UX、#5 可写 subagent（按届时痛点排序）
- spec §8「明确不做」中 `-p` 与 `/rewind` 两项地位调整：`-p` 提进 M4，`/rewind` 降为 Tier 2 待重估；其余维持不做
