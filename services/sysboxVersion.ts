import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type Version = [number, number, number]

/** foxglove 0.12's runc (1.3) starts no container inside a sandbox on an older sysbox ("unsafe procfs detected"). */
export const MIN_SYSBOX: Version = [0, 7, 0]

export const versionText = (v: Version) => v.join('.')
export const sysboxNewEnough = (v: Version) => (v[0] - MIN_SYSBOX[0] || v[1] - MIN_SYSBOX[1] || v[2] - MIN_SYSBOX[2]) >= 0

/** The version in `sysbox-runc --version`'s output; null when there is none. */
export function parseSysboxVersion(output: string): Version | null {
  const m = /version:\s*(\d+)\.(\d+)\.(\d+)/.exec(output)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

let known: Version | null = null

/** Tests: ask the host again. */
export function _resetSysboxVersion(): void { known = null }

/**
 * The host's sysbox version, null when it cannot be told (no sysbox, no Docker access). Docker's API does not say it,
 * so the host's binary, which Docker's runtime list names, runs in a throw-away container. Only a version new enough
 * is kept: after an upgrade of sysbox an old one must not linger.
 */
export async function sysboxVersion(): Promise<Version | null> {
  if (known) return known
  try {
    const { stdout: info } = await run('docker', ['info', '--format', '{{json .Runtimes}}'], { timeout: 30_000 })
    const runtimes = JSON.parse(info) as Record<string, { path?: string } | undefined>
    const path = runtimes['sysbox-runc']?.path
    if (path === undefined) return null
    const binary = path.startsWith('/') ? path : `/usr/bin/${path}`
    const { stdout } = await run('docker', ['run', '--rm', '--network', 'none', '-v', `${binary}:/sysbox-runc:ro`, '--entrypoint', '/sysbox-runc', 'alpine', '--version'], { timeout: 120_000 })
    const version = parseSysboxVersion(stdout)
    if (version && sysboxNewEnough(version)) known = version
    return version
  } catch {
    return null
  }
}
