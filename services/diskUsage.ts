import fs from 'fs'
import { selfContainerId } from './selfContainer'
import yaml from 'js-yaml'
import { parseMemory } from './resources'
import { writeFileAtomic } from './atomicWrite'
import { composePathOf } from './sleepSettings'
import { measureBinds } from './dataVolumes'
import { parseComposeText } from './composeCache'

/**
 * Disk use per sandbox, against a limit that only warns: everything a sandbox keeps (inner images, containers,
 * volumes) is in its one `docker_data` volume, measured from outside with `du`. Nothing is stopped or refused.
 */

const LABEL = 'p9m.disk_limit'
const FALLBACK = '20g'

export interface DiskInfo { limit: number; used: number | null; measured_at: string | null; over: boolean }
interface Measured { used: number; at: string; running: boolean }

function file(): string {
  return process.env.DISK_USAGE_FILE ?? '/app/data/disk-usage.json'
}

let cache: Map<string, Measured> | null = null
function store(): Map<string, Measured> {
  if (!cache) {
    cache = new Map()
    try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file(), 'utf8')) as Record<string, Measured>)) cache.set(k, v) } catch { /* none yet */ }
  }
  return cache
}
function save(): void {
  try { writeFileAtomic(file(), JSON.stringify(Object.fromEntries(store()), null, 2)) } catch (err) { console.error('[disk] cannot save the measurements:', err instanceof Error ? err.message : err) }
}

/** Tests: forget the measurements (and their file, unless `keepFile`: as after a restart). */
export function _resetDiskUsage(opts: { keepFile?: boolean } = {}): void {
  cache = null
  if (!opts.keepFile) fs.rmSync(file(), { force: true })
}

/** SANDBOX_DISK: what a sandbox may use before it is warned about, 20 GB by default. */
export function diskDefault(env: NodeJS.ProcessEnv = process.env): { bytes: number; warnings: string[] } {
  const raw = env.SANDBOX_DISK
  if (raw === undefined || raw === '') return { bytes: parseMemory(FALLBACK)!, warnings: [] }
  const v = parseMemory(raw)
  return v === null
    ? { bytes: parseMemory(FALLBACK)!, warnings: [`SANDBOX_DISK=${raw} is not a size like 20g: using ${FALLBACK}`] }
    : { bytes: v, warnings: [] }
}

type Doc = { services?: Record<string, { labels?: Record<string, string> | string[] }> }

/** The sandbox's own disk limit (a label the admin set), else SANDBOX_DISK. */
export function diskLimitOf(name: string, composePath = composePathOf(name)): number {
  try {
    const labels = (parseComposeText(fs.readFileSync(composePath, 'utf8')) as Doc | null)?.services?.sandbox?.labels
    const v = labels && !Array.isArray(labels) ? parseMemory(String(labels[LABEL] ?? '')) : null
    if (v !== null) return v
  } catch { /* no compose file: the default */ }
  return diskDefault().bytes
}

export function withDiskLimit(composeText: string, bytes: number): string {
  const doc = (yaml.load(composeText) ?? {}) as Doc
  const sb = doc.services?.sandbox
  if (!sb) throw new Error('This sandbox has no sandbox service in its compose file')
  if (Array.isArray(sb.labels)) throw new Error('This sandbox lists its labels as an array: its disk limit cannot be changed')
  sb.labels = { ...sb.labels, [LABEL]: `${Math.round(bytes / 1024 ** 2)}m` }
  return yaml.dump(doc, { lineWidth: -1 })
}

export async function setDiskLimit(name: string, bytes: number, composePath = composePathOf(name)): Promise<void> {
  fs.writeFileSync(composePath, withDiskLimit(fs.readFileSync(composePath, 'utf8'), bytes))
}

export function diskOf(name: string, composePath = composePathOf(name)): DiskInfo {
  const limit = diskLimitOf(name, composePath)
  const m = store().get(name)
  return { limit, used: m?.used ?? null, measured_at: m?.at ?? null, over: m ? m.used > limit : false }
}

