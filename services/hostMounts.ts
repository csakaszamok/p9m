import fs from 'fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'path'
import yaml from 'js-yaml'
import { composeUpService } from './compose'
import { composePathOf } from './sleepSettings'
import { volumeTarget } from './dataVolumes'

/**
 * Host folders the admin mounts into a sandbox (its outer container, so the apps in its own Docker can bind them
 * too). Only folders at or under HOST_MOUNT_ROOTS; unset or empty: the feature is off. A mount gives whoever owns
 * the sandbox (root in it) that host folder, read-only or not.
 *
 * Kept in the sandbox's compose file: a long-syntax bind per mount on the sandbox service, and the list itself in its
 * p9m.mounts label (JSON), which says which binds are ours. Both travel with the file through sleep, deep sleep and
 * the migrations.
 */
export interface HostMount {
  /** The folder on the host */
  host: string
  /** Where it appears in the sandbox container */
  target: string
  readonly: boolean
}

export const MOUNTS_LABEL = 'p9m.mounts'

/** Never a mount target, nor anything under one: the container's own system. */
export const SYSTEM_DIRS = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/libx32', '/proc', '/run', '/sbin', '/sys', '/usr', '/var/run']

/** An absolute path, normalized and without a trailing slash; null if relative, with a .. part, a $ (compose would
 * read it as a variable), a backslash, a comma or a control character. */
export function cleanPath(p: unknown): string | null {
  if (typeof p !== 'string' || !p.startsWith('/')) return null
  if (/[\\$,\x00-\x1f\x7f]/.test(p) || p.split('/').includes('..')) return null
  const n = path.posix.normalize(p)
  return n.length > 1 ? n.replace(/\/+$/, '') : n
}

