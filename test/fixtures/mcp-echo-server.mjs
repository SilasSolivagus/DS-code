// 最小 stdio MCP server：暴露一个 echo 工具（readOnly）。用 SDK 的 server 实现。
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'echo', version: '0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'echo',
    description: '回显输入',
    inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
    annotations: { readOnlyHint: true },
  }],
}))
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: 'text', text: `echo: ${req.params.arguments?.msg ?? ''}` }],
}))
await server.connect(new StdioServerTransport())
