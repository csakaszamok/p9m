import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFile = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile }))

import { parseSysboxVersion, sysboxNewEnough, sysboxVersion, _resetSysboxVersion } from '../../services/sysboxVersion'

const OUTPUT = (v: string) => `sysbox-runc\n\tedition: \tCommunity Edition (CE)\n\tversion: \t${v}\n\tcommit: \tc58eba1\n`

/** Answers `docker info`, then `docker run`; records the arguments. */
function host(runtimes: unknown, version: string | Error) {
  execFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
    if (args[0] === 'info') return cb(null, { stdout: JSON.stringify(runtimes), stderr: '' })
    if (version instanceof Error) return cb(version)
    cb(null, { stdout: OUTPUT(version), stderr: '' })
  })
}

beforeEach(() => { execFile.mockReset(); _resetSysboxVersion() })

describe('parseSysboxVersion', () => {
  it("reads sysbox-runc's output", () => expect(parseSysboxVersion(OUTPUT('0.6.7'))).toEqual([0, 6, 7]))
  it('nothing to read', () => expect(parseSysboxVersion('sysbox-runc')).toBeNull())
})

describe('sysboxNewEnough', () => {
  it('compares against 0.7.0', () => {
    expect(sysboxNewEnough([0, 6, 7])).toBe(false)
    expect(sysboxNewEnough([0, 7, 0])).toBe(true)
    expect(sysboxNewEnough([0, 7, 1])).toBe(true)
    expect(sysboxNewEnough([1, 0, 0])).toBe(true)
  })
})

describe('sysboxVersion', () => {
  it("runs the binary Docker's runtime list names", async () => {
    host({ runc: { path: 'runc' }, 'sysbox-runc': { path: '/opt/bin/sysbox-runc' } }, '0.7.1')
    expect(await sysboxVersion()).toEqual([0, 7, 1])
    expect(execFile.mock.calls[1][1]).toContain('/opt/bin/sysbox-runc:/sysbox-runc:ro')
  })
  it('a bare name in the list is in /usr/bin', async () => {
    host({ 'sysbox-runc': { path: 'sysbox-runc' } }, '0.7.1')
    await sysboxVersion()
    expect(execFile.mock.calls[1][1]).toContain('/usr/bin/sysbox-runc:/sysbox-runc:ro')
  })
  it('no sysbox: null, and no container is run', async () => {
    host({ runc: { path: 'runc' } }, '0.7.1')
    expect(await sysboxVersion()).toBeNull()
    expect(execFile).toHaveBeenCalledTimes(1)
  })
  it('the container fails: null', async () => {
    host({ 'sysbox-runc': { path: '/usr/bin/sysbox-runc' } }, new Error('no such image'))
    expect(await sysboxVersion()).toBeNull()
  })
  it('keeps a version that is new enough, asks again about an old one', async () => {
    host({ 'sysbox-runc': { path: '/usr/bin/sysbox-runc' } }, '0.6.7')
    expect(await sysboxVersion()).toEqual([0, 6, 7])
    host({ 'sysbox-runc': { path: '/usr/bin/sysbox-runc' } }, '0.7.1')
    expect(await sysboxVersion()).toEqual([0, 7, 1])
    execFile.mockClear()
    expect(await sysboxVersion()).toEqual([0, 7, 1])
    expect(execFile).not.toHaveBeenCalled()
  })
})
