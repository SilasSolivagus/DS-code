export function clamp(n, max) {
  return n < max ? n : max
}
export function inRange(n, lo, hi) {
  return n >= lo && n < hi // bug: 应为 n <= hi
}
