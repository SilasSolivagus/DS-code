// src/mcp.ts —— MCP 客户端（stdio-first，对齐 CC services/mcp）
// 架构铁律：本模块不反向 import loop/useChat/headless。

/** 非 [a-zA-Z0-9_-] 字符替换为 '_'（对齐 CC normalization.ts，满足 API name pattern）。 */
export function normalizeNameForMCP(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** MCP 工具全限定名 mcp__<server>__<tool>（对齐 CC mcpStringUtils.ts:50）。 */
export function buildMcpToolName(server: string, tool: string): string {
  return `mcp__${normalizeNameForMCP(server)}__${normalizeNameForMCP(tool)}`
}
