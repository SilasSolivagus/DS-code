// 区间求和：sumRange(1, 3) 应为 1+2+3 = 6
export function sumRange(a, b) {
  let s = 0
  for (let i = a; i < b; i++) s += i
  return s
}
