export function pages(total, perPage) {
  return Math.floor(total / perPage) // bug: 应为 Math.ceil
}
