// src/mcp.ts —— MCP 客户端（stdio-first，对齐 CC services/mcp）
// 架构铁律：本模块不反向 import loop/useChat/headless。

import { z } from 'zod'
import type { Tool } from './tools/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpStdioServerConfig } from './config.js'

/** 非 [a-zA-Z0-9_-] 字符替换为 '_'（对齐 CC normalization.ts，满足 API name pattern）。 */
export function normalizeNameForMCP(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** MCP 工具全限定名 mcp__<server>__<tool>（对齐 CC mcpStringUtils.ts:50）。 */
export function buildMcpToolName(server: string, tool: string): string {
  return `mcp__${normalizeNameForMCP(server)}__${normalizeNameForMCP(tool)}`
}

/** 展开 ${VAR} 与 ${VAR:-default}（对齐 CC envExpansion）。VAR 未设或空串时：有默认用默认，否则空串。 */
export function expandEnvVars(value: string, env: Record<string, string | undefined> = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g, (_m, name, hasDefault, def) => {
    const v = env[name]
    if (v !== undefined && v !== '') return v
    return hasDefault !== undefined ? def : ''
  })
}

/** MCP CallToolResult.content（block 数组）拍平成字符串（deepcode tool.call 返回 string）。 */
export function serializeContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : JSON.stringify(content)
  return content
    .map((b: any) => {
      if (b?.type === 'text') return b.text ?? ''
      if (b?.type === 'resource' && typeof b.resource?.text === 'string') return b.resource.text
      return JSON.stringify(b)
    })
    .join('\n')
}

/** MCP server 经 tools/list 返回的单个工具描述（只取我们用到的字段）。 */
export interface McpToolDef {
  name: string
  description?: string
  inputSchema?: object
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
}

/** 异步连接 MCP 并把工具 push 进既有 tools 数组（同一引用，后续 turn 的 deps.tools 自动可见）。返回 cleanup。 */
export async function attachMcpTools(
  tools: Tool[],
  servers: Record<string, McpStdioServerConfig> | undefined,
  onWarn?: (msg: string) => void,
): Promise<() => Promise<void>> {
  const { tools: mcpTools, cleanup } = await initMcpTools(servers, { onWarn })
  tools.push(...mcpTools)
  return cleanup
}

/** 调 MCP 工具所需的最小 client 接口（便于测试 mock；真实为 SDK Client）。 */
export interface McpCaller {
  callTool(
    args: { name: string; arguments: unknown },
    resultSchema?: unknown,
    opts?: { signal?: AbortSignal },
  ): Promise<{ content?: unknown; isError?: boolean }>
}

const DEFAULT_TOOL_TIMEOUT_MS = 120_000

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    p.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
  })
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000

export interface McpConnection {
  tools: Tool[]
  close: () => Promise<void>
}

/** 连接器：连一个 server 并返回其工具 + close。可注入便于测试。 */
export type McpConnector = (name: string, cfg: McpStdioServerConfig, timeoutMs: number) => Promise<McpConnection>

/** 默认连接器：spawn stdio 子进程，握手，listTools，wrap。 */
const defaultConnect: McpConnector = async (name, cfg, timeoutMs) => {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  if (cfg.env) for (const [k, v] of Object.entries(cfg.env)) env[k] = expandEnvVars(v, process.env)
  const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], env, stderr: 'pipe' })
  const client = new Client({ name: 'deepcode', version: '0' }, { capabilities: {} })
  await withTimeout(client.connect(transport), timeoutMs, `MCP ${name} 连接`)
  const listed = await withTimeout(client.listTools(), timeoutMs, `MCP ${name} listTools`)
  const tools = (listed.tools ?? []).map(t => wrapMcpTool(client as unknown as McpCaller, name, t as McpToolDef))
  return { tools, close: () => client.close() }
}

/** 连所有配置的 MCP server，聚合工具池。单 server 失败吞掉（onWarn），绝不让启动崩。返回 tools + cleanup。 */
export async function initMcpTools(
  servers: Record<string, McpStdioServerConfig> | undefined,
  opts: { connect?: McpConnector; connectTimeoutMs?: number; onWarn?: (msg: string) => void } = {},
): Promise<{ tools: Tool[]; cleanup: () => Promise<void> }> {
  const tools: Tool[] = []
  const closers: Array<() => Promise<void>> = []
  const connect = opts.connect ?? defaultConnect
  if (servers) {
    for (const [name, cfg] of Object.entries(servers)) {
      try {
        const conn = await connect(name, cfg, opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS)
        tools.push(...conn.tools)
        closers.push(conn.close)
      } catch (e) {
        opts.onWarn?.(`MCP server ${name} 连接失败，已跳过：${(e as Error).message}`)
      }
    }
  }
  return {
    tools,
    cleanup: async () => { for (const c of closers) { try { await c() } catch { /* 尽力关闭 */ } } },
  }
}

/** 把 MCP tool 包装成 deepcode Tool。call 用原始 tool 名路由回 server，JSON Schema 透传，校验交 server。 */
export function wrapMcpTool(
  client: McpCaller,
  serverName: string,
  mcpTool: McpToolDef,
  timeoutMs: number = DEFAULT_TOOL_TIMEOUT_MS,
): Tool {
  const isReadOnly = mcpTool.annotations?.readOnlyHint ?? false
  return {
    name: buildMcpToolName(serverName, mcpTool.name),
    description: mcpTool.description ?? '',
    inputSchema: z.object({}).passthrough(),
    rawJsonSchema: mcpTool.inputSchema ?? { type: 'object', properties: {} },
    isReadOnly,
    needsPermission: () => (isReadOnly ? false : `${serverName}: ${mcpTool.name}`),
    async call(input, ctx) {
      const result = await withTimeout(
        client.callTool({ name: mcpTool.name, arguments: input }, undefined, { signal: ctx.signal }),
        timeoutMs,
        `MCP ${serverName}.${mcpTool.name}`,
      )
      const text = serializeContent(result.content)
      if (result.isError) throw new Error(text || 'MCP 工具返回错误')
      return text
    },
  }
}
