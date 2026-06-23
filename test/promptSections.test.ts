// test/promptSections.test.ts
import { describe, it, expect } from 'vitest'
import { SYSTEM_SECTION, DOING_TASKS_SECTION, TOOLS_SECTION, CARE_SECTION, TONE_SECTION } from '../src/prompt.js'

describe('SYSTEM_SECTION', () => {
  it('以 # 系统 标题开头', () => {
    expect(SYSTEM_SECTION.startsWith('# 系统')).toBe(true)
  })
  it('含 prompt injection 上报规则', () => {
    expect(SYSTEM_SECTION).toContain('prompt injection')
  })
  it('含 <system-reminder> 不权威规则', () => {
    expect(SYSTEM_SECTION).toContain('<system-reminder>')
  })
  it('含「拒绝后不重试同一调用」规则', () => {
    expect(SYSTEM_SECTION).toContain('不要重试完全相同的调用')
  })
})

describe('DOING_TASKS_SECTION', () => {
  it('以 # 干活 开头', () => {
    expect(DOING_TASKS_SECTION.startsWith('# 干活')).toBe(true)
  })
  it('保留 deepcode 强项：验证产物能用再报完成', () => {
    expect(DOING_TASKS_SECTION).toContain('报告完成前先实际验证')
  })
  it('保留 deepcode 强项：如实汇报不暗示成功', () => {
    expect(DOING_TASKS_SECTION).toContain('不要假装成功')
  })
  it('含新规则：别给时间估算', () => {
    expect(DOING_TASKS_SECTION).toContain('时间估算')
  })
  it('含新规则：被卡别反复重试', () => {
    expect(DOING_TASKS_SECTION).toContain('换路子')
  })
  it('含新规则：别对没读过的代码提改动建议', () => {
    expect(DOING_TASKS_SECTION).toContain('没读过')
  })
  it('含新规则：OWASP 安全', () => {
    expect(DOING_TASKS_SECTION).toContain('OWASP')
  })
  it('含极简：别给没改的代码加注释/类型', () => {
    expect(DOING_TASKS_SECTION).toContain('没改动的代码')
  })
  it('不再含 HTML 优于 curses 偏好', () => {
    expect(DOING_TASKS_SECTION).not.toContain('HTML')
    expect(DOING_TASKS_SECTION).not.toContain('curses')
  })
})

describe('TOOLS_SECTION', () => {
  it('以 # 用好工具 开头', () => {
    expect(TOOLS_SECTION.startsWith('# 用好工具')).toBe(true)
  })
  it('含并行只读调用规则', () => {
    expect(TOOLS_SECTION).toContain('并行')
  })
  it('含完整工具路由（Edit 不 sed/Write 不 heredoc）', () => {
    expect(TOOLS_SECTION).toContain('sed')
    expect(TOOLS_SECTION).toContain('heredoc')
  })
  it('含子代理别重复干活', () => {
    expect(TOOLS_SECTION).toContain('子代理')
  })
})

describe('CARE_SECTION', () => {
  it('以 # 谨慎执行破坏性动作 开头', () => {
    expect(CARE_SECTION.startsWith('# 谨慎执行破坏性动作')).toBe(true)
  })
  it('含可逆性/影响范围核心概念', () => {
    expect(CARE_SECTION).toContain('可逆性')
    expect(CARE_SECTION).toContain('影响范围')
  })
  it('含授权范围规则（一次批准≠永久）', () => {
    expect(CARE_SECTION).toContain('一次')
    expect(CARE_SECTION).toContain('范围')
  })
  it('含三类破坏性例子（rm -rf / force-push / 发消息）', () => {
    expect(CARE_SECTION).toContain('rm -rf')
    expect(CARE_SECTION).toContain('force-push')
  })
  it('含「别用破坏性动作走捷径」+ 意外状态先调查', () => {
    expect(CARE_SECTION).toContain('--no-verify')
    expect(CARE_SECTION).toContain('调查')
  })
})

describe('TONE_SECTION', () => {
  it('以 # 语气与风格 开头', () => {
    expect(TONE_SECTION.startsWith('# 语气与风格')).toBe(true)
  })
  it('含 file:line 引用规则', () => {
    expect(TONE_SECTION).toContain('src/loop.ts:42')
  })
  it('含「先给答案再给理由」', () => {
    expect(TONE_SECTION).toContain('先给答案')
  })
  it('含不用 emoji 规则', () => {
    expect(TONE_SECTION).toContain('emoji')
  })
})
