import test from 'node:test'
import assert from 'node:assert'
import { sumRange } from './calc.mjs'

test('sumRange 包含两端', () => {
  assert.equal(sumRange(1, 3), 6)
  assert.equal(sumRange(5, 5), 5)
})
