# MCP 客户端（L-022）stdio-first Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 deepcode 连 stdio MCP server，发现其 tools 并注入工具池，模型可调用、结果回注；用官方 `@modelcontextprotocol/sdk`（CC 同款）。

**Architecture:** 新模块 `src/mcp.ts` 承载全部逻辑（纯函数 + wrapMcpTool + initMcpTools，连接器可注入便于测试）；`Tool` 加 `rawJsonSchema?` 让 MCP 的 JSON Schema 透传过 `toApiTools`；`config.ts` 加 `mcpServers` 字段；`headless.ts`/`useChat.ts` 异步注入工具池并在退出时 cleanup。失败容错全在 `initMcpTools` 内吞掉，绝不让启动崩。

**Tech Stack:** TypeScript/ESM、`@modelcontextprotocol/sdk`、zod、vitest。

**对齐依据：** spec `docs/specs/2026-06-17-deepcode-l022-mcp-stdio-design.md`；CC 源码 `services/mcp/`（命名 `mcp__server__tool`、JSON Schema 透传、`annotations.readOnlyHint` 判只读、单 server 失败吞掉）。

**架构铁律：** `mcp.ts` 不反向 import loop/useChat/headless；由它们调用并注入。

---

### Task 1: 装依赖 + 模块骨架与命名纯函数

**Files:**
- Modify: `package.json`（deps 加 `@modelcontextprotocol/sdk`）
- Create: `src/mcp.ts`
- Test: `test/mcp.test.ts`

- [ ] **Step 1: 装 SDK**

Run: `cd /Users/silas/loop/deepcode && npm i @modelcontextprotocol/sdk`
Expected: package.json dependencies 出现 `@modelcontextprotocol/sdk`，`npm install` 成功。

- [ ] **Step 2: 写失败测试（命名归一化）**

Create `test/mcp.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { normalizeNameForMCP, buildMcpToolName } from '../src/mcp.js'

describe('normalizeNameForMCP', () => {
  it('保留合法字符，非法字符替换为下划线', () => {
    expect(normalizeNameForMCP('git_diff-tool')).toBe('git_diff-tool')
    expect(normalizeNameForMCP('my server.v2')).toBe('my_server_v2')
    expect(normalizeNameForMCP('a/b:c')).toBe('a_b_c')
  })
})

describe('buildMcpToolName', () => {
  it('拼成 mcp__<server>__<tool> 并各自归一化', () => {
    expect(buildMcpToolName('github', 'create_issue')).toBe('mcp__github__create_issue')
    expect(buildMcpToolName('my server', 'do.it')).toBe('mcp__my_server__do_it')
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/mcp.test.ts`
Expected: FAIL（`src/mcp.js` 不存在 / 导出未定义）。

- [ ] **Step 4: 写最小实现**

Create `src/mcp.ts`:

```ts
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
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/mcp.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
cd /Users/silas/loop/deepcode
git add package.json package-lock.json src/mcp.ts test/mcp.test.ts
git commit -m "feat(mcp): add @modelcontextprotocol/sdk + MCP tool naming helpers"
```

---

### Task 2: 环境变量展开 expandEnvVars

**Files:**
- Modify: `src/mcp.ts`
- Test: `test/mcp.test.ts`

- [ ] **Step 1: 写失败测试**

Append to `test/mcp.test.ts`:

```ts
import { expandEnvVars } from '../src/mcp.js'

describe('expandEnvVars', () => {
  const env = { FOO: 'bar', EMPTY: '' }
  it('${VAR} 展开为值，未设则空串', () => {
    expect(expandEnvVars('x=${FOO}', env)).toBe('x=bar')
    expect(expandEnvVars('x=${MISSING}', env)).toBe('x=')
  })
  it('${VAR:-default} 在未设或空时用默认', () => {
    expect(expandEnvVars('${MISSING:-fallback}', env)).toBe('fallback')
    expect(expandEnvVars('${EMPTY:-fallback}', env)).toBe('fallback')
    expect(expandEnvVars('${FOO:-fallback}', env)).toBe('bar')
  })
  it('多处展开与无占位原样', () => {
    expect(expandEnvVars('${FOO}/${FOO}', env)).toBe('bar/bar')
    expect(expandEnvVars('plain text', env)).toBe('plain text')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/mcp.test.ts`
