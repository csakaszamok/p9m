import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import { raiseConnectTimeout, errorDetail } from '../../services/outboundNet'

describe('raiseConnectTimeout', () => {
  const before = net.getDefaultAutoSelectFamilyAttemptTimeout()
  afterEach(() => net.setDefaultAutoSelectFamilyAttemptTimeout(before))

  it("raises Node's 250 ms per address", () => {
    net.setDefaultAutoSelectFamilyAttemptTimeout(250)
    raiseConnectTimeout()
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(2000)
  })
  it("keeps the operator's larger value", () => {
    net.setDefaultAutoSelectFamilyAttemptTimeout(5000)
    raiseConnectTimeout()
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(5000)
  })
})

describe('errorDetail', () => {
  it("names the cause's code", () => {
    expect(errorDetail(new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ETIMEDOUT' }) }))).toBe('fetch failed (ETIMEDOUT)')
  })
  it("falls back on the cause's message", () => {
    expect(errorDetail(new Error('fetch failed', { cause: new Error('bad certificate') }))).toBe('fetch failed (bad certificate)')
  })
  it('an error without a cause, and anything else', () => {
    expect(errorDetail(new Error('no issuer'))).toBe('no issuer')
    expect(errorDetail('plain')).toBe('plain')
  })
})
