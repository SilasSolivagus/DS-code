import test from 'node:test'
import assert from 'node:assert'
import { totalWithTax, receiptLine } from './cart.mjs'

test('税率 8%', () => {
  assert.equal(totalWithTax(100), 108)
  assert.equal(receiptLine(100), '合计（含 8% 税）：108.00')
})
