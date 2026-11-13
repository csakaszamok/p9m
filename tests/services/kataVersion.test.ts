import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFile = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile }))

import { parseKataVersion, kataNewEnough, kataVersion, _resetKataVersion } from '../../services/kataVersion'

const OUTPUT = (v: string) => `Kata Containers containerd shim (Rust): id: io.containerd.kata.v2, version: ${v}, commit: abc`
const SHIM = '/opt/kata/runtime-rs/bin/containerd-shim-kata-v2'

/** Answers `docker info`, then `docker run`; records the arguments. */
function host(runtimes: unknown, version: string | Error) {
  execFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
    if (args[0] === 'info') return cb(null, { stdout: JSON.stringify(runtimes), stderr: '' })
    if (version instanceof Error) return cb(version)
    cb(null, { stdout: OUTPUT(version), stderr: '' })
  })
}

beforeEach(() => { execFile.mockReset(); _resetKataVersion() })

describe('parseKataVersion', () => {
  it("reads the shim's output", () => expect(parseKataVersion(OUTPUT('4.3.1'))).toEqual([4, 3, 1]))
  it('nothing to read', () => expect(parseKataVersion('nothing')).toBeNull())
})

describe('kataNewEnough', () => {
  it('compares against 4.3.1', () => {
    expect(kataNewEnough([4, 3, 0])).toBe(false)
    expect(kataNewEnough([4, 3, 1])).toBe(true)
    expect(kataNewEnough([4, 4, 0])).toBe(true)
    expect(kataNewEnough([5, 0, 0])).toBe(true)
  })
})

describe('kataVersion', () => {
  it("runs the shim Docker's runtime list names (runtimeType)", async () => {
    host({ runc: { path: 'runc' }, kata: { runtimeType: SHIM } }, '4.3.1')
    expect(await kataVersion()).toEqual([4, 3, 1])
    expect(execFile.mock.calls[1][0]).toBe('docker')
    expect(execFile.mock.calls[1][1]).toEqual(['run', '--rm', '--network', 'none', '--mount', `type=bind,src=${SHIM},dst=/kata-shim,readonly`, '--entrypoint', '/kata-shim', 'alpine', '--version'])
  })
  it('falls back to path', async () => {
    host({ kata: { path: '/usr/local/bin/containerd-shim-kata-v2' } }, '4.3.1')
    expect(await kataVersion()).toEqual([4, 3, 1])
    expect(execFile.mock.calls[1][1]).toContain('type=bind,src=/usr/local/bin/containerd-shim-kata-v2,dst=/kata-shim,readonly')
  })
  it('a bare name in the list is in /usr/bin', async () => {
    host({ kata: { runtimeType: 'containerd-shim-kata-v2' } }, '4.3.1')
    await kataVersion()
    expect(execFile.mock.calls[1][1]).toContain('type=bind,src=/usr/bin/containerd-shim-kata-v2,dst=/kata-shim,readonly')
  })
  it("Docker lists kata without its shim (it does not report runtimeType): the shim install-kata.sh links", async () => {
    host({ runc: { path: 'runc' }, kata: { status: {} } }, '4.3.1')
    expect(await kataVersion()).toEqual([4, 3, 1])
    expect(execFile.mock.calls[1][1]).toContain('type=bind,src=/usr/local/bin/containerd-shim-kata-v2,dst=/kata-shim,readonly')
  })
  it('no kata: null, and no container is run', async () => {
    host({ runc: { path: 'runc' } }, '4.3.1')
    expect(await kataVersion()).toBeNull()
    expect(execFile).toHaveBeenCalledTimes(1)
  })
  it('the container fails: null', async () => {
    host({ kata: { runtimeType: SHIM } }, new Error('no such image'))
    expect(await kataVersion()).toBeNull()
  })
  it('keeps a version that is new enough, asks again about an old one', async () => {
    host({ kata: { runtimeType: SHIM } }, '4.2.0')
    expect(await kataVersion()).toEqual([4, 2, 0])
    host({ kata: { runtimeType: SHIM } }, '4.3.1')
    expect(await kataVersion()).toEqual([4, 3, 1])
    execFile.mockClear()
    expect(await kataVersion()).toEqual([4, 3, 1])
    expect(execFile).not.toHaveBeenCalled()
  })
})
