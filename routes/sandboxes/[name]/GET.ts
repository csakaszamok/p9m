import { appsDomain } from '../../../services/domains'
import { requirePrincipal } from '../../../services/principal'
import { getOwnedSandbox } from '../../../services/access'
import { sleepTimes } from '../../../services/sleepTimes'
import { publicTcpPorts, rememberedTcpPorts } from '../../../services/tcpNames'
import { sleepSettingsOf } from '../../../services/sleepSettings'
import { rawNameOf } from '../../../services/naming'
import { sshKeyCount, hasGeneratedKey } from '../../../services/sandboxSsh'
import { limitsOf } from '../../../services/resourceSettings'
import { usageOf } from '../../../services/usageSampler'
import { diskOf } from '../../../services/diskUsage'
import { appLinksForView, rememberedApps } from '../../../services/appLinks'
import { appStatuses } from '../../../services/appProbe'
import { dockerAccessInfo } from '../../../services/dockerAccess'
import { rememberedHub, refreshHub } from '../../../services/hub/list'
import { lastRunningOf } from '../../../services/lastRunning'
import { hubEnabled, hubUrl } from '../../../services/hub/config'
import { mountsOf, hostMountRoots } from '../../../services/hostMounts'
import { markStarted } from '../../../services/docker'
import { isCreating } from '../../../services/wake'

export const openapi = {
  mcp: { name: 'get_sandbox' },
  summary: 'Get sandbox details',
  tags: ['sandboxes'],
  security: [{ bearerAuth: [] }],
  parameters: [{ name: 'include_keys', in: 'query', required: false, description: "true: also the Docker client certificates and private key (ca_cert, client_cert, client_key). Leave it out for an agent: the Claude Code plugin's setup_project_dir writes them to disk without them passing through the model", schema: { type: 'boolean' } }],
  responses: {
    200: { description: 'Sandbox record (the Docker client keys only with include_keys=true); apps: each link with answers true/false (null when not running) and access (p9m.access: public, domain or owner; access_invalid when its label is not one); apps_stale: true when the sandbox runs but did not answer just now (a busy server), and apps are the ones it last had; starting: true after it started, until its apps have all answered (at most 90 s): one that does not answer yet is on its way; mounts: the host folders mounted into it (the admin also gets host_mount_roots); created_in_ms: how long its create took, until its apps answered (none for one made before 0.18.2)' },
    401: { description: 'Unauthorized' },
    404: { description: 'Sandbox not found' }
  }
}

export default async (req: Request): Promise<Response> => {
  const p = requirePrincipal(req)
  if (p instanceof Response) return p
  const name = new URL(req.url).pathname.split('/')[2]
  try {
    const sandbox = await getOwnedSandbox(p, name)
    // Whether each app answers (only a running sandbox is asked; never through Traefik/Sablier)
    // The Docker client keys only when asked for: a private key in an answer goes into an agent's context and transcript
    const withKeys = new URL(req.url).searchParams.get('include_keys') === 'true'
    const { app_services, ca_cert, client_cert, client_key, ...info } = sandbox as typeof sandbox & { ca_cert?: string; client_cert?: string; client_key?: string }
    if (withKeys) Object.assign(info, { ca_cert, client_cert, client_key })
    // apps_stale (from getSandbox): frps or its inner Docker did not answer just now, these are the apps it last had
    const apps = sandbox.status === 'running'
      ? await appStatuses(name, (await appLinksForView(name)).links)
      : withRememberedAccess(name, sandbox.tunnel_urls.map(url => ({ url, port: null, service: app_services?.[url] ?? null, answers: null })))
    // Every app answers: it has started, whatever the time since
    if (info.starting && !info.apps_stale && apps.every(a => a.answers !== false)) {
      delete info.starting
      await markStarted(name)
    }
    // Asleep: the ports it had when it last ran (a connection wakes it)
    const tcp = sandbox.status === 'running' ? await publicTcpPorts(name).catch(() => []) : rememberedTcpPorts(name) ?? []
    const tcp_urls = tcp.map(p => `${p.host}:443`)
    // port: the container's own port, so a client can tell Postgres from SSH (the name may not say)
    const tcp_addresses = tcp.map(p => ({ address: `${p.host}:443`, port: p.privatePort, ...(p.user ? { user: p.user } : {}) }))
    const domain = appsDomain()
    // Which of its apps are on the Hub (what the Hub list last read), and published ones with no web address
    // Running (and the Hub on): read live, so the marker follows a new or removed label at once
    const remembered = hubEnabled() && sandbox.status === 'running'
      ? await refreshHub(name).catch(() => rememberedHub(name))
      : rememberedHub(name)
    const hub = { enabled: hubEnabled(), url: hubEnabled() ? hubUrl() : null, published: remembered?.apps.map(a => a.id) ?? [], unlinked: remembered?.unlinked ?? [], bad_image: remembered?.bad_image ?? [], owner_only: remembered?.owner_only ?? [] }
    // Not running: when it last ran (asleep: its container's stop time; deep sleep: remembered, or estimated)
    const last = await lastRunningOf(name, sandbox.status)
    const ssh = sandbox.ssh ? { address: `${rawNameOf(name) ?? name}-shell-tcp.${domain}:443`, user: 'root', keys: sshKeyCount(name), generated_key: hasGeneratedKey(name) } : null
    // Being created: its half-made containers would read as asleep or deep sleep
    return Response.json({ ...info, ...(isCreating(name) ? { status: 'creating' } : {}), ...(await sleepTimes(name)), idle_timeout: sleepSettingsOf(name).idle_timeout ?? null, tcp_urls, tcp_addresses, apps, ssh, docker_access: dockerAccessInfo(name, sandbox.status), limits: limitsOf(name), disk: diskOf(name), usage: sandbox.status === 'running' ? usageOf(name) : null, hub, last_running_at: last.at, last_running_estimated: last.estimated, mounts: mountsOf(name), ...(p.role === 'admin' ? { host_mount_roots: hostMountRoots() } : {}) })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'error'
    if (msg.includes('not found')) return Response.json({ error: msg }, { status: 404 })
    return Response.json({ error: msg }, { status: 500 })
  }
}

/** Asleep: each app's p9m.access as it was when it last ran */
function withRememberedAccess<T extends { url: string }>(name: string, apps: T[]): Array<T & { access?: string; access_invalid?: true }> {
  const seen = new Map((rememberedApps(name) ?? []).map(l => [l.url, l]))
  return apps.map(a => {
    const l = seen.get(a.url)
    return l ? { ...a, ...(l.project ? { project: l.project } : {}), access: l.access, ...(l.access_invalid ? { access_invalid: true as const } : {}) } : a
  })
}

