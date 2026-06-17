// src/tools/structuredOutput.ts —— L-044 结构化输出强约束的共享原语。
// 对齐 CC SyntheticOutputTool（工具名 StructuredOutput、重试上限 5），宿主适配为 zod 校验。
// 强约束循环本身内联在调用方（agent.ts runSub / hookRuntime.ts runAgent），本模块只提供工具工厂 + 常量。
import type { z } from 'zod'
import type { Tool } from './types.js'

export const STRUCTURED_OUTPUT_TOOL_NAME = 'StructuredOutput'
export const MAX_STRUCTURED_OUTPUT_RETRIES = 5 // 对齐 CC MAX_STRUCTURED_OUTPUT_RETRIES 默认值

/** 子代理未调 StructuredOutput 就想结束时，注入此提醒强制重试。 */
export function structuredOutputReminder(): string {
  return `你必须调用 ${STRUCTURED_OUTPUT_TOOL_NAME} 工具，按要求的结构返回最终答案。现在就调用它。`
}

/** StructuredOutput 工具工厂：按给定 zod schema 校验入参，成功经 onValid 捕获规范化对象。
 *  仅在声明了 outputSchema 的子代理/agent-hook 工具池里动态注入（不进全局池）。 */
export function makeStructuredOutputTool(schema: z.ZodTypeAny, onValid: (value: unknown) => void): Tool<z.ZodTypeAny> {
  return {
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    description: '把你的最终答案按要求的结构化格式返回。在回复末尾必须且只调用一次本工具。',
    inputSchema: schema, // API 层 toApiTools→zodToJsonSchema 把 schema 作为工具 parameters 暴露给模型
    isReadOnly: true,
    needsPermission: () => false,
    async call(input) {
      // loop.ts execCall 通常已对 inputSchema safeParse 过；此处再 parse 取规范化值并捕获（防御 + 拿 zod 转换值）。
      const parsed = schema.safeParse(input)
      if (!parsed.success) {
        const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
        return `错误：输出不符合要求的结构：${issues}。请按结构重新调用 ${STRUCTURED_OUTPUT_TOOL_NAME}。`
      }
      onValid(parsed.data)
      return '已记录结构化输出。'
    },
  }
}
