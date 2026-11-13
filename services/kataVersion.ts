import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Version } from './sysboxVersion'

const run = promisify(execFile)

/** The Kata release the runtime design was validated against. */
export const MIN_KATA: Version = [4, 3, 1]

export const kataNewEnough = (v: Version) => (v[0] - MIN_KATA[0] || v[1] - MIN_KATA[1] || v[2] - MIN_KATA[2]) >= 0

/** The first x.y.z in the shim's `--version` output; null when there is none. */
export function parseKataVersion(output: string): Version | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Where scripts/install-kata.sh links the shim: containerd's own lookup path for the kata runtime. */
const DEFAULT_SHIM = '/usr/local/bin/containerd-shim-kata-v2'

let known: Version | null = null

/** Tests: ask the host again. */
export function _resetKataVersion(): void { known = null }

/**
 * The host's Kata version, null when it cannot be told (no Kata, no Docker access). Docker's API does not say it, so
 * the host's shim runs in a throw-away container: the one Docker's runtime list names, else (Docker does not report a
 * runtimeType) the one scripts/install-kata.sh links where containerd looks for it. Only a version new enough is
 * kept: after an upgrade of Kata an old one must not linger.
 */
export async function kataVersion(): Promise<Version | null> {
  if (known) return known
  try {
    const { stdout: info } = await run('docker', ['info', '--format', '{{json .Runtimes}}'], { timeout: 30_000 })
    const runtimes = JSON.parse(info) as Record<string, { runtimeType?: string; path?: string } | undefined>
    if (!runtimes.kata) return null
    const path = runtimes.kata.runtimeType || runtimes.kata.path || DEFAULT_SHIM
    const binary = path.startsWith('/') ? path : `/usr/bin/${path}`
    // --mount, not -v: a shim that is not there fails the run instead of leaving an empty folder in its place on the host
    const { stdout } = await run('docker', ['run', '--rm', '--network', 'none', '--mount', `type=bind,src=${binary},dst=/kata-shim,readonly`, '--entrypoint', '/kata-shim', 'alpine', '--version'], { timeout: 120_000 })
    const version = parseKataVersion(stdout)
    if (version && kataNewEnough(version)) known = version
    return version
  } catch {
    return null
  }
}