Expected: FAIL（`expandEnvVars` 未定义）。

- [ ] **Step 3: 写最小实现**

Append to `src/mcp.ts`:

```ts
/** 展开 ${VAR} 与 ${VAR:-default}（对齐 CC envExpansion）。VAR 未设或空串时：有默认用默认，否则空串。 */
export function expandEnvVars(value: string, env: Record<string, string | undefined> = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g, (_m, name, hasDefault, def) => {
    const v = env[name]
    if (v !== undefined && v !== '') return v
    return hasDefault !== undefined ? def : ''
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/mcp.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd /Users/silas/loop/deepcode
git add src/mcp.ts test/mcp.test.ts
git commit -m "feat(mcp): add expandEnvVars for ${VAR} / ${VAR:-default}"
```

---

### Task 3: Settings.mcpServers 配置字段 + 宽松解析

**Files:**
- Modify: `src/config.ts:7-23`（接口）、`src/config.ts:39-56`（loadSettings）
- Test: `test/config.mcp.test.ts`

- [ ] **Step 1: 写失败测试**

Create `test/config.mcp.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseMcpServers } from '../src/config.js'

describe('parseMcpServers', () => {
  it('保留含 string command 的条目，归一字段', () => {
    const out = parseMcpServers({
      git: { command: 'uvx', args: ['mcp-server-git'], env: { TOKEN: 'x' } },
    })
    expect(out).toEqual({ git: { command: 'uvx', args: ['mcp-server-git'], env: { TOKEN: 'x' } } })
  })
  it('丢弃无 command / 非对象 / 非法 args 的条目', () => {
    const out = parseMcpServers({
      bad1: { args: ['x'] },          // 无 command
      bad2: 'nope',                   // 非对象
      ok: { command: 'node', args: ['s.js', 1] }, // args 过滤掉非字符串
    })
    expect(out).toEqual({ ok: { command: 'node', args: ['s.js'], env: undefined } })
  })
  it('空输入返回 undefined', () => {
    expect(parseMcpServers(undefined)).toBeUndefined()
    expect(parseMcpServers({})).toBeUndefined()
    expect(parseMcpServers([])).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/config.mcp.test.ts`
Expected: FAIL（`parseMcpServers` 未导出）。

- [ ] **Step 3: 写实现**

In `src/config.ts`，给 `Settings` 接口（行 7-23 内）在 `hooks?` 后加：

```ts
  /** MCP server 配置（stdio）。键=server 名，值=启动方式。env DEEPSEEK_* 不在此。 */
  mcpServers?: Record<string, McpStdioServerConfig>
```

在 `Settings` 接口上方加类型：

```ts
export interface McpStdioServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}
```

在 `loadSettings` 的返回对象里（行 54 `hooks:` 后）加：

```ts
    mcpServers: parseMcpServers(raw?.mcpServers),
```

在 `parseHooksConfig` 函数后加新函数：

```ts
/** 宽松解析 settings.mcpServers：只留 command 为非空字符串的条目；args 过滤非字符串；env 须为对象。 */
export function parseMcpServers(raw: unknown): Record<string, McpStdioServerConfig> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, McpStdioServerConfig> = {}
  for (const [name, cfg] of Object.entries(raw as Record<string, unknown>)) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue
    const c = cfg as Record<string, unknown>
    if (typeof c.command !== 'string' || !c.command) continue
    out[name] = {
      command: c.command,
      args: Array.isArray(c.args) ? (c.args.filter(a => typeof a === 'string') as string[]) : undefined,
      env: c.env && typeof c.env === 'object' && !Array.isArray(c.env) ? (c.env as Record<string, string>) : undefined,
    }
  }
  return Object.keys(out).length ? out : undefined
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/config.mcp.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd /Users/silas/loop/deepcode
git add src/config.ts test/config.mcp.test.ts
git commit -m "feat(mcp): add Settings.mcpServers config field + parseMcpServers"
```

