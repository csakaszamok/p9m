import { appsDomain } from './domains'
import fs from 'fs'
import { innerDocker } from './innerDocker'
import { sandboxParent } from './sandboxPaths'
import { rememberLastSeen, lastSeen } from './lastSeen'
import { subdomainOf } from './subdomain'
import { accessOfLabel } from './appAccess/level'

export interface InnerContainer {
  Names: string[]
  Labels: Record<string, string>
  Ports: Array<{ IP?: string; PrivatePort: number; PublicPort?: number; Type: string }>
}
/** `port`: published in the sandbox (what the gateway connects to); `privatePort`: the container's own port,
 * i.e. which service it is; `user`: the `p9m.connect.user` label, the login the Connect… recipes use. */
export interface TcpPort { host: string; port: number; privatePort: number; user?: string }

const dash = (s: string) => s.toLowerCase().replace(/\//g, '-').replace(/_/g, '-')

/** The HTTP name frpc gives a published port (foxglove frpc.tmpl), without the domain. */
export function frpcName(instance: string, labels: Record<string, string>, containerName: string, hostPort: number): string {
  const subdomain = subdomainOf(labels)
  if (subdomain) return `${instance}-${subdomain}`
  const stack = (labels['com.docker.compose.project'] ?? '').toLowerCase().replace(/_/g, '-')
  const container = dash(containerName.replace(/^\//, ''))
  return stack ? `${instance}-${stack}-${container}-port${hostPort}` : `${instance}-${container}-port${hostPort}`
}

export const ALL_INTERFACES = new Set(['', '0.0.0.0', '::'])

/** A raw TCP address passes nobody's sign-in: only a public app has one, or a container that asks for it with
 * `p9m.tcp: "true"` (a database or an SSH server with its own password). An `owner` or `domain` app's port opened
 * at its -tcp address answered anyone, past app access. */
export function tcpAllowed(labels: Record<string, string>, env: NodeJS.ProcessEnv = process.env): boolean {
  if ((labels['p9m.tcp'] ?? '').trim().toLowerCase() === 'true') return true
  return accessOfLabel(labels['p9m.access'], env).access === 'public'
}

/**
 * The -tcp names of the TCP ports published on all interfaces (127.0.0.1-published ports stay private), of the
 * containers that may have them (tcpAllowed).
 * A p9m.subdomain container has one HTTP name for all its ports; when it publishes several, each
 * gets `-port<N>` too, so a name never lands on another port than the one it says.
 */
export function tcpPortsOf(instance: string, containers: InnerContainer[], domain: string, env: NodeJS.ProcessEnv = process.env): TcpPort[] {
  const out: TcpPort[] = []
  const seen = new Set<string>()
  for (const ct of containers) {
    if (!tcpAllowed(ct.Labels ?? {}, env)) continue
    const published = ct.Ports.filter(p => p.Type === 'tcp' && p.PublicPort && ALL_INTERFACES.has(p.IP ?? ''))
    const ports = [...new Set(published.map(p => p.PublicPort!))].sort((a, b) => a - b)
    const user = ct.Labels['p9m.connect.user']
    const subdomain = subdomainOf(ct.Labels)
    for (const port of ports) {
      const base = subdomain && ports.length > 1
        ? `${instance}-${subdomain}-port${port}`
        : frpcName(instance, ct.Labels, ct.Names[0] ?? '', port)
      const host = `${base}-tcp.${domain}`
      if (host === `${instance}-shell-tcp.${domain}`) continue // the sandbox's own SSH address
      if (seen.has(host)) continue
      seen.add(host)
      const privatePort = published.find(p => p.PublicPort === port)!.PrivatePort
      out.push({ host, port, privatePort, ...(user ? { user } : {}) })
    }
  }
  return out
}

/** The sandbox's -tcp addresses, from its inner Docker (throws if that is not reachable, e.g. asleep). */
export async function publicTcpPorts(name: string, usersDir = sandboxParent(name)): Promise<TcpPort[]> {
  const dir = `${usersDir}/${name}`
  const instance = fs.readFileSync(`${dir}/instance-name`, 'utf8').trim()
  const inner = innerDocker(name, usersDir)
  const containers = await inner.listContainers() as unknown as InnerContainer[]
  const ports = tcpPortsOf(instance, containers, appsDomain())
  // Not an empty answer: right after a wake the inner containers are not up yet
  if (ports.length) rememberLastSeen(dir, 'tcp', ports)
  return ports
}

/** The TCP ports a sandbox published when it last ran (null if never seen running since this was added):
 * shown while it sleeps, as a connection wakes it. */
export function rememberedTcpPorts(name: string, usersDir = sandboxParent(name)): TcpPort[] | null {
  const ports = lastSeen(`${usersDir}/${name}`, 'tcp')
  return Array.isArray(ports) ? ports.filter((p): p is TcpPort => typeof p?.host === 'string' && typeof p?.privatePort === 'number') : null
}
