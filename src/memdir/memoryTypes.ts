export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference'] as const

export function isMemoryType(s: unknown): s is MemoryType {
  return typeof s === 'string' && (MEMORY_TYPES as readonly string[]).includes(s)
}

/** 提取/合并 prompt 引用：四类记忆语义。对齐 CC memoryTypes。 */
export const MEMORY_TYPE_GUIDE = `记忆分四类（frontmatter \`type\` 字段）：
- user：关于用户的事实（角色、专长、长期偏好）。
- feedback：用户对你工作方式的指导（纠正或确认的做法）；正文跟 **Why:** 与 **How to apply:** 行。
- project：当前工作的目标/约束/决策（会快速过期；相对日期转绝对）。
- reference：外部资源指针（URL、仪表盘、工单）。`
