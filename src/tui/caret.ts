// src/tui/caret.ts
// 计算输入框插入点的 1-based 终端列与行偏移。draft 折行（长粘贴）或含硬换行时，硬件光标须落到
// 最后一可视行的真实列，否则 `\x1b[{4+宽度}G` 会超出终端宽被钳到右缘 → 与真实插入点错位。
// 行偏移：全屏布局下输入框锚在顶部（caretRow 从 ScrollView 高度往下算），折行往下增行，
// 故光标行须加 parkRowOffset（折行视觉行数）；否则光标停在折行首行而非末行（与真实插入点错位）。
const PREFIX = 3  // value 左侧占位：左内边距(1) + "❯ "(2)，故 value 从 0-indexed 第 3 列起（1-based 第 4 列）

/** @param termCols 终端列数（process.stdout.columns）；@param width 显示宽度函数（CJK 计 2） */
export function parkCol(value: string, termCols: number, width: (s: string) => number): number {
  const avail = Math.max(1, termCols - PREFIX - 1)        // value 节点每行可用宽（再减右内边距 1）
  const lastLine = value.slice(value.lastIndexOf('\n') + 1)
  return PREFIX + 1 + (width(lastLine) % avail)           // 4 + 末行已占宽（满行取模归 0 → 回到列 4）
}

/**
 * value 折行后，光标所在视觉行相对输入框首内容行的偏移（0=未折行单行）。
 * 与 parkCol 的列取模语义对齐：用 floor（满行 width=avail → 光标进下一行 → 偏移 +1、列归 4）。
 * @param termCols 终端列数；@param width 显示宽度函数（CJK 计 2）
 */
export function parkRowOffset(value: string, termCols: number, width: (s: string) => number): number {
  const avail = Math.max(1, termCols - PREFIX - 1)
  const lines = value.split('\n')
  let off = 0
  for (let i = 0; i < lines.length - 1; i++) off += Math.floor(width(lines[i]) / avail) + 1  // 每条逻辑行折行数 + 换行本身占 1 行
  off += Math.floor(width(lines[lines.length - 1]) / avail)                                   // 末逻辑行折行数（光标落在其上）
  return off
}