/** HOST_MOUNT_ROOTS: the usable roots, and the entries left out (not absolute, or with ..). */
export function parseHostMountRoots(raw: string | undefined): { roots: string[]; invalid: string[] } {
  const roots: string[] = [], invalid: string[] = []
  for (const entry of (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const root = cleanPath(entry)
    if (root) { if (!roots.includes(root)) roots.push(root) } else invalid.push(entry)
  }
  return { roots, invalid }
}

export const hostMountRoots = (env: NodeJS.ProcessEnv = process.env) => parseHostMountRoots(env.HOST_MOUNT_ROOTS).roots

const within = (p: string, dir: string) => dir === '/' || p === dir || p.startsWith(`${dir}/`)

/** At or under one of the roots: /srv/shared2 is not under /srv/shared. */
export function underRoot(host: string, roots: string[]): boolean {
  return roots.some(r => within(host, r))
}

type Service = { volumes?: unknown[]; labels?: Record<string, string> }
type Doc = { services?: Record<string, Service | undefined> }

function load(text: string): Doc | null {
  try { return yaml.load(text) as Doc | null } catch { return null }
}

/** The mounts as the p9m.mounts label lists them; [] without the label, or with one that cannot be read. */
export function readMounts(text: string): HostMount[] {
  const raw = load(text)?.services?.sandbox?.labels?.[MOUNTS_LABEL]
  if (typeof raw !== 'string') return []
  try {
    const list = JSON.parse(raw) as unknown
    return Array.isArray(list) ? list.filter((m): m is HostMount => typeof m?.host === 'string' && typeof m?.target === 'string')
      .map(m => ({ host: m.host, target: m.target, readonly: m.readonly === true })) : []
  } catch { return [] }
}

/** Ours among the sandbox's volumes: a bind on one of the label's targets. */
const isOurs = (v: unknown, targets: Set<string>) =>
  typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'bind' && targets.has(String((v as { target?: unknown }).target))

/** Where the sandbox container mounts its own things (docker_data, the data volumes, its files): from its compose
 * file, as the runtime made it; the host mounts are not among them. */
export function ownTargets(text: string): string[] {
  const sb = load(text)?.services?.sandbox
  const ours = new Set(readMounts(text).map(m => m.target))
  return (sb?.volumes ?? []).filter(v => !isOurs(v, ours)).map(volumeTarget).filter((t): t is string => !!t)
}

/** The compose file with exactly these mounts: binds that fail on a missing host folder (no empty one made), and the label. */
export function withMounts(text: string, mounts: HostMount[]): string {
  const doc = load(text)
  const sb = doc?.services?.sandbox
  if (!doc || !sb) throw new Error('its compose file has no sandbox service')
  const before = new Set(readMounts(text).map(m => m.target))
  sb.volumes = [
    ...(sb.volumes ?? []).filter(v => !isOurs(v, before)),
    ...mounts.map(m => ({ type: 'bind', source: m.host, target: m.target, read_only: m.readonly, bind: { create_host_path: false } })),
  ]
  sb.labels = { ...(sb.labels ?? {}) }
  if (mounts.length) sb.labels[MOUNTS_LABEL] = JSON.stringify(mounts)
  else delete sb.labels[MOUNTS_LABEL]
  return yaml.dump(doc, { lineWidth: -1 })
}

/** A request body → the mount to add, or why not. */
export function validateMount(body: unknown, ctx: { roots: string[]; existing: HostMount[]; own: string[] }): HostMount | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'Body must be a JSON object'
  const b = body as Record<string, unknown>
  if (b.host === undefined) return 'host is required: the host folder to mount'
  const host = cleanPath(b.host)
  if (!host) return 'host must be an absolute path, without .. or $'
  if (!underRoot(host, ctx.roots)) return `${host} is not under HOST_MOUNT_ROOTS (${ctx.roots.join(', ')})`
  const defaultTarget = b.target === undefined || b.target === ''
  if (defaultTarget && host === '/') return 'give a target for the host folder /'
  const target = defaultTarget ? `/mnt/${path.posix.basename(host)}` : cleanPath(b.target)
  if (!target) return 'target must be an absolute path, without .. or $'
  if (target === '/') return 'target: not / itself'
  const system = SYSTEM_DIRS.find(d => within(target, d))
  if (system) return `target: ${system} is a system directory of the sandbox container`
  const own = ctx.own.find(o => within(target, o) || within(o, target))
  if (own) return `target: ${target} overlaps the sandbox's own mount ${own}`
  if (ctx.existing.some(m => m.target === target)) return `target: ${target} is already mounted`
  if (b.readonly !== undefined && typeof b.readonly !== 'boolean') return 'readonly must be true or false'
  return { host, target, readonly: b.readonly === true }
}

/** The sandbox's mounts from its compose file; [] if it has none or it cannot be read. */
export function mountsOf(name: string, composePath?: string): HostMount[] {
  try { return readMounts(fs.readFileSync(composePath ?? composePathOf(name), 'utf8')) } catch { return [] }
}

/** A refusal for the API: its HTTP status with it. */
export class MountError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export interface MountDeps {
  composePath?: (name: string) => string
  /** Recreates the sandbox container from the compose file: started, or left stopped */
  recreate?: (composePath: string, start: boolean) => Promise<void>
  /** The mount options of the host filesystem a folder is on (Kata check) */
  mountOptions?: (host: string) => Promise<string[]>
}

const execFileAsync = promisify(execFile)

/** The options of the mount holding this host folder: a bind keeps its source mount's flags, so a throw-away container reads them from the bind, in its /proc/self/mounts (alpine has no findmnt; the last line for /m is the one in effect). --mount, not -v: it errors on a missing folder instead of creating it on the host, and a colon in the path is safe. The timeout keeps a pull or a hung docker from hanging the request. */
export async function hostMountOptions(host: string): Promise<string[]> {
  const { stdout } = await execFileAsync('docker', ['run', '--rm', '--network', 'none', '--mount', `type=bind,src=${host},dst=/m,readonly`, 'alpine', 'awk', '$2 == "/m" { o = $4 } END { print o }', '/proc/self/mounts'], { timeout: 60_000 })
  return stdout.trim().split(',').filter(Boolean)
}

