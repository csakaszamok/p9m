import { describe, it, expect } from 'vitest'
import { allocateSubnet, cidrOverlaps, subnetPool, subnetsInCompose } from '../../services/subnetPool.js'

describe('allocateSubnet', () => {
  it('takes the first block of an empty pool', () => {
    expect(allocateSubnet('10.213.0.0/16', [])).toEqual({ subnet: '10.213.0.0/28', ip_range: '10.213.0.8/29', dns_ip: '10.213.0.2' })
  })
  it('skips a used block', () => {
    expect(allocateSubnet('10.213.0.0/16', ['10.213.0.0/28'])).toEqual({ subnet: '10.213.0.16/28', ip_range: '10.213.0.24/29', dns_ip: '10.213.0.18' })
  })
  it('skips every block a wider network overlaps', () => {
    expect(allocateSubnet('10.213.0.0/16', ['10.213.0.0/24'])?.subnet).toBe('10.213.1.0/28')
  })
  it('lets a used /29 take its whole /28 block', () => {
    expect(allocateSubnet('10.213.0.0/16', ['10.213.0.8/29'])?.subnet).toBe('10.213.0.16/28')
  })
  it('ignores malformed entries', () => {
    expect(allocateSubnet('10.213.0.0/16', ['bogus', ''])?.subnet).toBe('10.213.0.0/28')
  })
  it('returns null when the pool is exhausted', () => {
    expect(allocateSubnet('10.213.0.0/28', ['10.213.0.0/28'])).toBeNull()
  })
})

describe('cidrOverlaps', () => {
  it('detects containment and disjointness', () => {
    expect(cidrOverlaps('10.0.0.0/8', '10.213.0.16/28')).toBe(true)
    expect(cidrOverlaps('10.213.0.0/28', '10.213.0.16/28')).toBe(false)
  })
})

describe('subnetPool', () => {
  it('defaults', () => {
    expect(subnetPool({})).toEqual({ pool: '10.213.0.0/16', warnings: [] })
  })
  it('accepts a valid pool', () => {
    expect(subnetPool({ SANDBOX_SUBNET_POOL: '10.50.0.0/20' })).toEqual({ pool: '10.50.0.0/20', warnings: [] })
  })
  it('normalizes host bits to the network address', () => {
    expect(subnetPool({ SANDBOX_SUBNET_POOL: '10.213.0.5/16' }).pool).toBe('10.213.0.0/16')
  })
  it('falls back with a warning naming the value', () => {
    for (const bad of ['nonsense', '10.0.0.0/30']) {
      const r = subnetPool({ SANDBOX_SUBNET_POOL: bad })
      expect(r.pool).toBe('10.213.0.0/16')
      expect(r.warnings).toEqual([`SANDBOX_SUBNET_POOL "${bad}" is not an IPv4 CIDR of /28 or larger; using 10.213.0.0/16`])
    }
  })
})

describe('subnetsInCompose', () => {
  it('reads ipam subnets', () => {
    const text = 'services: {}\nnetworks:\n  default:\n    ipam:\n      config:\n        - subnet: 10.213.0.32/28\n          ip_range: 10.213.0.40/29\n'
    expect(subnetsInCompose(text)).toEqual(['10.213.0.32/28'])
  })
  it('returns [] on non-compose or broken text', () => {
    expect(subnetsInCompose('fake-cert')).toEqual([])
    expect(subnetsInCompose('a: [')).toEqual([])
  })
})
