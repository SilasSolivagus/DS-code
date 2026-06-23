import { describe, it, expect } from 'vitest'
import { parkCol, parkRowOffset } from '../src/tui/caret.js'

// 简易宽度函数（ASCII 每字符 1 列）+ CJK 双宽
const len = (s: string) => [...s].length
const cjk = (s: string) => {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    w += (c >= 0x1100 && c <= 0x115F) || (c >= 0x2E80 && c <= 0xA4CF) || (c >= 0xAC00 && c <= 0xD7A3) ? 2 : 1
  }
  return w
}

describe('parkCol：输入框插入点 1-based 终端列（折行感知）', () => {
  it('短文本（不折行）：col = 4 + 宽度（与旧行为一致）', () => {
    expect(parkCol('abc', 80, len)).toBe(7)   // 4 + 3
    expect(parkCol('', 80, len)).toBe(4)       // 空 → 起始列
  })

  it('恰好填满一行 → 光标落到下一可视行起始列 4', () => {
    const avail = 80 - 4 // = 76
    expect(parkCol('a'.repeat(avail), 80, len)).toBe(4)  // 76 % 76 = 0 → 4
  })

  it('超过一行 → 列按末行实际占宽折回', () => {
    // avail=76，100 字符 → 末行 100 % 76 = 24 → col = 4 + 24 = 28
    expect(parkCol('a'.repeat(100), 80, len)).toBe(28)
  })

  it('含硬换行：只算最后一逻辑行', () => {
    expect(parkCol('xxxx\nbb', 80, len)).toBe(6)   // 末行 "bb" 宽 2 → 4 + 2
    expect(parkCol('abc\n', 80, len)).toBe(4)       // 末行空 → 4
  })

  it('CJK 双宽计入', () => {
    expect(parkCol('你好', 80, cjk)).toBe(8)        // 宽 4 → 4 + 4
  })

  it('极窄终端不崩（avail 至少 1）', () => {
    expect(parkCol('ab', 4, len)).toBe(4)           // avail=max(1,0)=1，2 % 1 = 0 → 4
  })
})

describe('parkRowOffset：光标视觉行相对输入框首行的偏移（折行感知）', () => {
  it('短文本/空 → 偏移 0', () => {
    expect(parkRowOffset('abc', 80, len)).toBe(0)
    expect(parkRowOffset('', 80, len)).toBe(0)
  })
  it('恰好填满一行 → 光标进下一行，偏移 1（与 parkCol 满行归列 4 对齐）', () => {
    const avail = 80 - 4 // 76
    expect(parkRowOffset('a'.repeat(avail), 80, len)).toBe(1)
  })
  it('超过一行 → 按 floor 折行数', () => {
    expect(parkRowOffset('a'.repeat(100), 80, len)).toBe(1) // floor(100/76)=1
    expect(parkRowOffset('a'.repeat(200), 80, len)).toBe(2) // floor(200/76)=2
  })
  it('含硬换行：逐逻辑行折行数 + 换行各占 1 行', () => {
    expect(parkRowOffset('xxxx\nbb', 80, len)).toBe(1) // 行0 floor(4/76)=0 +1换行；末行 floor(2/76)=0 → 1
    expect(parkRowOffset('abc\n', 80, len)).toBe(1)    // 行0 0 +1换行；末行空 0 → 1
  })
  it('CJK 双宽计入折行', () => {
    // avail=76，39 个 CJK = 宽 78 > 76 → floor(78/76)=1
    expect(parkRowOffset('你'.repeat(39), 80, cjk)).toBe(1)
  })
})
