// test/promptSections.test.ts
import { describe, it, expect } from 'vitest'
import { SYSTEM_SECTION, DOING_TASKS_SECTION, TOOLS_SECTION } from '../src/prompt.js'

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