/**
 * One round: a running sandbox again once `intervalMs` passed; an asleep one once after it stopped
 * (its size does not change while it sleeps). One at a time; a failure keeps the last measurement.
 */
export async function measureOnce(deps: {
  list: () => Promise<Array<{ name: string; status: string }>>
  measure: (name: string) => Promise<number>
  /** Being created or woken: not now (a create taken back removes its volumes, and a bind by name would make one again) */
  busy?: (name: string) => boolean
  now?: () => Date
  intervalMs?: number
}): Promise<void> {
  const now = deps.now ?? (() => new Date())
  const interval = deps.intervalMs ?? 15 * 60_000
  const all = await deps.list().catch(() => null)
  if (!all) return
  const s = store()
  const names = new Set(all.map(x => x.name))
  let changed = false
  for (const name of [...s.keys()]) if (!names.has(name)) { s.delete(name); changed = true }
  for (const sb of all) {
    const last = s.get(sb.name)
    const running = sb.status === 'running'
    const due = !last || (running ? now().getTime() - Date.parse(last.at) >= interval : last.running)
    if (!due || deps.busy?.(sb.name)) continue
    try {
      const used = await deps.measure(sb.name)
      s.set(sb.name, { used, at: now().toISOString(), running })
      changed = true
    } catch (err) {
      console.error(`[disk] ${sb.name}: cannot measure:`, err instanceof Error ? err.message : err)
    }
  }
  if (changed) save()
}

/** `du` of the sandbox's docker_data volume in a short-lived container of our own image (no pull, no network). */
export async function measureVolume(name: string): Promise<number> {
  const { default: Dockerode } = await import('dockerode')
  const docker = new Dockerode({ socketPath: '/var/run/docker.sock' })
  // Every volume of the sandbox: docker_data and the data volumes (/opt, /root, /home, /srv)
  const { Volumes } = await docker.listVolumes({ filters: JSON.stringify({ label: [`com.docker.compose.project=${name}`] }) })
  const volumes = (Volumes ?? []).map(v => v.Name)
  if (!volumes.length) throw new Error('no volume')
  const self = await docker.getContainer(selfContainerId()).inspect()
  const container = await docker.createContainer({
    Image: self.Image,
    Entrypoint: ['sh', '-c', 'nice -n 19 du -sck /d/* | tail -1'],
    Cmd: [],
    NetworkDisabled: true,
    HostConfig: { Binds: measureBinds(volumes), AutoRemove: false },
    Labels: { 'p9m.helper': 'disk-usage' },
  })
  try {
    await container.start()
    const { StatusCode } = await Promise.race([
      container.wait() as Promise<{ StatusCode: number }>,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('du took longer than 10 minutes')), 10 * 60_000).unref?.()),
    ])
    const out = (await container.logs({ stdout: true, stderr: false })).toString('utf8')
    const kb = Number(/(\d+)\s+total/.exec(out)?.[1])
    if (StatusCode !== 0 && !Number.isFinite(kb)) throw new Error(`du exited with ${StatusCode}`)
    if (!Number.isFinite(kb)) throw new Error('du gave no size')
    return kb * 1024
  } finally {
    await container.remove({ force: true }).catch(() => {})
  }
}

let timer: NodeJS.Timeout | undefined
/** Checks every minute which sandboxes are due (see measureOnce); one round at a time. */
export function startDiskSampler(): void {
  if (timer) return
  for (const w of diskDefault().warnings) console.warn(`[disk] ${w}`)
  let busy = false
  const tick = () => {
    if (busy) return
    busy = true
    Promise.all([import('./sandbox'), import('./wake')])
      .then(([{ sandboxService }, { wakeInProgress }]) => measureOnce({ list: () => sandboxService.listSandboxStates(), measure: measureVolume, busy: wakeInProgress }))
      .catch(err => console.error('[disk]', err instanceof Error ? err.message : err))
      .finally(() => { busy = false })
  }
  timer = setInterval(tick, 60_000)
  setTimeout(tick, 30_000).unref?.()
}
