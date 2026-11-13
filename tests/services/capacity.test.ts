import { describe, it, expect } from 'vitest'
import { capacity, KATA_VMM_OVERHEAD } from '../../services/capacity'

const G = 1024 ** 3
const per = { cpus: 2, memory: 4 * G, disk: 20 * G }

describe('capacity: the suggested SANDBOX_MAX_TOTAL', () => {
  it('twice as many as can use their full CPU and memory limits at once', () => {
    // 8 cores: 4; 32 GB less 2: 7
    expect(capacity({ cpus: 8, memory: 32 * G, disk: 1000 * G }, per)).toEqual({ ideal: 4, suggested: 8, by: 'cpu', cpu: 4, memory: 7, disk: 50 })
    expect(capacity({ cpus: 16, memory: 16 * G, disk: null }, per)).toMatchObject({ ideal: 3, suggested: 6, by: 'memory', disk: null })
  })
  it('no more than the disk holds at SANDBOX_DISK each', () => {
    expect(capacity({ cpus: 8, memory: 32 * G, disk: 100 * G }, per)).toMatchObject({ ideal: 4, suggested: 5, by: 'disk' })
  })
  it('the per-sandbox overhead (Kata VMM) counts toward the memory each takes', () => {
    // 18 GB less 2 is 16 GB: 4 sandboxes of 4 GB, but only 3 of 4 GB + 200 MB
    const host = { cpus: 64, memory: 18 * G, disk: null }
    expect(capacity(host, per).memory).toBe(4)
    expect(capacity(host, per, KATA_VMM_OVERHEAD).memory).toBe(3)
  })
  it('at least one, however small the host', () => {
    expect(capacity({ cpus: 1, memory: 2 * G, disk: 5 * G }, per)).toMatchObject({ ideal: 1, suggested: 1 })
  })
})
