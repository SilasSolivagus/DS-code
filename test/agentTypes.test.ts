import { describe, it, expect } from 'vitest'
import type { Tool } from '../src/tools/types.js'
import {
  resolveAgentTools,
  GLOBAL_SUBAGENT_DENY,
  BUILTIN_AGENTS,
  formatAgentLine,
  buildAgentDescription,
  type AgentDefinition,
} from '../src/tools/agentTypes.js'

// 极简假工具：只关心 name
const fake = (name: string): Tool<any> => ({
  name,
  description: '',
  inputSchema: {} as any,
  isReadOnly: false,
  needsPermission: () => false,
  call: async () => '',
})
const POOL = ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'Agent', 'WebFetch', 'NotebookEdit', 'ExitPlanMode'].map(fake)
const names = (ts: Tool<any>[]) => ts.map(t => t.name).sort()

const def = (over: Partial<AgentDefinition>): AgentDefinition => ({
  agentType: 't',
  whenToUse: 'w',
  getSystemPrompt: () => 'sp',
  ...over,
})

describe('resolveAgentTools', () => {
  it('通配（tools undefined）= 全池减全局 deny', () => {
    const r = resolveAgentTools(def({ tools: undefined }), POOL, GLOBAL_SUBAGENT_DENY)
    expect(names(r)).toEqual(['Bash', 'Glob', 'Grep', 'Read', 'WebFetch'])
  })

  it("通配（tools ['*']）= 全池减全局 deny", () => {
    const r = resolveAgentTools(def({ tools: ['*'] }), POOL, GLOBAL_SUBAGENT_DENY)
    expect(names(r)).toEqual(['Bash', 'Glob', 'Grep', 'Read', 'WebFetch'])
  })

  it('全局 deny 移除 Edit/Write/Agent/NotebookEdit/ExitPlanMode', () => {
    const r = resolveAgentTools(def({ tools: ['*'] }), POOL, GLOBAL_SUBAGENT_DENY)
    expect(r.find(t => t.name === 'Edit')).toBeUndefined()
    expect(r.find(t => t.name === 'Write')).toBeUndefined()
    expect(r.find(t => t.name === 'Agent')).toBeUndefined()
    expect(r.find(t => t.name === 'NotebookEdit')).toBeUndefined()
    expect(r.find(t => t.name === 'ExitPlanMode')).toBeUndefined()
  })

  it('类型 deny 叠加在全局 deny 之上', () => {
    const r = resolveAgentTools(def({ disallowedTools: ['Bash'] }), POOL, GLOBAL_SUBAGENT_DENY)
    expect(names(r)).toEqual(['Glob', 'Grep', 'Read', 'WebFetch'])
  })

  it('allow 列表按名查命中保留、未命中忽略', () => {
    const r = resolveAgentTools(def({ tools: ['Read', 'Grep', 'Nope'] }), POOL, GLOBAL_SUBAGENT_DENY)
    expect(names(r)).toEqual(['Grep', 'Read'])
  })

  it('deny 永远赢 allow：allow 含 Edit 也被全局 deny 排除', () => {
    const r = resolveAgentTools(def({ tools: ['Read', 'Edit'] }), POOL, GLOBAL_SUBAGENT_DENY)
    expect(names(r)).toEqual(['Read'])
  })

  it('deny 永远赢 allow：allow 含类型 deny 的项也被排除', () => {
    const r = resolveAgentTools(
      def({ tools: ['Read', 'Bash'], disallowedTools: ['Bash'] }),
      POOL,
      GLOBAL_SUBAGENT_DENY,
    )
    expect(names(r)).toEqual(['Read'])
  })
})

describe('BUILTIN_AGENTS', () => {
  it('共 3 个，agentType 唯一', () => {
    expect(BUILTIN_AGENTS.length).toBe(3)
    const types = BUILTIN_AGENTS.map(a => a.agentType)
    expect(new Set(types).size).toBe(3)
    expect(types).toContain('general-purpose')
    expect(types).toContain('Explore')
    expect(types).toContain('Plan')
  })

  it('每类 getSystemPrompt 返回非空', () => {
    for (const a of BUILTIN_AGENTS) expect(a.getSystemPrompt().length).toBeGreaterThan(0)
  })

  it('general-purpose 解析含 Bash，不含 Edit/Write/Agent/NotebookEdit/ExitPlanMode', () => {
    const a = BUILTIN_AGENTS.find(x => x.agentType === 'general-purpose')!
    const r = names(resolveAgentTools(a, POOL, GLOBAL_SUBAGENT_DENY))
    expect(r).toContain('Bash')
    expect(r).not.toContain('Edit')
    expect(r).not.toContain('Write')
    expect(r).not.toContain('Agent')
    expect(r).not.toContain('NotebookEdit')
    expect(r).not.toContain('ExitPlanMode')
  })

  it('Explore/Plan 解析不含 Edit/Write/Agent/NotebookEdit/ExitPlanMode', () => {
    for (const type of ['Explore', 'Plan']) {
      const a = BUILTIN_AGENTS.find(x => x.agentType === type)!
      const r = names(resolveAgentTools(a, POOL, GLOBAL_SUBAGENT_DENY))
      expect(r).not.toContain('Edit')
      expect(r).not.toContain('Write')
      expect(r).not.toContain('Agent')
      expect(r).not.toContain('NotebookEdit')
      expect(r).not.toContain('ExitPlanMode')
    }
  })
})

describe('formatAgentLine / buildAgentDescription', () => {
  it('仅 deny → All tools except X,Y', () => {
    const line = formatAgentLine(def({ agentType: 'Explore', whenToUse: 'w', disallowedTools: ['Edit', 'Write'] }))
    expect(line).toBe('- Explore: w (Tools: All tools except Edit,Write)')
  })

  it('有 allow 列表 → 列出名', () => {
    const line = formatAgentLine(def({ agentType: 'X', whenToUse: 'w', tools: ['Read', 'Grep'] }))
    expect(line).toBe('- X: w (Tools: Read,Grep)')
  })

  it('通配（undefined）→ All tools', () => {
    const line = formatAgentLine(def({ agentType: 'X', whenToUse: 'w' }))
    expect(line).toBe('- X: w (Tools: All tools)')
  })

  it("通配（['*']）→ All tools", () => {
    const line = formatAgentLine(def({ agentType: 'X', whenToUse: 'w', tools: ['*'] }))
    expect(line).toBe('- X: w (Tools: All tools)')
  })

  it('完整描述含三类型名 + 默认句', () => {
    const d = buildAgentDescription()
    expect(d).toContain('general-purpose')
    expect(d).toContain('Explore')
    expect(d).toContain('Plan')
    expect(d).toContain('(Tools:')
    expect(d).toContain('省略 subagent_type 则用 general-purpose')
  })

  it('buildAgentDescription 接受 agents 参数，含自定义行', () => {
    const custom = { agentType: 'x-agent', whenToUse: '干 X', disallowedTools: ['Edit', 'Write', 'Agent'], getSystemPrompt: () => 'p' }
    const desc = buildAgentDescription([custom as any])
    expect(desc).toContain('x-agent: 干 X')
  })

  it('buildAgentDescription 末尾含子代理并行提示', () => {
    const d = buildAgentDescription()
    expect(d).toContain('子代理')
    expect(d).toContain('并行委派')
  })
})
