# deepcode

给 DeepSeek API 写的 CC 风格终端编码助手（微缩版 Claude Code）。

```
deepcode
› versions 路由的权限是怎么校验的？
⏺ Grep({"pattern": "versions", "glob": "*route*"})   ← 模型自主并行调用工具
⏺ Read({"file_path": ".../check-role.ts"})
权限校验走统一的 checkRole(minRole)，基于 JWT + users 表角色字段……
[入 3366（缓存命中 2816）出 602]                      ← KV 缓存命中，长会话近乎只付输出 token
```

## 安装

```bash
npm i -g @silassolivagus/deepcode
```

安装后命令为 `deepcode`。需要 Node ≥ 18。

## 配置 API key

三选一（优先级 env > settings）：
- 首次运行 `deepcode`，按向导粘贴 key（写入 `~/.deepcode/settings.json`，权限 600）
- 或 `export DEEPSEEK_API_KEY=sk-...`
- 或手写 `~/.deepcode/settings.json` 的 `apiKey` 字段

> 若你的网络需代理访问 DeepSeek，设置 `https_proxy`（如 `http://127.0.0.1:8118`），deepcode 会自动经它请求。

## 用法

```bash
deepcode                    # 交互式 TUI
deepcode -p "<任务>"         # 一次性 headless 输出
deepcode -p "<任务>" --json  # headless + JSON（text/status/turns/usage/costUSD）
echo "<任务>" | deepcode     # 管道喂入走 headless
```

交互中：
- `@文件` 引用文件、`!命令` 直跑 shell
- 斜杠命令：`/model`（flash↔pro）、`/think`、`/accept`、`/cost`、`/context`、`/compact`、`/clear`、`/resume`、`/permissions`、`/init`（生成 DEEPCODE.md）、`/help`、`/exit`
- 工具：Read / Glob / Grep / Bash / Edit / Write / TodoWrite / Agent（只读子代理）/ WebFetch

`/` 浮出补全菜单，Esc 中断当前轮，Ctrl+C×2 退出。自定义命令放 `~/.deepcode/commands/*.md` 或 `<项目>/.deepcode/commands/*.md`（`$ARGUMENTS` 占位）。权限规则持久化在 `~/.deepcode/settings.json`。

## MCP 服务器（stdio）

