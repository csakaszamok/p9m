/**
 * The suggested SANDBOX_MAX_TOTAL for this host. Ideal: how many sandboxes may all use their full CPU and memory
 * limits at once (less 2 GB of memory for Purgatorium and the system). Suggested: twice that, since most of them
 * idle or sleep at any moment, and a full server asks people to put theirs to sleep. The disk caps it: every
 * sandbox, asleep too, may take SANDBOX_DISK. check-host.sh and setup.sh count the same way.
 */
import { selfContainerId } from './selfContainer'

export const OVERCOMMIT = 2
const RESERVED_MEMORY = 2 * 1024 ** 3

export type Bottleneck = 'cpu' | 'memory' | 'disk'
export interface Capacity { ideal: number; suggested: number; by: Bottleneck; cpu: number; memory: number; disk: number | null }

export function capacity(host: { cpus: number; memory: number; disk: number | null }, per: { cpus: number; memory: number; disk: number }): Capacity {
  const cpu = Math.floor(host.cpus / per.cpus)
  const memory = Math.floor(Math.max(0, host.memory - RESERVED_MEMORY) / per.memory)
  const disk = host.disk === null ? null : Math.floor(host.disk / per.disk)
  const ideal = Math.max(1, Math.min(cpu, memory))
  const doubled = ideal * OVERCOMMIT
  const capped = disk !== null && disk < doubled
  return { ideal, suggested: Math.max(1, capped ? disk : doubled), by: capped ? 'disk' : cpu <= memory ? 'cpu' : 'memory', cpu, memory, disk }
}

let free: { bytes: number; at: number } | null = null

/** Free space where Docker keeps its volumes (the sandboxes' data): `df` of a throwaway volume, every 10 minutes. */
export async function dockerDiskFree(): Promise<number | null> {
  if (free && Date.now() - free.at < 10 * 60_000) return free.bytes
  try {
    const { default: Dockerode } = await import('dockerode')
    const docker = new Dockerode({ socketPath: '/var/run/docker.sock' })
    const self = await docker.getContainer(selfContainerId()).inspect()
    const c = await docker.createContainer({
      Image: self.Image, Entrypoint: ['sh', '-c', 'df -Pk /d | tail -1'], Cmd: [], NetworkDisabled: true,
      Volumes: { '/d': {} }, Labels: { 'p9m.helper': 'disk-free' },
    })
    try {
      await c.start()
      await c.wait()
      // df -P: filesystem, size, used, available, capacity%, mount (the log has Docker's frame headers too)
      const kb = Number(/(\d+)\s+(\d+)\s+(\d+)\s+\d+%/.exec((await c.logs({ stdout: true, stderr: false })).toString('utf8'))?.[3])
      if (!Number.isFinite(kb)) return null
      free = { bytes: kb * 1024, at: Date.now() }
      return free.bytes
    } finally {
      await c.remove({ force: true, v: true }).catch(() => {})
    }
  } catch { return null }
}
