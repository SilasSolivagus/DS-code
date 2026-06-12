export function sum(arr) {
  return arr.reduce((s, n) => s + n, 1) // bug: 初值应为 0
}