在 `~/.deepcode/settings.json` 加 `mcpServers` 即可接入 [MCP](https://modelcontextprotocol.io) 生态的 stdio server，其工具自动进入工具池：

```jsonc
{
  "mcpServers": {
    "git": { "command": "uvx", "args": ["mcp-server-git", "--repository", "."] },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}
```

- 工具以 `mcp__<server>__<tool>` 名出现；标了 `readOnlyHint` 的工具免权限确认，其余走正常权限弹窗。
- `env` 值支持 `${VAR}` / `${VAR:-默认}` 展开。连接失败的 server 静默跳过，不影响启动。
- **安全提示**：每个 server 子进程会继承当前环境变量（含 `DEEPSEEK_API_KEY`）；只配置你信任的 server。
- 当前为 stdio MVP：暂不支持 http/SSE 传输、OAuth 认证、resources、项目级 `.mcp.json` 审批（见 `docs/specs/2026-06-17-deepcode-l022-mcp-stdio-design.md` §5 后续增量）。

## 模型

默认 `deepseek-v4-flash`，`/model` 无参在 `deepseek-v4-flash`↔`deepseek-v4-pro` 间切换（`/model <模型名>` 指定具体模型），`/think` 开关 thinking。

thinking 控制：v4-flash 默认偷偷开 thinking（同一问题 39 token vs 1 token），deepcode 默认显式关闭；`/think` 开启后思考流可见（仅显示，不入上下文）。

## 为什么不直接用 Claude Code 接 DeepSeek？

DeepSeek 官方提供 [Anthropic 兼容接口](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api)，两行环境变量就能让 Claude Code 跑在 DeepSeek 上：

```bash
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_API_KEY=${DEEPSEEK_API_KEY}
# claude-opus → deepseek-v4-pro；claude-sonnet/haiku → deepseek-v4-flash
```

那条路是**租房**：立刻获得 CC 全套能力（subagent、compact、skills、TUI），但 harness 是黑盒——

| | CC + DeepSeek 兼容接口 | deepcode（本项目） |
|---|---|---|
| 上手成本 | 两行环境变量 | `npm i -g @silassolivagus/deepcode` |
| 功能完整度 | CC 全家桶 | M1–M6 核心功能，逐里程碑补齐 |
| 系统提示词/工具描述 | 为 Claude 调教的，DeepSeek 吃这套的效果不可控 | 为 DeepSeek 撰写，可逐字调整 |
| 兼容接口的限制 | 不支持图像/文档内容、忽略 `cache_control`/`top_k`/MCP 部分字段 | 直连原生 OpenAI 兼容接口，无转译层 |
| thinking 成本控制 | 由 CC 的请求行为决定 | 显式 `thinking:{type:"disabled"}` 默认关（实测省 ~39 倍输出 token） |
| 可改性 | 不可改 | 每一行都是你的 |

两条路线不互斥：日常重活可以用 CC 接 DeepSeek，deepcode 的价值是**自主可控 + 理解 harness 的每一层**。

## 架构

```
src/
  index.ts        入口（argv 解析）
  repl.ts         readline 交互层：渲染、权限弹窗、Esc —— 纯消费者，无业务逻辑
  loop.ts         ★ 核心 agent loop（async generator，yield 渲染事件）
  api.ts          DeepSeek 客户端：流式 tool_calls 分片拼装、指数退避重试、代理
  prompt.ts       静态系统提示词组装 + 记忆文件发现
  permissions.ts  权限门 + 规则匹配
  config.ts       ~/.deepcode/settings.json
  tools/          Tool 接口（zod schema 驱动）+ Read/Glob/Grep/Bash/Edit/Write
```

设计原则（详见 [docs/specs/](docs/specs/) 的完整规格）：

1. **控制流姓代码，智能姓模型**——循环、状态、熔断全是确定性 TS，模型只回答窄问题
2. **重试与幂等的边界**：重试只包 API 建流阶段，工具执行绝不因重试跑两遍
3. **报错写给模型看**：每条工具错误都回答"模型下一步该怎么办"（"old_string 出现了 3 次，请提供更长的唯一片段"）
4. **工具结果是不可信输入**：文件内容里的指令不具有用户权威

## Roadmap

- [x] **M1 能对话**：流式 TUI + 只读探查 + Bash + 权限门（`v0.1.0-m1`）
- [x] **M2 能干活**：Edit/Write + 强制 read-before-edit + acceptEdits 模式（`v0.2.0-m2`）
- [x] **M3 不丢活**：会话 JSONL 持久化、`--continue`/`/resume`、`/cost`（`v0.3.0-m3`）
- [x] **M4 跑长活**：上下文压缩 compact（手动 `/compact` + 阈值自动触发）、TodoWrite + system-reminder 走神检测、只读 Agent 子代理（并发 ×4）、`/init` `/context` `/permissions` 与自定义命令（`$ARGUMENTS` 模板）、headless `-p "<任务>" [--json]` 单发模式（`v0.4.0-m4`）
- [x] **M5 CC UI 1:1 复刻**：ink TUI、补全菜单、思考折叠块、缓存命中率/tok-s 状态行（`v0.5.0-m5`）
- [x] **M6 公开发布**：`npm i -g @silassolivagus/deepcode` 可安装、首跑 TUI 向导写 key、WebFetch 工具（`v0.6.0-m6`）
- [x] **M7① 问用户**（本版）：AskUserQuestion 工具 —— 模型在歧义/需选择时弹结构化多选题（对齐 CC：tab 导航条、`←→` 回上一题重选、多选确认按钮、提交复核页），headless 不注册（`v0.7.0-m7`）
- [x] **M8 P1 全屏可滚**：alt-screen 全屏接管 + 键盘滚动 `PageUp`/`PageDown`/`Ctrl+G` + auto-follow，修终端原生回滚失效；`--inline`/`DEEPCODE_INLINE=1`/settings `inline:true` 退回内联（`v0.7.0-m7`）
- [x] **M7② 回退**（本版）：`/rewind` —— CC 式 before-image 落盘回退，两步选还原点 + 三模式（仅对话/仅代码/两者），跨 compact/resume 锚点稳定（`v0.7.1-m7`）
- [x] **M8 P2 滚轮**：鼠标/触控板滚轮滚历史 —— SGR 鼠标捕获 + 喂 ink 前过滤序列防污染输入框（`v0.7.1-m7`）
- [x] **编排① 类型化子代理**（本版）：`subagent_type` + 内建注册表（general-purpose/Explore/Plan）+ CC 式工具解析（deny 赢 allow）+ Bash yolo 钳制（`v0.8.0`）
- [x] **编排② 后台任务**（本版）：Bash/Agent `run_in_background` 启动即返句柄 + `<task-notification>` 完成通知（runLoop 注入 + idle 自动唤醒）+ TaskList/TaskOutput/TaskStop（`v0.8.0`）
- [ ] **编排续**：hooks 生命周期、结构化输出、子代理 steering、多 agent 工作流、可写 subagent + worktree、MCP 客户端、skills（见 `loop/BACKLOG.md` 编排层 + `docs/specs/2026-06-16-cc-mechanisms-roadmap.md`）
- [ ] **M8 续**：P3 应用内选中复制

## 开发

```bash
npm test           # vitest
npm run typecheck  # tsc --noEmit
DEEPSEEK_API_KEY=sk-... npx tsx scripts/smoke-api.ts "你好"  # 真机冒烟
```
