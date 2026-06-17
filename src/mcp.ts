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

/** 展开 ${VAR} 与 ${VAR:-default}（对齐 CC envExpansion）。VAR 未设或空串时：有默认用默认，否则空串。 */
export function expandEnvVars(value: string, env: Record<string, string | undefined> = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g, (_m, name, hasDefault, def) => {
    const v = env[name]
    if (v !== undefined && v !== '') return v
    return hasDefault !== undefined ? def : ''
  })
}