/** Whether the sandbox's compose file says it runs under Kata (an old sandbox's empty runtime label is not). */
const isKata = (text: string) => load(text)?.services?.sandbox?.labels?.['p9m.runtime'] === 'kata'

/** What Docker said (compose's stderr), not "Command failed: docker compose …". */
const dockerWords = (err: unknown) => {
  const stderr = (err as { stderr?: unknown })?.stderr
  return (typeof stderr === 'string' && stderr.trim()) || (err instanceof Error ? err.message : String(err))
}

/** A running sandbox's container recreated: its address shows the waiting page meanwhile, and it counts down to sleep again. */
async function recreateSandbox(name: string, composePath: string, start: boolean): Promise<void> {
  const { markWoken, primeSablierSession } = await import('./wake')
  if (start) markWoken(name)
  await composeUpService(composePath, 'sandbox', start)
  if (start) { markWoken(name); primeSablierSession(name, 150).catch(() => {}) }
}

/**
 * Writes these mounts into the compose file and recreates the sandbox container (the bind mounts are part of it):
 * started if it was running, else left stopped (asleep); in deep sleep it has none, so they apply when it wakes.
 * If Docker refuses (e.g. the host folder does not exist) the file goes back as it was, the container is recreated
 * from it, and the error says what Docker said.
 */
export async function setMounts(name: string, status: string, mounts: HostMount[], deps: MountDeps = {}): Promise<HostMount[]> {
  const file = (deps.composePath ?? composePathOf)(name)
  const recreate = deps.recreate ?? ((f: string, start: boolean) => recreateSandbox(name, f, start))
  const before = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, withMounts(before, mounts))
  if (status === 'deep_sleep') return mounts
  const start = status === 'running'
  try {
    await recreate(file, start)
  } catch (err) {
    fs.writeFileSync(file, before)
    await recreate(file, start).catch(() => {})
    throw new MountError(`Docker refused it, nothing changed: ${dockerWords(err)}`, 409)
  }
  return mounts
}

/** Adds one mount (admin, HOST_MOUNT_ROOTS set): the new list. */
export async function addMount(name: string, status: string, input: unknown, deps: MountDeps & { env?: NodeJS.ProcessEnv } = {}): Promise<HostMount[]> {
  const roots = hostMountRoots(deps.env)
  if (!roots.length) throw new MountError('host mounts are off on this server: set HOST_MOUNT_ROOTS to the host folders that may be mounted', 409)
  const text = fs.readFileSync((deps.composePath ?? composePathOf)(name), 'utf8')
  const existing = readMounts(text)
  const mount = validateMount(input, { roots, existing, own: ownTargets(text) })
  if (typeof mount === 'string') throw new MountError(mount, 400)
  // Guest root of a Kata VM reaches a read-write folder through virtiofsd as host root and could leave setuid-root files there: only nosuid,nodev on the host defuses that
  if (!mount.readonly && isKata(text)) {
    let options: string[]
    try { options = await (deps.mountOptions ?? hostMountOptions)(mount.host) } catch (err) {
      // A missing host folder lands here too (--mount does not create it): what Docker said, not "Command failed: …"
      throw new MountError(`could not read the mount options of ${mount.host} on the host (does the folder exist?): ${dockerWords(err)}`, 400)
    }
    if (!options.includes('nosuid') || !options.includes('nodev')) {
      throw new MountError('A Kata sandbox gets a read-write host folder only where the host mounts it nosuid,nodev; mount it read-only', 400)
    }
  }
  return setMounts(name, status, [...existing, mount], deps)
}

/** Removes the mount on this target (also with the feature off: taking access away is always allowed): the new list. */
export async function removeMount(name: string, status: string, target: string, deps: MountDeps = {}): Promise<HostMount[]> {
  const existing = mountsOf(name, (deps.composePath ?? composePathOf)(name))
  const t = cleanPath(target) ?? target
  if (!existing.some(m => m.target === t)) throw new MountError(`no mount on ${target}`, 404)
  return setMounts(name, status, existing.filter(m => m.target !== t), deps)
}
