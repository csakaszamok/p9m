import crypto from 'node:crypto'
import type { Limits } from './resources'
import { PassThrough } from 'node:stream'
import { composeDeepSleepAfter } from './sleepSettings'
import { managedLabelFilters, readLabel } from './naming'
import { selfContainerId } from './selfContainer'
import Dockerode from 'dockerode'

const docker = new Dockerode({ socketPath: '/var/run/docker.sock' })

/** The engine's API version (e.g. "1.48"; 1.44 is Docker Engine 25). */
export async function engineApiVersion(): Promise<string> {
  return (await docker.version()).ApiVersion
}

let _hostSandboxesDir: string | undefined

export function _resetHostSandboxesDirCache(): void {
  _hostSandboxesDir = undefined
}

const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/$/, '')

/** The host path of p9m's own mount on `destination`, or null when it cannot be told. */
async function ownMountSource(destination: string): Promise<string | null> {
  try {
    const info = await docker.getContainer(selfContainerId()).inspect()
    const mount = (info.Mounts as Array<{ Destination: string; Source: string }>).find(m => m.Destination === destination)
    return mount?.Source ? normalize(mount.Source) : null
  } catch {
    return null
  }
}

/**
 * Host path of opt/sandboxes, which the sandboxes' bind mounts point into: HOST_SANDBOXES_DIR, else the source of
 * p9m's mount on /opt/sandboxes, else /opt/sandboxes (= cannot tell).
 */
export async function resolveHostSandboxesDir(): Promise<string> {
  if (_hostSandboxesDir !== undefined) return _hostSandboxesDir
  const fromEnv = process.env.HOST_SANDBOXES_DIR ? normalize(process.env.HOST_SANDBOXES_DIR) : null
  _hostSandboxesDir = fromEnv ?? (await ownMountSource('/opt/sandboxes')) ?? '/opt/sandboxes'
  return _hostSandboxesDir
}

export async function getContainerIdByName(name: string): Promise<string> {
  const info = await docker.getContainer(name).inspect()
  return info.Id
}

export async function getContainerStatus(containerId: string): Promise<string> {
  const info = await docker.getContainer(containerId).inspect()
  return info.State.Status
}

export interface SandboxMeta {
  name: string
  template: string
  /** p9m.runtime label; "" for sandboxes created before runtimes existed */
  runtime: string
  /** p9m.compose label: "edited" when created from a changed or pasted compose text */
  compose: 'template' | 'edited'
  /** p9m.ssh label: created with an sshd (root, key only) */
  ssh: boolean
  owner: string
  status: string
  container_id: string
  created_at: string
  /** Set when the container is not running because its last start failed (Docker's State.Error) */
  start_error?: string
}

/** Why a stopped container's last start failed, or undefined. */
async function startError(containerId: string): Promise<string | undefined> {
  try {
    const error = (await docker.getContainer(containerId).inspect()).State.Error
    return error || undefined
  } catch {
    return undefined
  }
}

// A stopped container's start error, by its id and Docker's status text: every list asked each asleep sandbox
// again, though nothing changes while it sleeps. A new start (failed or not) changes the status text, so it is asked
// then; the text also changes with its age ("… 3 minutes ago"), so it is asked again at most about once a minute.
const startErrors = new Map<string, { status: string; error: Promise<string | undefined> }>()

function cachedStartError(c: { Id: string; Status: string }): Promise<string | undefined> {
  const hit = startErrors.get(c.Id)
  if (hit?.status === c.Status) return hit.error
  const error = startError(c.Id)
  startErrors.set(c.Id, { status: c.Status, error })
  return error
}

