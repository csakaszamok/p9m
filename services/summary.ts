import fs from 'fs'
import { isAdminOwner } from './allowlist'
import { quotaLimit, serverLimit, runningLimit } from './quota'
import { archiveDir, ownerOfCompose } from './sandboxPaths'
import type { Capacity } from './capacity'

export interface Counts { max_running?: number | null; quota: number | null; total: number; free: number | null; running: number; asleep: number; deep_sleep: number; archived: number }
/** The host's CPU (cores) and memory (bytes): what running sandboxes use now, and what their limits reserve; disk as measured. */
export interface Resources { cpu: { used: number; reserved: number; host: number }; memory: { used: number; reserved: number; host: number }; disk: { used: number; over: number }; capacity?: Capacity | null }
export type Summary = Counts & {
  by_owner?: Array<Counts & { owner: string }>
  /** The admin: SANDBOX_MAX_TOTAL and the users' sandboxes counted against it */
  server_limit?: number | null
  server_used?: number
  resources?: Resources | null
  /** A user: whether the server limit stops them creating one, whatever their own quota says */
  server_full?: boolean
}

type Live = Array<{ name?: string; owner: string; status: string }>
interface Deps {
  list: () => Promise<Live>
  /** The owner of every archived (deleted) sandbox */
  archived: () => Promise<string[]>
  quota: () => number | null
  server: () => number | null
  /** The running limit per user (SANDBOX_QUOTA) */
  running: () => number | null
  resources: (live: Live) => Promise<Resources | null>
}

const defaultDeps: Deps = {
  list: async () => { const { sandboxService } = await import('./sandbox'); return sandboxService.listSandboxStates() },
  archived: () => archivedOwners(),
  quota: () => quotaLimit(),
  running: () => runningLimit(),
  server: () => serverLimit(),
  resources: async live => {
    try {
      const [{ usageOf }, { limitsOf }, { diskOf, diskDefault }, { hostResources }, { capacity, dockerDiskFree }, { resourceDefaults }] = await Promise.all([import('./usageSampler'), import('./resourceSettings'), import('./diskUsage'), import('./docker'), import('./capacity'), import('./resources')])
      const host = await hostResources()
      const running = live.filter(s => s.status === 'running' && s.name)
      const r: Resources = { cpu: { used: 0, reserved: 0, host: host.cpus }, memory: { used: 0, reserved: 0, host: host.memory }, disk: { used: 0, over: 0 } }
      for (const s of running) {
        const u = usageOf(s.name!), l = limitsOf(s.name!)
        r.cpu.used += u?.cpu ?? 0; r.memory.used += u?.memory ?? 0
        r.cpu.reserved += l?.cpus ?? 0; r.memory.reserved += l?.memory ?? 0
      }
      for (const s of live) if (s.name) { const d = diskOf(s.name); r.disk.used += d.used ?? 0; if (d.over) r.disk.over++ }
      r.cpu.used = Math.round(r.cpu.used * 100) / 100
      // The disk for sandboxes: what is free, and what theirs already take
      const free = await dockerDiskFree()
      r.capacity = capacity({ ...host, disk: free === null ? null : free + r.disk.used }, { ...resourceDefaults().limits, disk: diskDefault().bytes })
      return r
    } catch { return null }
  },
}

/** Running (also one being created: it takes a place already), deep sleep, and everything else asleep (stopped, also
 *  one that failed to start). */
function counts(live: Array<{ status: string }>, archived: number, quota: number | null): Counts {
  const running = live.filter(s => s.status === 'running' || s.status === 'creating').length
  const deep_sleep = live.filter(s => s.status === 'deep_sleep').length
  const total = live.length
  return { quota, total, free: quota === null ? null : Math.max(0, quota - running), running, asleep: total - running - deep_sleep, deep_sleep, archived }
}

/** A user: their own sandboxes against their quota. The admin: the whole server, and per owner. */
export async function summaryFor(p: { sub: string; role: 'user' | 'admin' }, deps: Deps = defaultDeps): Promise<Summary> {
  const [live, archived] = await Promise.all([deps.list(), deps.archived()])
  // The admin has no quota (as at create)
  const quotaOf = (owner: string) => (isAdminOwner(owner) ? null : deps.quota())
  const server = deps.server()
  // Places on the server (SANDBOX_MAX_TOTAL): the running sandboxes, the admin's too; asleep ones take none
  const used = live.filter(s => s.status === 'running').length
  if (p.role !== 'admin') {
    return { ...counts(live.filter(s => s.owner === p.sub), archived.filter(o => o === p.sub).length, deps.quota()), max_running: deps.running(), server_full: server !== null && used >= server }
  }
  const owners = [...new Set([...live.map(s => s.owner), ...archived])].sort()
  return {
    ...counts(live, archived.length, null),
    by_owner: owners.map(owner => ({ owner, ...counts(live.filter(s => s.owner === owner), archived.filter(o => o === owner).length, quotaOf(owner)), max_running: isAdminOwner(owner) ? null : deps.running() })),
    server_limit: server,
    server_used: used,
    resources: await deps.resources(live),
  }
}

let cached: { dir: string; at: number; owners: string[] } | null = null

/**
 * The owner of every archive: opt/archive/<owner>/<entry>/ (manifest `owner`, else its compose file's label), and
 * flat opt/archive/<entry>/ ones not moved yet (the label, admin without one). An archive has a manifest and the
 * sandbox's config: a save of orphan volumes has no config.
 */
export async function archivedOwners(dir = archiveDir()): Promise<string[]> {
  if (cached && cached.dir === dir && Date.now() - cached.at < 30_000) return cached.owners
  let names: string[]
  try { names = fs.readdirSync(dir).map(String) } catch { return [] }
  const owners: string[] = []
  const ownerOf = (entry: string): string | null => {
    if (!fs.existsSync(`${entry}/manifest.json`) || !fs.existsSync(`${entry}/config`)) return null
    try {
      const m = JSON.parse(fs.readFileSync(`${entry}/manifest.json`, 'utf8')) as { owner?: unknown }
      if (typeof m.owner === 'string' && m.owner) return m.owner
    } catch { /* unreadable manifest: the label */ }
    try { return ownerOfCompose(fs.readFileSync(`${entry}/config/docker-compose.yml`, 'utf8')) } catch { return 'admin' }
  }
  for (const n of names) {
    const flat = ownerOf(`${dir}/${n}`)
    if (flat !== null) { owners.push(flat); continue }
    if (fs.existsSync(`${dir}/${n}/manifest.json`)) continue // orphan volumes
    let inner: string[] = []
    try { inner = fs.readdirSync(`${dir}/${n}`).map(String) } catch { continue }
    for (const e of inner) {
      const o = ownerOf(`${dir}/${n}/${e}`)
      if (o !== null) owners.push(o)
    }
  }
  cached = { dir, at: Date.now(), owners }
  return owners
}
