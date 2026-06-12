import test from 'node:test'
import assert from 'node:assert'
import { inRange } from './src/a.js'
import { sum } from './src/b.js'
import { pages } from './src/c.js'
import { initials } from './src/d.js'

test('inRange 闭区间', () => { assert.equal(inRange(10, 0, 10), true) })
test('sum 空数组为 0', () => { assert.equal(sum([]), 0); assert.equal(sum([1, 2]), 3) })
test('pages 向上取整', () => { assert.equal(pages(11, 5), 3) })
test('initials 容忍连续空格', () => { assert.equal(initials('li  lei'), 'LL') })
