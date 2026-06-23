// src/tui/caret.ts
// 计算输入框插入点的 1-based 终端列与行偏移。
// 折行模型（实测确认）：ink 把 "❯ " + value 当**一整段流式折行**，在盒内宽（termCols - 2*左右padding）内换行，
// 续行顶到盒内左缘（1-based col 2），仅首逻辑行带 "❯ "(2 格)前缀。硬件光标须落到末视觉行的真实列/行，
// 否则与真实插入点错位（旧的"统一 col4/avail"模型对续行不成立，长粘贴折行时列偏）。
const LPAD = 1     // 盒左 padding（1 列）；盒内宽 = termCols - 2*LPAD
const PROMPT = 2   // "❯ " 宽，仅出现在首逻辑行（流首部）

/** value 末逻辑行的流内已占宽（首逻辑行含 "❯ " 前缀，硬换行后的逻辑行不含）。 */
function lastLineFlowWidth(value: string, width: (s: string) => number): number {
  const lastNl = value.lastIndexOf('\n')
  const lastLine = value.slice(lastNl + 1)
  return (lastNl === -1 ? PROMPT : 0) + width(lastLine)
}

/** 插入点 1-based 终端列：盒左 padding(1) + 1 + 末行流宽对盒内宽取模（满行归 0 → 续行 col 2）。 */
export function parkCol(value: string, termCols: number, width: (s: string) => number): number {
  const flowW = Math.max(1, termCols - LPAD * 2)
  return LPAD + 1 + (lastLineFlowWidth(value, width) % flowW)
}

/**
 * value 折行后，光标所在视觉行相对输入框首内容行的偏移（0=未折行单行）。
 * 流式模型：各逻辑行（硬换行各起新行）按盒内宽折行；末逻辑行内光标行用 floor（满行进下一行）。
 * @param termCols 终端列数；@param width 显示宽度函数（CJK 计 2）
 */
export function parkRowOffset(value: string, termCols: number, width: (s: string) => number): number {
  const flowW = Math.max(1, termCols - LPAD * 2)
  const lines = value.split('\n')
  let off = 0
  for (let i = 0; i < lines.length - 1; i++) {
    const w = (i === 0 ? PROMPT : 0) + width(lines[i])
    off += Math.max(1, Math.ceil(w / flowW))   // 该逻辑行占的视觉行数（硬换行推到下一行）
  }
  off += Math.floor(lastLineFlowWidth(value, width) / flowW)  // 末逻辑行内光标所在折行
  return off
}
