// src/text.ts
// 共享文本清洗工具（核心层，不依赖 TUI）。
// 安全过滤：剥除控制字符，防止 ESC 序列在终端渲染时覆盖/污染已显示内容。
// 攻击面有二：① 权限弹窗中模型生成参数嵌入 \x1b[2K\r，可在"批准 ls"后视觉上显示成
// "批准 rm -rf"的幻象；② 工具结果预览中全屏程序输出的 \x1b[?1049h 等序列直接灌进画面。
// 保留 \t（\x09）；\n（\x0a）也会被剥除，调用方需先按行 split 再清洗。
// C1 区（\x80-\x9f）一并剥除：\x9b 是单字节 CSI，部分终端（VTE/xterm）即使 UTF-8 模式也会响应。
export const sanitize = (s: string) => s.replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, '')

/** 工具结果字符级兜底截断：超 maxChars 时保留头 70% + 尾 20%，中间替换为标注。DeepSeek 无 tokenizer 故按字符估。 */
export function capToolResult(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  const head = Math.floor(maxChars * 0.7)
  const tail = Math.floor(maxChars * 0.2)
  const cut = content.length - head - tail
  return content.slice(0, head) + `\n…[工具结果过大，已截断 ${cut} 字符]…\n` + content.slice(content.length - tail)
}

/** 检测用户输入里的「加强思考」关键词，命中返回 'high'（本轮临时升 effort 档），否则 null。 */
export function detectEffortKeyword(text: string): 'high' | null {
  return /\bultrathink\b|\bthink\s+har(?:d|der)\b/i.test(text) ? 'high' : null
}