---

### Task 4: Tool.rawJsonSchema + toApiTools 透传

**Files:**
- Modify: `src/tools/types.ts:26-35`、`src/tools/index.ts:13-22`
- Test: `test/toApiTools.test.ts`

- [ ] **Step 1: 写失败测试**

Create `test/toApiTools.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { toApiTools } from '../src/tools/index.js'
import type { Tool } from '../src/tools/types.js'

describe('toApiTools rawJsonSchema 透传', () => {
  it('有 rawJsonSchema 时直接用它，不走 zodToJsonSchema', () => {
    const raw = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] }
    const tool: Tool = {
      name: 'mcp__s__t', description: 'd', inputSchema: z.object({}).passthrough(),
      rawJsonSchema: raw, isReadOnly: true, needsPermission: () => false, call: async () => 'ok',
    }
    expect(toApiTools([tool])[0].function.parameters).toEqual(raw)
  })
  it('无 rawJsonSchema 时仍走 zodToJsonSchema', () => {
    const tool: Tool = {
      name: 'X', description: 'd', inputSchema: z.object({ a: z.string() }),
      isReadOnly: true, needsPermission: () => false, call: async () => 'ok',
    }
    const params = toApiTools([tool])[0].function.parameters as any
    expect(params.type).toBe('object')
    expect(params.properties.a).toBeDefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/toApiTools.test.ts`
Expected: FAIL（`rawJsonSchema` 不是 Tool 合法字段 / parameters 不等于 raw）。

- [ ] **Step 3: 写实现**

In `src/tools/types.ts`，`Tool` 接口里 `inputSchema: S` 后加：

```ts
  /** MCP 工具：直接透传 server 给的 JSON Schema；toApiTools 优先用它，跳过 zodToJsonSchema。 */
  rawJsonSchema?: object
```

In `src/tools/index.ts`，把 `parameters:` 行改为：

```ts
      parameters: t.rawJsonSchema ?? zodToJsonSchema(t.inputSchema, { $refStrategy: 'none' }),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/toApiTools.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd /Users/silas/loop/deepcode
git add src/tools/types.ts src/tools/index.ts test/toApiTools.test.ts
git commit -m "feat(mcp): Tool.rawJsonSchema passthrough in toApiTools"
```

---

### Task 5: serializeContent（MCP content blocks → 文本）

**Files:**
- Modify: `src/mcp.ts`
- Test: `test/mcp.test.ts`

- [ ] **Step 1: 写失败测试**

Append to `test/mcp.test.ts`:

```ts
import { serializeContent } from '../src/mcp.js'

describe('serializeContent', () => {
  it('text block 取 text', () => {
    expect(serializeContent([{ type: 'text', text: 'hello' }])).toBe('hello')
  })
  it('多 block 用换行连接', () => {
    expect(serializeContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb')
  })
  it('resource block 取内嵌 text', () => {
    expect(serializeContent([{ type: 'resource', resource: { uri: 'x', text: 'rt' } }])).toBe('rt')
  })
  it('未知 block 序列化为 JSON', () => {
    expect(serializeContent([{ type: 'image', data: 'b64' }])).toBe('{"type":"image","data":"b64"}')
  })
  it('非数组兜底', () => {
    expect(serializeContent('raw')).toBe('raw')
    expect(serializeContent({ a: 1 })).toBe('{"a":1}')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/mcp.test.ts`
Expected: FAIL（`serializeContent` 未定义）。

- [ ] **Step 3: 写实现**

Append to `src/mcp.ts`:

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/mcp.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd /Users/silas/loop/deepcode
git add src/mcp.ts test/mcp.test.ts
git commit -m "feat(mcp): serializeContent for MCP content blocks"
```

---

### Task 6: wrapMcpTool（MCP tool → deepcode Tool）

**Files:**
- Modify: `src/mcp.ts`
- Test: `test/mcp.test.ts`

- [ ] **Step 1: 写失败测试（用 mock client）**

Append to `test/mcp.test.ts`:

```ts
import { z } from 'zod'
import { wrapMcpTool } from '../src/mcp.js'
import type { ToolContext } from '../src/tools/types.js'

