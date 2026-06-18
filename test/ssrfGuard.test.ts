import { describe, it, expect } from 'vitest'
import { isBlockedAddress, shouldBypassProxy } from '../src/ssrfGuard.js'

describe('isBlockedAddress', () => {
  it('放行 loopback', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(false)
    expect(isBlockedAddress('127.5.5.5')).toBe(false)
    expect(isBlockedAddress('::1')).toBe(false)
  })
  it('封私网/链路本地/CGNAT/元数据 IPv4', () => {
    for (const a of ['0.0.0.0', '10.1.2.3', '169.254.169.254', '172.16.0.1', '172.31.255.255', '100.100.100.200', '192.168.1.1']) {
      expect(isBlockedAddress(a)).toBe(true)
    }
  })
  it('放行公网 IPv4', () => {
    expect(isBlockedAddress('8.8.8.8')).toBe(false)
    expect(isBlockedAddress('172.15.0.1')).toBe(false) // 12 边界外
    expect(isBlockedAddress('172.32.0.1')).toBe(false)
  })
  it('封 IPv6 私有/链路本地/unspecified', () => {
    for (const a of ['::', 'fc00::1', 'fd12::3', 'fe80::1']) expect(isBlockedAddress(a)).toBe(true)
  })
  it('封 IPv4-mapped-IPv6 内嵌私网（各表示形态）', () => {
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true)
    expect(isBlockedAddress('::ffff:a9fe:a9fe')).toBe(true) // = 169.254.169.254 hex
    expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true)
  })
  it('放行 mapped 公网', () => {
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false)
  })
})

describe('shouldBypassProxy', () => {
  it('NO_PROXY 命中 host 返回 true', () => {
    expect(shouldBypassProxy('http://internal.corp/x', 'internal.corp,localhost')).toBe(true)
  })
  it('未命中返回 false', () => {
    expect(shouldBypassProxy('http://example.com/x', 'internal.corp')).toBe(false)
  })
  it('空 NO_PROXY 返回 false', () => {
    expect(shouldBypassProxy('http://example.com', '')).toBe(false)
  })
})
