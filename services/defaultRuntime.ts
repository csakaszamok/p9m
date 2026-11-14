import { dockerRuntimes } from './docker'
import { kataNewEnough, kataVersion, MIN_KATA } from './kataVersion'
import { loadRuntime } from './runtimeLoader'
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

/** The OCI runtime a runtime's sandbox service asks Docker for (sysbox-runc, kata), or null: none (dind) or an unknown runtime. */
function ociRuntimeOf(name: string): string | null {
  try {
    const services = loadRuntime(name).docker_compose.services as Record<string, { runtime?: unknown }> | undefined
    const runtime = services?.sandbox?.runtime
    return typeof runtime === 'string' ? runtime : null
  } catch { return null }
}

/** Why this runtime cannot run on this host, or null: its OCI runtime is not in Docker, or its version is too old for the sandbox image. */
export async function runtimeMissing(name: string): Promise<string | null> {
  const oci = ociRuntimeOf(name)
  if (!oci) return null
  if (!(await hostRuntimes()).includes(oci)) {
    if (name === 'sysbox') return 'sysbox is not installed on this host (no sysbox-runc runtime in Docker): install sysbox (the privileged dind runtime is for development only: ALLOWED_RUNTIMES=sysbox,dind)'
    if (name === 'kata') return 'Kata is not installed on this host (no kata runtime in Docker): run scripts/install-kata.sh (needs KVM)'
    return `${name} is not installed on this host (no ${oci} runtime in Docker)`
  }
  if (name === 'sysbox') {
    const version = await sysboxVersion()
    return version && !sysboxNewEnough(version) ? `sysbox ${versionText(version)} on this host is too old: the sandbox image needs ${versionText(MIN_SYSBOX)} or newer, upgrade sysbox` : null
  }
  if (name === 'kata') {
    const version = await kataVersion()
    return version && !kataNewEnough(version) ? `kata ${versionText(version)} on this host is too old: the sandbox image needs ${versionText(MIN_KATA)} or newer, upgrade Kata` : null
  }
  return null
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
