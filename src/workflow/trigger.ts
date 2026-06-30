// src/workflow/trigger.ts
export function detectUltracode(prompt: string): boolean {
  // ultracode 独立词，且排除 ultrathink（CC：两者独立正则）
  return /\bultracode\b/i.test(prompt)
}

export function workflowUsageWarning(skip: boolean): string | null {
  if (skip) return null
  return 'This will run a multi-agent workflow that may spawn many subagents and consume significant tokens. Set skipWorkflowUsageWarning to skip this notice.'
}