export async function listManagedContainers(): Promise<SandboxMeta[]> {
  const lists = await Promise.all(managedLabelFilters().map(label => docker.listContainers({ all: true, filters: { label: [label] } })))
  const seen = new Set<string>()
  const containers = lists.flat().filter(c => !seen.has(c.Id) && seen.add(c.Id))
  const now = Date.now()
  listedStatus.clear()
  listedAt = now
  for (const c of containers) listedStatus.set(readLabel(c.Labels, 'name') ?? c.Names[0].replace(/^\//, ''), c.Status)
  for (const name of inspected.keys()) if (!listedStatus.has(name)) inspected.delete(name)
  // Containers gone (deep sleep, archived) or running again are not kept
  const stopped = new Set(containers.filter(c => c.State !== 'running').map(c => c.Id))
  for (const id of startErrors.keys()) if (!stopped.has(id)) startErrors.delete(id)
  return Promise.all(containers.map(async c => {
    const meta: SandboxMeta = {
      name: readLabel(c.Labels, 'name') ?? c.Names[0].replace(/^\//, ''),
      template: readLabel(c.Labels, 'template') ?? '',
      runtime: readLabel(c.Labels, 'runtime') ?? '',
      compose: readLabel(c.Labels, 'compose') === 'edited' ? 'edited' : 'template',
      ssh: readLabel(c.Labels, 'ssh') === 'true',
      owner: readLabel(c.Labels, 'owner') ?? 'admin',
      status: c.State,
      container_id: c.Id,
      created_at: readLabel(c.Labels, 'created_at') ?? ''
    }
    // An asleep sandbox and one that cannot start look the same in the list: tell them apart
    if (c.State !== 'running') {
      const error = await cachedStartError(c)
      if (error) meta.start_error = error
    }
    return meta
  }))
}

export interface SandboxState {
  name: string
  status: string
  finishedAt: string
  deepSleepAfter: string | undefined
  /** Attached to a network that no longer exists (e.g. traefik-net re-created): it cannot start again. */
  staleNetwork: boolean
  /** Why the last start failed (Docker's State.Error), empty if it did not */
  error: string
  /** When the container last started (Docker's State.StartedAt) */
  startedAt?: string
  /** When the container was created (Docker's Created): for one recreated while asleep and never started */
  createdAt?: string
}

// The host's network IDs, shared for 2 s: a list of many sandboxes asks for each one's state at once
let networks: { at: number; ids: Promise<Set<string>> } | null = null
function networkIds(fresh = false): Promise<Set<string>> {
  if (!fresh && networks && Date.now() - networks.at < 2000) return networks.ids
  const ids = docker.listNetworks().then(list => new Set(list.map(n => n.Id)))
  ids.catch(() => { networks = null })
  networks = { at: Date.now(), ids }
  return ids
}

/** Current container state of a sandbox, or null if its container does not exist. */
export async function getSandboxState(name: string): Promise<SandboxState | null> {
  try {
    return await stateOf(name, await docker.getContainer(name).inspect())
  } catch {
    return null
  }
}

// Each container's status text as the last list showed it, and when: a list's rows read their state from it
const listedStatus = new Map<string, string>()
let listedAt = 0
const inspected = new Map<string, { status: string; info: Promise<Dockerode.ContainerInspectInfo> }>()
const LISTED_FRESH_MS = 5000

/**
 * As getSandboxState, for a list's rows: the container is inspected again only when its status text changed since
 * (started, stopped, or older by a minute: "Up 5 minutes"), not on every poll of every user. The compose file's
 * settings are read afresh. No list just now: asked as getSandboxState does.
 */
export async function listedSandboxState(name: string): Promise<SandboxState | null> {
  const listed = listedStatus.get(name)
  const fresh = Date.now() - listedAt <= LISTED_FRESH_MS
  // Not in a list just made: no container (deep sleep), nothing to ask Docker
  if (fresh && !listed) return null
  if (!listed || !fresh) return getSandboxState(name)
  let hit = inspected.get(name)
  if (hit?.status !== listed) {
    hit = { status: listed, info: docker.getContainer(name).inspect() }
    inspected.set(name, hit)
    hit.info.catch(() => inspected.delete(name))
  }
  try {
    return await stateOf(name, await hit.info)
  } catch {
    return null
  }
}

/** How long after its container started a sandbox's apps may still be on their way (frpc, the inner stack) */
export const STARTING_MS = 90_000

// A start (the container's StartedAt) whose apps have all answered: it is up, starting no more
const upSince = new Map<string, string>()

/** Running, started less than STARTING_MS ago, and its apps have not all answered yet: an app that does not answer
 * is starting, not broken. */
export async function justStarted(name: string, now = Date.now()): Promise<boolean> {
  const state = await listedSandboxState(name)
  const startedAt = state?.startedAt ?? ''
  return state?.status === 'running' && upSince.get(name) !== startedAt && now - Date.parse(startedAt) < STARTING_MS
}

/** Its apps have all answered: for the rest of this start, one that stops answering is not "starting". */
export async function markStarted(name: string): Promise<void> {
  const startedAt = (await listedSandboxState(name))?.startedAt
  if (startedAt) upSince.set(name, startedAt)
}

async function stateOf(name: string, info: Dockerode.ContainerInspectInfo): Promise<SandboxState> {
  const attached = Object.values(info.NetworkSettings?.Networks ?? {}).map(n => n.NetworkID).filter(Boolean)
  let existing = attached.length ? await networkIds() : new Set<string>()
  // Not in the shared list: maybe created since; only a fresh list may say it is gone (that takes the sandbox down)
  if (attached.some(id => !existing.has(id))) existing = await networkIds(true)
  return {
    name,
    status: info.State.Status,
    finishedAt: info.State.FinishedAt,
    // The compose file is the source of truth (PATCH changes it without recreating the container)
    deepSleepAfter: composeDeepSleepAfter(name) ?? readLabel(info.Config.Labels, 'deep_sleep_after'),
    staleNetwork: attached.some(id => !existing.has(id)),
    error: info.State.Error ?? '',
    startedAt: info.State.StartedAt,
    createdAt: info.Created
  }
}

/** A root shell in the sandbox container (bash if there is one), with a TTY, for the browser terminal. */
export async function openShell(name: string, cols: number, rows: number) {
  return ttyShell(docker.getContainer(name), cols, rows, pidFile => `echo $$ > ${pidFile}; command -v bash >/dev/null && exec bash -l || exec sh -l`,
    { Env: ['TERM=xterm-256color', 'HOME=/root'], WorkingDir: '/root' })
}

export type Shell = Awaited<ReturnType<typeof ttyShell>>

/** A shell with a TTY in any container (the sandbox's, or one in its own Docker), run by `sh -c script(pidFile)`. */
export async function ttyShell(container: Dockerode.Container, cols: number, rows: number, script: (pidFile: string) => string, opts: { Env: string[]; WorkingDir?: string }) {
  // The shell notes its pid (exec keeps it): Docker does not end an exec's process when its connection
  // goes, so closing the terminal HUPs that process group with a second exec
  const pidFile = `/tmp/.p9m-term-${crypto.randomUUID()}`
  const exec = await container.exec({
    Cmd: ['sh', '-c', script(pidFile)],
    AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true,
    ...opts,
  })
  const stream = await exec.start({ hijack: true, stdin: true, Tty: true }) as unknown as NodeJS.ReadWriteStream
  await exec.resize({ h: rows, w: cols }).catch(() => {})
  return {
    stream,
    resize: (c: number, r: number) => exec.resize({ h: r, w: c }).then(() => {}, () => {}),
    exitCode: async () => (await exec.inspect()).ExitCode ?? null,
    kill: async () => {
      const k = await container.exec({ Cmd: ['sh', '-c', `p=$(cat ${pidFile} 2>/dev/null) && { kill -HUP -- -$p $p 2>/dev/null; true; }; rm -f ${pidFile}`] })
      await k.start({ Detach: true })
    },
  }
}

export type DockerStats = {
  cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number; online_cpus?: number }
  precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number }
  memory_stats: { usage?: number; limit?: number; stats?: Record<string, number> }
}

/** Change a sandbox container's limits in place: no restart. */
export async function updateResources(name: string, limits: Limits): Promise<void> {
  await docker.getContainer(name).update({ NanoCpus: Math.round(limits.cpus * 1e9), Memory: limits.memory, MemorySwap: limits.memory })
}

/** One stats sample (Docker waits for a second reading, so precpu_stats is filled in). */
export async function containerStats(name: string): Promise<DockerStats> {
  return await docker.getContainer(name).stats({ stream: false }) as unknown as DockerStats
}

let hostSize: Limits | undefined
/** The OCI runtimes the host's Docker knows (runc, and sysbox-runc where sysbox is installed). */
export async function dockerRuntimes(): Promise<string[]> {
  return Object.keys((await docker.info()).Runtimes ?? {})
}

/** The host's size: how far the admin may raise a sandbox's limits. */
export async function hostResources(): Promise<Limits> {
  if (!hostSize) {
    const i = await docker.info()
    hostSize = { cpus: i.NCPU, memory: i.MemTotal }
  }
  return hostSize
}

/** Runs a command in a sandbox container (no TTY) and returns its exit code and output: for the Files tab. */
export async function execRun(name: string, cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const exec = await docker.getContainer(name).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true })
  const stream = await exec.start({ hijack: true, stdin: false }) as unknown as NodeJS.ReadableStream
  const out: Buffer[] = [], err: Buffer[] = []
  const sink = (into: Buffer[]) => ({ write: (c: Buffer) => { into.push(Buffer.from(c)); return true } }) as unknown as NodeJS.WritableStream
  await new Promise<void>((resolve, reject) => {
    docker.modem.demuxStream(stream, sink(out), sink(err))
    stream.on('end', () => resolve())
    stream.on('error', reject)
  })
  return { code: (await exec.inspect()).ExitCode ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }
}

