import { applyDiscount } from './utils.js'
export function cartTotal(items, rate) {
  return items.reduce((s, it) => s + applyDiscount(it.price, rate), 0)
}
