// src/tools/askUserQuestion.ts
// AskUserQuestion 工具（CC 全平奇）：模型弹结构化多选题问用户。工厂注入 ask（由 TUI 提供；headless 不注册）。
import { z } from 'zod'
import type { Tool } from './types.js'

const optionSchema = z.object({
  label: z.string(),
  description: z.string(),
  preview: z.string().optional(),
})

const questionSchema = z.object({
  question: z.string(),
  header: z.string(),
  multiSelect: z.boolean(),
  options: z.array(optionSchema).min(2).max(4),
})

const schema = z.object({
  questions: z.array(questionSchema).min(1).max(4),
})

export type Question = z.infer<typeof questionSchema>
export type QOption = z.infer<typeof optionSchema>
export type Answer = { header: string; question: string; selected: string[]; freeText?: string }

/** 把用户答案编码为模型可读的 JSON（键=question 文本） */
function formatAnswers(answers: Answer[]): string {
  const obj: Record<string, { selected: string[]; other?: string }> = {}
  for (const a of answers) {
    obj[a.question] = { selected: a.selected }
    if (a.freeText) obj[a.question].other = a.freeText
  }
  return JSON.stringify(obj)
}

export function makeAskUserQuestionTool(deps: {
  ask: (questions: Question[]) => Promise<Answer[] | null>
}): Tool<typeof schema> {
  return {
    name: 'AskUserQuestion',
    description:
      '当需要用户拍板（歧义、多种合理选择、需要偏好）时，弹结构化多选题问用户，而不是自作主张。1–4 题，每题 2–4 个选项，可多选；返回用户选择的 JSON。仅交互式可用。',
    inputSchema: schema,
    isReadOnly: true,
    needsPermission: () => false,
    async call(input) {
      const answers = await deps.ask(input.questions)
      if (!answers) return '用户取消了提问，请自行按最佳判断继续。'
      return formatAnswers(answers)
    },
  }
}