// Files go in and out through tar in an exec, not Docker's archive API: under sysbox-runc that API finds no path at all
// ("Could not find the file /etc/hostname in container ...").

/** A path in a sandbox container as a tar stream, laid out like Docker's archive API (one entry named after it). */
export async function archiveOf(name: string, path: string): Promise<AsyncIterable<Uint8Array>> {
  const exec = await docker.getContainer(name).exec({ Cmd: ['sh', '-c', 'cd -- "$(dirname -- "$1")" && exec tar -c -- "$(basename -- "$1")"', 'sh', path], AttachStdout: true, AttachStderr: true })
  const stream = await exec.start({ hijack: true, stdin: false }) as unknown as NodeJS.ReadableStream
  const out = new PassThrough(), err: Buffer[] = []
  docker.modem.demuxStream(stream, out, { write: (c: Buffer) => { err.push(Buffer.from(c)); return true } } as unknown as NodeJS.WritableStream)
  stream.on('end', async () => {
    const code = (await exec.inspect().catch(() => null))?.ExitCode
    if (code === 0) out.end()
    else out.destroy(new Error(Buffer.concat(err).toString('utf8').trim() || `Could not read ${path}`))
  })
  stream.on('error', e => out.destroy(e))
  return out
}

/** Unpacks a tar into a folder of a sandbox container; a folder that is not there is a 404, as with the archive API. */
export async function putArchiveTo(name: string, dir: string, tar: Buffer): Promise<void> {
  const exec = await docker.getContainer(name).exec({ Cmd: ['sh', '-c', '[ -d "$1" ] || exit 3; exec tar -x -C "$1"', 'sh', dir], AttachStdin: true, AttachStdout: true, AttachStderr: true })
  const stream = await exec.start({ hijack: true, stdin: true }) as unknown as NodeJS.ReadWriteStream
  const err: Buffer[] = []
  const sink = (into: Buffer[] | null) => ({ write: (c: Buffer) => { into?.push(Buffer.from(c)); return true } }) as unknown as NodeJS.WritableStream
  await new Promise<void>((resolve, reject) => {
    docker.modem.demuxStream(stream, sink(null), sink(err))
    stream.on('end', () => resolve())
    stream.on('error', reject)
    stream.end(tar)
  })
  const code = (await exec.inspect()).ExitCode
  if (code === 3) throw Object.assign(new Error(`No such folder: ${dir}`), { statusCode: 404 })
  if (code !== 0) throw new Error(Buffer.concat(err).toString('utf8').trim() || `Could not write into ${dir}`)
}
