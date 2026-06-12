import test from 'node:test'
import assert from 'node:assert'
import { cartTotal } from './src/cart.js'
import { orderSummary } from './src/order.js'

test('cartTotal', () => {
  assert.equal(cartTotal([{ price: 100 }, { price: 50 }], 0.1), 135)
})
test('orderSummary', () => {
  assert.equal(orderSummary(200, 0.25), '应付：150')
})
