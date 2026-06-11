import test from 'node:test'
import assert from 'node:assert'
import { checkout } from './pricing.mjs'

test('结算顺序：先满减后会员折扣', () => {
  // 110 → 满减后 100 → 会员 95 折 = 95
  assert.equal(checkout(110, true), 95)
})

test('非会员不打折', () => {
  assert.equal(checkout(50, false), 50)
})
