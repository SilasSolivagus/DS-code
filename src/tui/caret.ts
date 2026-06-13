// src/tui/caret.ts
// 计算输入框插入点的 1-based 终端列。draft 折行（长粘贴）或含硬换行时，硬件光标须落到
// 最后一可视行的真实列，否则 `\x1b[{4+宽度}G` 会超出终端宽被钳到右缘 → 与真实插入点错位。
// 行偏移无需修：插入点恒在最后内容行，其下方（底边框/页脚/末尾换行）行数固定，折行只增上方行。
const PREFIX = 3  // value 左侧占位：左内边距(1) + "❯ "(2)，故 value 从 0-indexed 第 3 列起（1-based 第 4 列）

/** @param termCols 终端列数（process.stdout.columns）；@param width 显示宽度函数（CJK 计 2） */
export function parkCol(value: string, termCols: number, width: (s: string) => number): number {
  const avail = Math.max(1, termCols - PREFIX - 1)        // value 节点每行可用宽（再减右内边距 1）
  const lastLine = value.slice(value.lastIndexOf('\n') + 1)
  return PREFIX + 1 + (width(lastLine) % avail)           // 4 + 末行已占宽（满行取模归 0 → 回到列 4）
}
