# deepcode MCP 客户端（L-022）stdio-first 设计 spec

**日期：** 2026-06-17
**机制：** master roadmap 第 1 层 #1.1（A 批起跑件）
**对齐依据：** CC 源码 `services/mcp/`（逐符号实读，见对齐报告）。用户钦定「对齐 CC、别自创」。
**前置：** 无（L-040B 已为 mcpServers 留接口缺口，本件部分闭合）。
**TUI：** 否（纯逻辑，免冒烟；工具池注入走异步回调，不阻塞 TUI 启动）。

---

## 1. 目标与范围

让 deepcode 能连 stdio MCP server，把 server 的 tools 发现并注入工具池，模型可调用、结果回注。用官方 `@modelcontextprotocol/sdk`（CC 同款，非自实现）。

### MVP 做（核心闭环，~250 行）
1. **stdio 连接**：`StdioClientTransport` + `Client.connect`。
2. **配置**：`Settings.mcpServers`（仅 user scope `~/.deepcode/settings.json`，`${VAR}`/`${VAR:-default}` 展开）。
3. **工具发现**：`tools/list` → 包装成 deepcode `Tool`（名 `mcp__<server>__<tool>`，JSON Schema 透传，`isReadOnly` 读 `annotations.readOnlyHint`，`call` 路由 `callTool` 取 `content`）。
4. **注入**：`useChat.ts` + `headless.ts` 两处异步注入工具池。
5. **容错**：单 server 连接失败吞掉（不崩主程序）+ 30s 连接超时 + callTool 120s 超时兜底 + 进程退出 `client.close()`。
6. **权限**：走现有 `needsPermission`/`checkPermission` 通道（per-tool 规则）。

### MVP 不做（对齐报告明确可砍，记入 L-022 后续增量）
- **认证**（CC `auth.ts` 88KB OAuth/PKCE/keychain + `McpAuthTool`）—— stdio 不需要；远端 server 让用户用 stdio + `env` token 绕过。
- **http/sse/ws transport** —— 远端暂缓。
- **资源**（ListMcpResources/ReadMcpResource 元工具）—— 多数常用 server 靠 tools；后续增量。
- **多层 scope + 审批**（project `.mcp.json`/local/enterprise/`mcpServerApproval`）—— deepcode 单文件 user settings 天然可信，不需审批。
- **agent 级 `mcpServers`**（闭合 L-040B frontmatter 缺口）—— 需改 AgentDefinition + agent 工具池构造，独立增量；MVP 先做全局。
- 重连/健康检查/session 重试 —— stdio 子进程通常稳定，MVP 砍；真挂重启 deepcode。
- InProcessTransport/SdkControl/IDE/plugin channel 相关 —— 全不碰。

---

## 2. 模块设计：`src/mcp.ts`（新建）

```
// 纯函数（拷 CC，~45 行）
normalizeNameForMCP(s): 非 [a-zA-Z0-9_-] → '_'         // normalization.ts:17-23
buildMcpToolName(server, tool): `mcp__${norm(server)}__${norm(tool)}`  // mcpStringUtils.ts:50
expandEnvVars(str, env): ${VAR} / ${VAR:-default}      // envExpansion.ts

// 类型
McpStdioServerConfig = { command: string, args?: string[], env?: Record<string,string> }

// 连接 + 发现（async）
connectStdioServer(name, cfg, signal?): 
  transport = new StdioClientTransport({ command, args, env:{...process.env, ...展开(cfg.env)}, stderr:'pipe' })
  client = new Client({ name:'deepcode', version }, { capabilities:{} })   // 不声明 roots/elicitation
  await Promise.race([client.connect(transport), 30s timeout])
  return { client, transport }

// 包装成 deepcode Tool
wrapMcpTool(client, serverName, mcpTool): Tool = {
  name: buildMcpToolName(serverName, mcpTool.name),
  description: mcpTool.description ?? '',
  inputSchema: z.object({}).passthrough(),        // 校验交 server（对齐 MCPTool.ts:14）
  rawJsonSchema: mcpTool.inputSchema,             // 新增字段，toApiTools 透传
  isReadOnly: () => mcpTool.annotations?.readOnlyHint ?? false,
  needsPermission: (input) => 只读?null:`${serverName}: ${mcpTool.name}`,
  call: async (input, ctx) => {
    const r = await Promise.race([client.callTool({ name: mcpTool.name, arguments: input }, ...), 120s])
    if (r.isError) throw new Error(serialize(r.content))
    return serializeContent(r.content)   // content blocks → 文本/JSON.stringify
  }
}

// 总入口（启动时调）
initMcpTools(settings, signal?): Promise<{ tools: Tool[], cleanup: () => Promise<void> }>
  - 遍历 settings.mcpServers，低并发连接，单个失败 catch 后跳过（log 警告）
  - 每个连上的 server listTools → wrapMcpTool
  - 返回扁平 tools[] + cleanup（遍历 client.close()）
```

**架构铁律**：`mcp.ts` 不反向依赖 loop/useChat；由 useChat/headless 调用并注入。失败容错在 `initMcpTools` 内吞掉，绝不让启动失败。

---

## 3. 接入点改动

| 改动 | 文件:行 | 内容 |
|---|---|---|
| Tool 加字段 | `tools/types.ts:26-35` | `rawJsonSchema?: object` |
| API schema 透传 | `tools/index.ts:13-22` | `toApiTools` 优先用 `rawJsonSchema`，跳过 `zodToJsonSchema` |
| 校验放行 | `loop.ts:72` | MCP 工具 `inputSchema`=passthrough，`safeParse` 自然放行 |
| Settings | `config.ts:7-23` + `:46-55` | 加 `mcpServers?: Record<string, McpStdioServerConfig>` |
| 注入(TUI) | `tui/useChat.ts:~360` | init effect 里 `await initMcpTools` 后 setState 注入（异步，不阻塞启动；对齐 CC onConnectionAttempt 回调式） |
| 注入(headless) | `headless.ts:~91` | `await initMcpTools` spread 进 tools |
| 退出 cleanup | useChat dispose / headless 末 | 调 `cleanup()` |

---

## 4. 验证（TDD 计划落点，writing-plans 细化）

- **纯函数**：normalizeNameForMCP / buildMcpToolName / expandEnvVars 单测（含边界：含 `__` 的 server 名、缺失 var、default 语法）。
- **wrapMcpTool**：mock MCP tool，验名/schema 透传/isReadOnly/call 路由原始名/isError 抛错/content 序列化。
- **initMcpTools**：mock 一个连得上 + 一个连不上的 server，验失败吞掉只丢该 server、成功的工具正常返回、cleanup 调用。可用一个真·最小 stdio echo server 脚本做集成测试（fixture）。
- **toApiTools**：MCP 工具走 rawJsonSchema 路径、内建工具仍走 zodToJsonSchema。
- 全量 `npm test` + typecheck + build 全绿。注意已知 EPIPE flaky（spawn 子进程类测试，vitest exit 0 不计失败）。

---

## 5. 后续增量（不在本 MVP，记入 roadmap L-022 续）
callTool 重连/session 重试 → 资源元工具 → http/sse + OAuth(McpAuth) → agent 级 mcpServers(闭合 L-040B frontmatter) → 整 server 通配权限规则 `mcp__server:*`。
