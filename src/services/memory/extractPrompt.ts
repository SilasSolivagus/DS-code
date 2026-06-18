import { MEMORY_TYPE_GUIDE } from '../../memdir/memoryTypes.js'

export function renderRecentMessages(messages: any[]): string {
  return messages.map(m => {
    const text = typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.map((c: any) => c?.text ?? '').join('') : ''
    return `[${m.role}] ${text}`.trim()
  }).filter(Boolean).join('\n\n')
}

export function buildExtractPrompt(recentMessages: any[], manifest: string): string {
  return `你的任务：从下面这段最近对话里，提取值得长期记住的事实，存成 memory 文件。

只用 MemWrite/MemEdit 工具（只能写 memory 目录），可用 Read 看现有文件。**不要 grep 源码、不要 git 探索**，只依据下面对话内容。最多 5 轮内完成。

${MEMORY_TYPE_GUIDE}

不要保存：代码结构/git 历史能查到的、只对本次对话有意义的、已被现有记忆覆盖的。

现有记忆清单（避免重复，已有的用 MemEdit 更新而非新建）：
${manifest}

保存方法（两步）：① MemWrite 写 \`<slug>.md\`（带 frontmatter：name/description/type，正文遵循类型约定）；② MemEdit 更新 \`MEMORY.md\` 加一行指针 \`- [Title](<slug>.md) — 一行 hook\`。没什么值得记的就什么都不写。

最近对话：
${renderRecentMessages(recentMessages)}`
}
