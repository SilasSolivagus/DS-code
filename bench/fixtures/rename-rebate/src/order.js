import { applyDiscount } from './utils.js'
export function orderSummary(price, rate) {
  return `应付：${applyDiscount(price, rate)}`
}
