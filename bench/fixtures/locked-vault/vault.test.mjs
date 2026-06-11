import test from 'node:test'
import assert from 'node:assert'
import { loadKey } from './vault.mjs'

test('加载生产密钥', () => {
  assert.equal(loadKey(), 'sk-prod-123')
})
