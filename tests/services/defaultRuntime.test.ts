import { describe, it, expect, vi, beforeEach } from 'vitest'

let installed = ['runc']
vi.mock('../../services/docker', () => ({ dockerRuntimes: vi.fn(async () => installed) }))
let sysbox: number[] | null = [0, 7, 1]
vi.mock('../../services/sysboxVersion', async importActual => ({ ...await importActual<typeof import('../../services/sysboxVersion')>(), sysboxVersion: vi.fn(async () => sysbox) }))
const { defaultRuntime, runtimeMissing, runtimeAllowed, allowedRuntimes, _resetDefaultRuntime } = await import('../../services/defaultRuntime')

beforeEach(() => { _resetDefaultRuntime(); installed = ['runc'] })

describe('defaultRuntime', () => {
  it('auto (the default): sysbox where the host has sysbox-runc, dind otherwise when allowed', async () => {
    expect(await defaultRuntime({ ALLOWED_RUNTIMES: 'all' })).toBe('dind')
    // dind not allowed (the default): sysbox, so a create says sysbox is missing
    expect(await defaultRuntime({})).toBe('sysbox')
    _resetDefaultRuntime(); installed = ['runc', 'sysbox-runc']
    expect(await defaultRuntime({ DEFAULT_RUNTIME: 'auto' })).toBe('sysbox')
  })
  it('a runtime named in DEFAULT_RUNTIME is kept as it is', async () => {
    expect(await defaultRuntime({ DEFAULT_RUNTIME: 'dind' })).toBe('dind')
    expect(await defaultRuntime({ DEFAULT_RUNTIME: 'sysbox' })).toBe('sysbox')
  })
})

describe('runtimeMissing', () => {
  it('sysbox too old for the sandbox image: says so; a version it cannot tell does not refuse', async () => {
    _resetDefaultRuntime(); installed = ['runc', 'sysbox-runc']
    sysbox = [0, 6, 7]
    expect(await runtimeMissing('sysbox')).toMatch(/sysbox 0\.6\.7 on this host is too old.*0\.7\.0/)
    expect(await runtimeMissing('dind')).toBeNull()
    sysbox = null
    expect(await runtimeMissing('sysbox')).toBeNull()
    sysbox = [0, 7, 1]
    expect(await runtimeMissing('sysbox')).toBeNull()
  })
  it('sysbox without sysbox-runc on the host says so; dind always runs', async () => {
    expect(await runtimeMissing('sysbox')).toMatch(/sysbox is not installed on this host/)
    expect(await runtimeMissing('dind')).toBeNull()
    _resetDefaultRuntime(); installed = ['runc', 'sysbox-runc']
    expect(await runtimeMissing('sysbox')).toBeNull()
  })
})

describe('ALLOWED_RUNTIMES', () => {
  it('empty or unset: sysbox only (dind is for development); all: every runtime', () => {
    expect(allowedRuntimes({})).toEqual(['sysbox'])
    expect(allowedRuntimes({ ALLOWED_RUNTIMES: ' , ' })).toEqual(['sysbox'])
    expect(runtimeAllowed('dind', {})).toBe(false)
    expect(runtimeAllowed('sysbox', {})).toBe(true)
    expect(allowedRuntimes({ ALLOWED_RUNTIMES: 'All' })).toBeNull()
    expect(runtimeAllowed('dind', { ALLOWED_RUNTIMES: 'all' })).toBe(true)
  })
  it('a comma list (spaces and case ignored) allows only those', () => {
    const env = { ALLOWED_RUNTIMES: ' Sysbox, kata ' }
    expect(allowedRuntimes(env)).toEqual(['sysbox', 'kata'])
    expect(runtimeAllowed('sysbox', env)).toBe(true)
    expect(runtimeAllowed('dind', env)).toBe(false)
  })
})
