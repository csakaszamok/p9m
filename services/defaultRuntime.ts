import { dockerRuntimes } from './docker'
import { MIN_SYSBOX, sysboxNewEnough, sysboxVersion, versionText } from './sysboxVersion'

/** sysbox needs this OCI runtime on the host (Linux only; not in Docker Desktop) */
const SYSBOX_RUNC = 'sysbox-runc'
let installed: Promise<string[]> | null = null
const hostRuntimes = () => (installed ??= dockerRuntimes().catch(() => []))

/** Tests: ask Docker again. */
export function _resetDefaultRuntime(): void { installed = null }

/**
 * The runtime for a sandbox when a request names none. DEFAULT_RUNTIME=auto (the default) picks sysbox — no
 * privileged container — where the host has sysbox-runc, or where dind is not allowed (a create then says sysbox is
 * missing); dind otherwise. A named runtime is kept as it is.
 */
export async function defaultRuntime(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const raw = env.DEFAULT_RUNTIME || 'auto'
  if (raw !== 'auto') return raw
  return (await hostRuntimes()).includes(SYSBOX_RUNC) || !runtimeAllowed('dind', env) ? 'sysbox' : 'dind'
}

/** Why this runtime cannot run on this host, or null: sysbox without sysbox-runc, or too old for the sandbox image. */
export async function runtimeMissing(name: string): Promise<string | null> {
  if (name !== 'sysbox') return null
  if ((await hostRuntimes()).includes(SYSBOX_RUNC)) {
    const version = await sysboxVersion()
    return version && !sysboxNewEnough(version) ? `sysbox ${versionText(version)} on this host is too old: the sandbox image needs ${versionText(MIN_SYSBOX)} or newer, upgrade sysbox` : null
  }
  return 'sysbox is not installed on this host (no sysbox-runc runtime in Docker): install sysbox (the privileged dind runtime is for development only: ALLOWED_RUNTIMES=sysbox,dind)'
}

/** Without ALLOWED_RUNTIMES: only sysbox. The privileged dind is for development (a laptop, Docker Desktop) */
export const DEFAULT_ALLOWED_RUNTIMES = ['sysbox']

/** ALLOWED_RUNTIMES: the runtimes new sandboxes may use (comma list, case-insensitive; empty: sysbox), or null = all of them (`all`). */
export function allowedRuntimes(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const list = (env.ALLOWED_RUNTIMES ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  if (list.includes('all')) return null
  return list.length ? list : DEFAULT_ALLOWED_RUNTIMES
}

/** Whether new sandboxes may use this runtime (existing ones keep running whatever it says). */
export function runtimeAllowed(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const allowed = allowedRuntimes(env)
  return !allowed || allowed.includes(name.toLowerCase())
}