const ctx = { signal: new AbortController().signal } as unknown as ToolContext

describe('wrapMcpTool', () => {
  const mcpTool = {
    name: 'create_issue',
    description: '创建 issue',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    annotations: { readOnlyHint: false },
  }

  it('名/描述/schema 透传，非只读需权限', () => {
    const client = { callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }
    const t = wrapMcpTool(client as any, 'github', mcpTool as any)
    expect(t.name).toBe('mcp__github__create_issue')
    expect(t.description).toBe('创建 issue')
    expect(t.rawJsonSchema).toEqual(mcpTool.inputSchema)
    expect(t.isReadOnly).toBe(false)
    expect(t.needsPermission({})).toBe('github: create_issue')
  })

  it('readOnlyHint=true → 只读、免权限', () => {
    const client = { callTool: async () => ({ content: [] }) }
    const t = wrapMcpTool(client as any, 'github', { ...mcpTool, annotations: { readOnlyHint: true } } as any)
    expect(t.isReadOnly).toBe(true)
    expect(t.needsPermission({})).toBe(false)
  })

  it('call 用原始 tool 名路由，序列化 content', async () => {
    let received: any
    const client = { callTool: async (a: any) => { received = a; return { content: [{ type: 'text', text: 'done' }] } } }
    const t = wrapMcpTool(client as any, 'github', mcpTool as any)
    const out = await t.call({ title: 'x' }, ctx)
    expect(received.name).toBe('create_issue') // 非前缀名
    expect(received.arguments).toEqual({ title: 'x' })
    expect(out).toBe('done')
  })

  it('isError=true → 抛错', async () => {
    const client = { callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }) }
    const t = wrapMcpTool(client as any, 'github', mcpTool as any)
    await expect(t.call({}, ctx)).rejects.toThrow('boom')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/mcp.test.ts`
Expected: FAIL（`wrapMcpTool` 未定义）。

- [ ] **Step 3: 写实现**

Append to `src/mcp.ts`（顶部加 import）：

```ts
import { z } from 'zod'
import type { Tool } from './tools/types.js'

/** MCP server 经 tools/list 返回的单个工具描述（只取我们用到的字段）。 */
export interface McpToolDef {
  name: string
  description?: string
  inputSchema?: object
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/mcp.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd /Users/silas/loop/deepcode
git add src/mcp.ts test/mcp.test.ts
git commit -m "feat(mcp): wrapMcpTool wraps MCP tool as deepcode Tool"
```

---

### Task 7: initMcpTools（连接编排 + 失败容错 + cleanup）

**Files:**
- Modify: `src/mcp.ts`
- Test: `test/mcp.test.ts`

- [ ] **Step 1: 写失败测试（注入 fake connector）**

Append to `test/mcp.test.ts`:

```ts
import { initMcpTools } from '../src/mcp.js'

describe('initMcpTools', () => {
  const servers = {
    good: { command: 'x' },
    bad: { command: 'y' },
  }

  it('聚合成功 server 的工具，跳过失败 server，记录警告', async () => {
    const warns: string[] = []
    const fakeTool = { name: 'mcp__good__t' } as any
    const { tools, cleanup } = await initMcpTools(servers, {
      connect: async (name) => {
        if (name === 'bad') throw new Error('spawn ENOENT')
        return { tools: [fakeTool], close: async () => {} }
      },
      onWarn: m => warns.push(m),
    })
    expect(tools).toEqual([fakeTool])
    expect(warns.some(w => w.includes('bad') && w.includes('spawn ENOENT'))).toBe(true)
    await cleanup()
  })

  it('cleanup 调用每个成功连接的 close', async () => {
    let closed = 0
    const { cleanup } = await initMcpTools({ a: { command: 'x' }, b: { command: 'y' } }, {
      connect: async () => ({ tools: [], close: async () => { closed++ } }),
    })
    await cleanup()
    expect(closed).toBe(2)
  })

  it('无配置返回空工具与 no-op cleanup', async () => {
    const { tools, cleanup } = await initMcpTools(undefined, {})
    expect(tools).toEqual([])
    await expect(cleanup()).resolves.toBeUndefined()
  })

  it('cleanup 单个 close 抛错不影响其它', async () => {
    let closedB = false
    const { cleanup } = await initMcpTools({ a: { command: 'x' }, b: { command: 'y' } }, {
      connect: async (name) => ({
        tools: [],
        close: async () => { if (name === 'a') throw new Error('x'); closedB = true },
      }),
    })
    await expect(cleanup()).resolves.toBeUndefined()
    expect(closedB).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/mcp.test.ts`
Expected: FAIL（`initMcpTools` 未定义）。

- [ ] **Step 3: 写实现**

Append to `src/mcp.ts`（顶部加 SDK import）：

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpStdioServerConfig } from './config.js'

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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/mcp.test.ts`
Expected: PASS。

- [ ] **Step 5: typecheck + build**

Run: `cd /Users/silas/loop/deepcode && npm run typecheck && npm run build`
Expected: 干净通过（确认 SDK 类型 import 正确）。

- [ ] **Step 6: 提交**

```bash
cd /Users/silas/loop/deepcode
git add src/mcp.ts test/mcp.test.ts
git commit -m "feat(mcp): initMcpTools connect orchestration with failure tolerance + cleanup"
```

---

### Task 8: 集成测试（真·stdio MCP echo server fixture）

**Files:**
- Create: `test/fixtures/mcp-echo-server.mjs`
- Test: `test/mcp.integration.test.ts`

- [ ] **Step 1: 写一个最小 stdio MCP server fixture**

Create `test/fixtures/mcp-echo-server.mjs`:

```js
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
```

- [ ] **Step 2: 写集成测试**

Create `test/mcp.integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initMcpTools } from '../src/mcp.js'
import type { ToolContext } from '../src/tools/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, 'fixtures', 'mcp-echo-server.mjs')
const ctx = { signal: new AbortController().signal } as unknown as ToolContext

describe('MCP stdio 集成（真子进程）', () => {
  it('连真 echo server，发现工具并调用', async () => {
    const { tools, cleanup } = await initMcpTools({ echo: { command: process.execPath, args: [fixture] } })
    try {
      const echo = tools.find(t => t.name === 'mcp__echo__echo')
      expect(echo).toBeDefined()
      expect(echo!.isReadOnly).toBe(true)
      const out = await echo!.call({ msg: 'hi' }, ctx)
      expect(out).toBe('echo: hi')
    } finally {
      await cleanup()
    }
  }, 20_000)

  it('命令不存在的 server 被跳过、不抛', async () => {
    const warns: string[] = []
    const { tools, cleanup } = await initMcpTools(
      { nope: { command: 'definitely-not-a-real-binary-xyz' } },
      { onWarn: m => warns.push(m) },
    )
    expect(tools).toEqual([])
    expect(warns.length).toBe(1)
    await cleanup()
  }, 20_000)
})
```

- [ ] **Step 3: 跑集成测试**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/mcp.integration.test.ts`
Expected: PASS（真子进程 echo 往返）。若现已知 EPIPE flaky 出现：vitest exit 0、不计失败即可接受（见 spec §4）。

- [ ] **Step 4: 提交**

```bash
cd /Users/silas/loop/deepcode
git add test/fixtures/mcp-echo-server.mjs test/mcp.integration.test.ts
git commit -m "test(mcp): stdio integration test with real echo MCP server fixture"
```

---

### Task 9: 接线 headless（异步注入工具池 + cleanup）

**Files:**
- Modify: `src/headless.ts`（import + tools 数组 + 退出 cleanup）
- Test: `test/headless.mcp.test.ts`

- [ ] **Step 1: 写失败测试（验证 headless 注入 MCP 工具）**

先读 `src/headless.ts` 顶部确认导出函数名与签名（如 `runHeadless`），测试用 mock client 跑一轮、断言 settings.mcpServers 配置时 MCP 工具进入 tools。若 headless 难以单测工具池，改为断言 `initMcpTools` 在 headless 路径被调用（spy）。Create `test/headless.mcp.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import * as mcp from '../src/mcp.js'

describe('headless MCP 注入', () => {
  it('配置 mcpServers 时 headless 调 initMcpTools 并在结束 cleanup', async () => {
    const cleanup = vi.fn(async () => {})
    const spy = vi.spyOn(mcp, 'initMcpTools').mockResolvedValue({ tools: [], cleanup })
    // 触发一次最小 headless 运行（按 headless.ts 实际签名补齐 mock client/settings）。
    // 断言：
    expect(spy).toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalled()
    spy.mockRestore()
  })
})
```

> 实现者注：按 `src/headless.ts` 真实签名补齐这条测试的运行参数（mock loadSettings 注入 `mcpServers`、mock client 让 runLoop 立即结束）。参考 `test/headless.test.ts` 既有 mock 写法。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/headless.mcp.test.ts`
Expected: FAIL（headless 尚未调 initMcpTools）。

- [ ] **Step 3: 写实现**

In `src/headless.ts`：
1. 顶部 import：`import { initMcpTools } from './mcp.js'`
2. 在构造 runLoop 的 tools 数组（行 ~91）之前 await 初始化：

```ts
  const { tools: mcpTools, cleanup: mcpCleanup } = await initMcpTools(settings.mcpServers, {
    onWarn: msg => process.stderr.write(msg + '\n'),
  })
```

3. 把 `mcpTools` 并进 runLoop 的 `tools: [...]`（行 91）末尾：`..., taskStopTool, ...mcpTools]`
4. 在函数返回前（finally 或 return 之前）调用 `await mcpCleanup()`。

- [ ] **Step 4: 跑测试 + 全量回归**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/headless.mcp.test.ts && npm run typecheck`
Expected: PASS + typecheck 干净。

- [ ] **Step 5: 提交**

```bash
cd /Users/silas/loop/deepcode
git add src/headless.ts test/headless.mcp.test.ts
git commit -m "feat(mcp): wire MCP tools into headless with cleanup"
```

---

### Task 10: 接线 useChat（异步注入 + dispose cleanup）

**Files:**
- Modify: `src/tui/useChat.ts`（import + tools 数组改可变 + 异步 push + dispose cleanup）
- Test: 见 Step 1（轻量 spy，或纳入 headless 同款 spy 思路）

- [ ] **Step 1: 写测试（spy initMcpTools 在 useChat 初始化被调）**

按 `src/tui/useChat.ts` 的初始化结构补一条测试：mock `initMcpTools` 返回若干工具，断言初始化后 `tools` 数组包含这些工具、dispose 时 cleanup 被调。若 useChat 作为 React hook 难直接测，则提取注入逻辑为一个可测的小函数（如 `attachMcpTools(toolsArray, settings, onWarn)`）并单测它。Create `test/useChat.mcp.test.ts`，参考既有 `test/headless.test.ts` mock 风格。

> 实现者注：useChat 是 hook，优先做法 = 把「连接并 push 进 tools 数组 + 返回 cleanup」抽成 `src/mcp.ts` 不依赖 React 的 `attachMcpTools(tools: Tool[], settings, onWarn?)`，useChat 调它即可。这样可单测且不碰 React。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/silas/loop/deepcode && npx vitest run test/useChat.mcp.test.ts`
Expected: FAIL。

- [ ] **Step 3: 写实现**

In `src/mcp.ts` 加可测注入助手：

```ts
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
```

In `src/tui/useChat.ts`：
1. import：`import { attachMcpTools } from '../mcp.js'`
2. `const tools = [...]`（行 360-377）保持 const（数组可变，引用稳定，被每轮 deps.tools 复用）。
3. 在 useChat 的初始化副作用里（与 SessionStart 同处的 init effect）：

```ts
  let mcpCleanup: (() => Promise<void>) | null = null
  void attachMcpTools(tools, settings.mcpServers, msg => notice('warn', msg)).then(cleanup => {
    mcpCleanup = cleanup
    setState() // 工具更新后刷新（如状态行显示工具数）
  }).catch(() => {})
```

4. 在 dispose/退出路径（SessionEnd/installTaskCleanup 同处）加：`void mcpCleanup?.()`

> 实现者注：精确插入点按 useChat 实际 init/dispose 结构定；保持「未配 mcpServers 时零额外开销」——`attachMcpTools(undefined)` 内 initMcpTools 立即返回空，无 spawn。

- [ ] **Step 4: 跑测试 + 全量回归 + typecheck + build**

Run: `cd /Users/silas/loop/deepcode && npm test && npm run typecheck && npm run build`
Expected: 全绿（注意已知 EPIPE flaky：vitest exit 0、不计失败即可接受）。

- [ ] **Step 5: 提交**

```bash
cd /Users/silas/loop/deepcode
git add src/mcp.ts src/tui/useChat.ts test/useChat.mcp.test.ts
git commit -m "feat(mcp): wire MCP tools into useChat via attachMcpTools with dispose cleanup"
```

---

### Task 11: 文档 + 全量验收

**Files:**
- Modify: `README` 或 `docs/`（MCP 配置说明，若项目有用户文档）
- Modify: `docs/specs/2026-06-17-deepcode-cc-full-parity-master-roadmap.md`（把 #1.1 标 ✅）

- [ ] **Step 1: 写 MCP 配置用法（settings.json 示例）**

在项目用户文档（README 或 docs）加一段：

```jsonc
// ~/.deepcode/settings.json
{
  "mcpServers": {
    "git": { "command": "uvx", "args": ["mcp-server-git", "--repository", "."] },
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } }
  }
}
```

说明：工具以 `mcp__<server>__<tool>` 名出现；只读工具（server 标 readOnlyHint）免权限确认；连接失败的 server 静默跳过。

- [ ] **Step 2: master roadmap 标完成**

把 master roadmap 第 1 层 #1.1 行状态由 ⬜ 改 ✅，并在 spec §5 后续增量保留未做项。

- [ ] **Step 3: 全量验收**

Run: `cd /Users/silas/loop/deepcode && npm test && npm run typecheck && npm run build`
Expected: 全绿。

- [ ] **Step 4: 提交**

```bash
cd /Users/silas/loop/deepcode
git add -A
git commit -m "docs(mcp): MCP server config usage + mark roadmap 1.1 done"
```

---

## Self-Review

**Spec 覆盖：** stdio 连接(T7/T8)、配置+env展开(T2/T3)、工具发现与注入命名/schema透传/只读/调用路由(T1/T4/T5/T6)、两注入点(T9/T10)、容错+超时+cleanup(T6/T7)、权限走现有通道(T6 needsPermission)。spec「MVP 不做」项（认证/http-sse/资源/审批/agent级mcpServers/重连）均未进任务 ✓。

**Placeholder 扫描：** T9/T10 留了「按实际签名补齐」的实现者注（headless/useChat 真实结构需实现时读文件确认），非占位逃避——核心代码（mcp.ts 全量、config、types、index）均给了完整可粘贴实现；接线点给了精确文件+行+插入代码。

**类型一致性：** `McpStdioServerConfig`(config.ts 定义，mcp.ts import)、`Tool.rawJsonSchema`(T4 定义，T6 使用)、`McpCaller`/`McpToolDef`/`McpConnector`/`McpConnection`(mcp.ts 内一致)、`initMcpTools`/`attachMcpTools`/`wrapMcpTool`/`serializeContent`/`buildMcpToolName`/`expandEnvVars`/`parseMcpServers` 跨任务命名一致 ✓。`withTimeout`(T6 定义，T7 复用) ✓。

**已知风险：** 接线两任务(T9/T10)是 React hook / async 入口，单测较难——计划已给「抽成不依赖 React 的 attachMcpTools/纯函数后单测」的降风险路径。SDK 真实 API 形状(client.listTools/callTool/connect)以实现时 `node_modules/@modelcontextprotocol/sdk` 类型为准，若与计划签名有出入，按真实类型微调 wrapMcpTool 的 McpCaller。
