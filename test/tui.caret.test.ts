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

  it('恰好填满首行（含 ❯ 前缀）→ 续行起始列 2', () => {
    // 流式：盒内宽 flowW=80-2=78；首行 "❯ "(2)+76 = 78 填满 → 光标进续行 col 2
    expect(parkCol('a'.repeat(76), 80, len)).toBe(2)
  })

  it('超过一行 → 列按末视觉行流宽折回', () => {
    // flowW=78，流宽 = 2+100 = 102 → 102 % 78 = 24 → col = 2 + 24 = 26
    expect(parkCol('a'.repeat(100), 80, len)).toBe(26)
  })

  it('含硬换行：续行不带 ❯，从 col 2 起', () => {
    expect(parkCol('xxxx\nbb', 80, len)).toBe(4)   // 末逻辑行 "bb"(无前缀) 宽 2 → 2 + 2
    expect(parkCol('abc\n', 80, len)).toBe(2)       // 末逻辑行空 → col 2
  })

  it('CJK 双宽计入', () => {
    expect(parkCol('你好', 80, cjk)).toBe(8)        // ❯ (2)+宽4 = 6 → 2 + 6
  })

  it('极窄终端不崩（flowW 至少 1）', () => {
    expect(parkCol('ab', 4, len)).toBe(2)           // flowW=max(1,2)=2，(2+2)%2=0 → col 2
  })
})

describe('parkRowOffset：光标视觉行相对输入框首行的偏移（折行感知）', () => {
  it('短文本/空 → 偏移 0', () => {
    expect(parkRowOffset('abc', 80, len)).toBe(0)
    expect(parkRowOffset('', 80, len)).toBe(0)
  })
  it('恰好填满首行 → 光标进续行，偏移 1（流宽 ❯ +76=78 满 78）', () => {
    expect(parkRowOffset('a'.repeat(76), 80, len)).toBe(1)
  })
  it('超过一行 → 按 floor 折行数（含 ❯ 前缀）', () => {
    expect(parkRowOffset('a'.repeat(100), 80, len)).toBe(1) // floor((2+100)/78)=1
    expect(parkRowOffset('a'.repeat(200), 80, len)).toBe(2) // floor((2+200)/78)=2
  })
  it('含硬换行：逐逻辑行视觉行数（ceil）+ 末行光标折行（floor）', () => {
    expect(parkRowOffset('xxxx\nbb', 80, len)).toBe(1) // 行0 ceil((2+4)/78)=1；末行'bb'(无前缀) floor(2/78)=0 → 1
    expect(parkRowOffset('abc\n', 80, len)).toBe(1)    // 行0 ceil((2+3)/78)=1；末行空 floor(0/78)=0 → 1
  })
  it('CJK 双宽计入折行', () => {
    // flowW=78，❯ (2)+39 个 CJK(宽78) = 80 > 78 → floor(80/78)=1
    expect(parkRowOffset('你'.repeat(39), 80, cjk)).toBe(1)
  })
})
