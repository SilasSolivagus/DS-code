# deepcode

基于 DeepSeek API 的终端编码 agent —— 一个微缩版 Claude Code 架构的自有 harness。

```
cd 你的项目 && DEEPSEEK_API_KEY=sk-... deepcode
› versions 路由的权限是怎么校验的？
⏺ Grep({"pattern": "versions", "glob": "*route*"})   ← 模型自主并行调用工具
⏺ Read({"file_path": ".../check-role.ts"})
权限校验走统一的 checkRole(minRole)，基于 JWT + users 表角色字段……
[入 3366（缓存命中 2816）出 602]                      ← KV 缓存命中，长会话近乎只付输出 token
```

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
| 上手成本 | 两行环境变量 | clone + npm i |
| 功能完整度 | CC 全家桶 | M1 核心六件套，逐里程碑补齐 |
| 系统提示词/工具描述 | 为 Claude 调教的，DeepSeek 吃这套的效果不可控 | 为 DeepSeek 撰写，可逐字调整 |
| 兼容接口的限制 | 不支持图像/文档内容、忽略 `cache_control`/`top_k`/MCP 部分字段 | 直连原生 OpenAI 兼容接口，无转译层 |
| thinking 成本控制 | 由 CC 的请求行为决定 | 显式 `thinking:{type:"disabled"}` 默认关（实测省 ~39 倍输出 token，见下） |
| 可改性 | 不可改 | 每一行都是你的 |

两条路线不互斥：日常重活可以用 CC 接 DeepSeek，deepcode 的价值是**自主可控 + 理解 harness 的每一层**。

## M1 已实现（tag `v0.1.0-m1`）

- **核心 agent loop**：流式响应 → 工具分发（只读并发 ×5 / 写串行）→ 结果回灌循环，maxTurns 熔断，中断后自动补齐消息序列（不会留下让 API 报 400 的 tool 结尾）
- **四个工具**：Read（行号 + offset/limit + fileState 记录）、Glob、Grep（系统 rg 优先，JS 降级）、Bash（持久化 cwd、30k 输出截中间、真实退出码透传）
- **权限门**：只读自动放行；写操作弹窗 y/n/always，always 持久化为 CC 风格规则（`Bash(npm test:*)` 前缀匹配，带词边界）；`--yolo` 全放行
- **KV 缓存纪律**：system prompt 会话内绝对静态、messages 只追加——DeepSeek 前缀缓存命中价约为未命中的 1/10，实测会话内命中逐轮递增
- **thinking 控制**：v4-flash 默认偷偷开 thinking（同一问题 39 token vs 1 token），deepcode 默认显式关闭；`/think` 开启后思考流可见（仅显示，不入上下文）
- **环境适配**：自动识别 `https_proxy` 等代理变量（undici ProxyAgent；Node fetch 默认不读代理）
- **项目记忆**：自动向上收集 `CLAUDE.md`/`AGENTS.md` + 全局 `~/.deepcode/DEEPCODE.md` 注入系统提示词
- Esc 中断当前轮、66 个单测

## 使用

```bash
npm install
export DEEPSEEK_API_KEY=sk-...
npm start            # 在当前目录启动 REPL
npm start -- --yolo  # 跳过所有权限确认（自担风险）
```

REPL 内命令：`/model`（flash↔pro 切换）、`/think`（thinking 开关）、`/help`、`/exit`，Esc 中断当前轮。

权限规则持久化在 `~/.deepcode/settings.json`。

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

- [x] **M1 能对话**：流式 REPL + 只读探查 + Bash + 权限门（`v0.1.0-m1`）
- [x] **M2 能干活**：Edit/Write + 强制 read-before-edit + acceptEdits 模式（`v0.2.0-m2`）
- [x] **M3 不丢活**：会话 JSONL 持久化、`--continue`/`/resume`、`/cost`（`v0.3.0-m3`）
- [ ] **M4 跑长活**：上下文压缩 compact、TodoWrite + system-reminder、只读 subagent、`/init` `/context` 与自定义命令
- [ ] **M4+ 视觉 sidecar（可选）**：DeepSeek API 不收图，但可以加 `ImageRead` 工具——挂任意 OpenAI 兼容的视觉模型（GLM-4V/Qwen-VL/Gemini），主模型带着具体问题问图（"这张报错截图的 stack trace 第一行是什么"），把回答作为工具结果回灌。有损但够用，截图排错类场景即可解锁

里程碑规格与实施计划在 [docs/specs/](docs/specs/) 与 [docs/plans/](docs/plans/)，M1 验收报告见 [docs/specs/m1-acceptance.md](docs/specs/m1-acceptance.md)。

## 开发

```bash
npm test           # vitest，66 用例
npm run typecheck  # tsc --noEmit
DEEPSEEK_API_KEY=sk-... npx tsx scripts/smoke-api.ts "你好"  # 真机冒烟
```
