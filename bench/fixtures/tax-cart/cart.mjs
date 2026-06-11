import { TAX_RATE } from './tax.mjs'

export function totalWithTax(subtotal) {
  return Math.round(subtotal * (1 + TAX_RATE) * 100) / 100
}

export function receiptLine(subtotal) {
  return `合计（含 8% 税）：${(subtotal * 1.2).toFixed(2)}`
}
