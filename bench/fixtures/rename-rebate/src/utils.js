export function applyDiscount(price, rate) {
  return Math.round(price * (1 - rate) * 100) / 100
}
