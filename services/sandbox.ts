import { generateSandboxName } from './sandboxNames'
import { appsDomain } from './domains'
import { publicUrl } from './session'
import { frpsToml, newFrpsApiPassword } from './frpsApi'
import { createStepTimer } from './stepTimer'
import { startIntervalSupported, withoutStartInterval } from './healthcheckCompat'
import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import crypto from 'node:crypto'
import vm from 'node:vm'
import bcrypt from 'bcryptjs'
import { generateCertBundle } from './tls'
import { loadTemplate } from './templateLoader'
import { loadRuntime } from './runtimeLoader'
import { appEntriesOffline, appHostsFromCompose } from './appUrls'
import { waitForTunnels } from './tunnelWait'
import { appLinks, appLinksForView, frpsDomains, rememberedApps } from './appLinks'
import { primeSablierSession, markWoken, markCreating, creatingDone, isCreating } from './wake'
import { writeAuthorizedKeys, createGeneratedKey } from './sandboxSsh'
import { sshKeysOf } from './sshKeys'
import { resourceDefaults, memoryForCompose, type Limits } from './resources'
import { sandboxName, rawNameOf, readLabel } from './naming'
import { sessionDurationOf, cappedSleepDefault } from './sleepSettings'
import { listManagedContainers, resolveHostSandboxesDir, execRun, justStarted, type SandboxMeta } from './docker'
import { sandboxDir, sandboxParent, listSandboxDirs, newSandboxDir, archiveRoot, ownerDirName, ownerOfCompose, sandboxesDir, forgetSandboxDir, sandboxesMounted, SANDBOX_NAME } from './sandboxPaths'
import { composeUp, composeStop, composeStart, composeDown, composeUpInner } from './compose'
import { concurrency } from './concurrency'
import { parseComposeText } from './composeCache'
import { hashPassword } from './registryAuth'
import { ownHostTaken, uiHost } from './uiHost'
import { userHost } from './userHost'
import { listProjectVolumes, exportVolume, removeVolume, stopProjectContainers, removeProjectContainers } from './project'

/** The sandbox's directory; for an unknown one a path that does not exist (reads then fail as before). */
const dirOf = (name: string) => sandboxDir(name) ?? `${sandboxParent(name)}/${name}`

/** Removes an owner directory its last sandbox has left. */
/** How long its create took, from its created-in file (see createSandbox); undefined when not kept. */
function createdInMs(dir: string): number | undefined {
  let text: string
  try { text = fs.readFileSync(`${dir}/created-in`, 'utf8') } catch { return undefined }
  const ms = Number(String(text).trim())
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : undefined
}

function removeEmptyOwnerDir(dir: string): void {
  const parent = path.posix.dirname(dir)
  if (path.posix.dirname(parent) !== sandboxesDir()) return
  try { if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent) } catch { /* gone or not empty */ }
}

export interface SandboxInfo extends SandboxMeta {
  ca_cert: string
  client_cert: string
  client_key: string
  /** host → compose service, for a sandbox that is not running (not sent by the API) */
  app_services?: Record<string, string>
  tunnel_urls: string[]
  /** Running, but frps or its inner Docker did not answer just now: tunnel_urls are the ones it last answered with */
  apps_stale?: true
  /** Started less than STARTING_MS ago and its apps have not all answered yet: they are on their way */
  starting?: true
  extras: Record<string, string>
  /** How long its create took (ms), up to its apps answering; none for a sandbox made before 0.18.2 */
  created_in_ms?: number
}

export interface CreateSandboxResult {
  name: string
  docker_host: string
  ca_cert: string
  client_cert: string
  client_key: string
  tunnel_urls: string[]
  registry_url: string
  registry_username: string
  registry_password: string
  extras: Record<string, string>
  /** The sandbox's generated SSH private key (SSH runtimes only); also GET /sandboxes/:name/ssh-key */
  ssh_private_key?: string
}

/** ${key} → value; a $ in a value becomes $$ so docker compose keeps it literal. */
function applyVarsText(text: string, vars: Record<string, string>): string {
  let str = text
  for (const [key, value] of Object.entries(vars)) {
    str = str.split(`\${${key}}`).join(value.replace(/\$/g, '$$$$'))
  }
  return str
}

function applyVars(composeObj: Record<string, unknown>, vars: Record<string, string>): string {
  return applyVarsText(yaml.dump(composeObj, { lineWidth: -1 }), vars)
}


async function runBeforeScript(
  script: string,
  ctx: { name: string; rawName: string; hostDomain: string; scheme: string }
): Promise<Record<string, string>> {
  const context = vm.createContext({ crypto, fs, path, bcrypt, ...ctx, console })
  const result = await vm.runInNewContext(`(async () => { ${script} })()`, context) as unknown
  return result && typeof result === 'object' ? result as Record<string, string> : {}
}

function removeDynamicConfig(name: string): void {
  const dir = process.env.TRAEFIK_DYNAMIC_DIR ?? '/app/traefik-dynamic'
  const file = path.join(dir, `sandbox-${name}.yml`)
  try { fs.unlinkSync(file) } catch { /* already gone */ }
}

/** Empty for a sandbox whose directory is gone (a leftover): its panel still opens, so it can be deleted. */
function readClientCerts(name: string): { ca_cert: string; client_cert: string; client_key: string } {
  const read = (f: string) => { try { return fs.readFileSync(`${dirOf(name)}/certs/${f}`, 'utf8') } catch { return '' } }
  return { ca_cert: read('server/ca.pem'), client_cert: read('client/cert.pem'), client_key: read('client/key.pem') }
}

/**
 * Sablier only puts a sandbox to sleep once it has a session, and only an HTTP request through
 * the sandbox router opens one. Opened here after every start, in the background, so a sandbox
 * nobody has opened yet still counts down and sleeps after its idle timeout.
 */
function openSleepSession(name: string): void {
  // Up to 2.5 min: the router appears only once socat is healthy (the tunnel is up), which can take a while
  primeSablierSession(name, 150).catch(() => {})
}

/** The sandbox's dockerd settings: the Docker Hub cache, and the p9m registry as an insecure registry (reached
 * through Traefik on the internal network, whose public certificate the sandbox cannot verify). */
export function daemonJson(hostDomain: string, runtimeDaemonJson: Record<string, unknown> = {}): string {
  const cacheHost = process.env.REGISTRY_CACHE_HOST ?? 'registry-cache:5000'
  return JSON.stringify({ 'registry-mirrors': [`http://${cacheHost}`], 'insecure-registries': [cacheHost, `registry.${hostDomain}`], ...runtimeDaemonJson }, null, 2)
}


/** Sandbox dir with a compose file but no containers = deep sleep. Template info comes from the compose labels. */
function deepSleepMeta(name: string): SandboxMeta | null {
  if (!SANDBOX_NAME.test(name)) return null
  const composePath = `${dirOf(name)}/docker-compose.yml`
  if (!fs.existsSync(composePath)) return null
  let labels: Record<string, string> = {}
  try {
    const compose = parseComposeText(fs.readFileSync(composePath, 'utf8')) as { services?: { sandbox?: { labels?: Record<string, string> } } } | null
    labels = compose?.services?.sandbox?.labels ?? {}
  } catch { /* unreadable compose: report without template info */ }
  return { name, template: readLabel(labels, 'template') ?? '', runtime: readLabel(labels, 'runtime') ?? '', compose: readLabel(labels, 'compose') === 'edited' ? 'edited' : 'template', ssh: readLabel(labels, 'ssh') === 'true', owner: readLabel(labels, 'owner') ?? 'admin', status: 'deep_sleep', container_id: '', created_at: readLabel(labels, 'created_at') ?? '' }
}

function deepSleepingSandboxes(live: SandboxMeta[]): SandboxMeta[] {
  const liveNames = new Set(live.map(s => s.name))
  return listSandboxDirs().map(e => e.name)
    .filter(n => !liveNames.has(n))
    .map(deepSleepMeta)
    .filter((m): m is SandboxMeta => m !== null)
}

/**
 * Raw (unprefixed) names of every sandbox that currently exists, live or
 * deep-sleeping (URLs are built from the raw name), so createSandbox can check
 * a new raw name against them.
 */
function existingRawNames(containers: SandboxMeta[]): Set<string> {
  const names = new Set<string>()
  const add = (n: string) => { const raw = rawNameOf(n); if (raw) names.add(raw) }
  for (const c of containers) add(c.name)
  for (const e of listSandboxDirs()) add(e.name)
  return names
}

/**
 * Traefik's sandbox router is HostRegexp(`^${raw_name}-[a-z0-9-]+[.]domain$`),
 * and Traefik prefers the longer/more specific rule. So if raw name R is a
 * strict prefix of an existing raw name E (or vice versa) followed by '-',
 * one sandbox's router would also match the other's hosts and hijack its
 * traffic. Returns the conflicting existing raw name, or null if none.
 */
function conflictingRawName(rawName: string, existingNames: Set<string>): string | null {
  for (const e of existingNames) {
    if (e === rawName) continue
    if (rawName.startsWith(`${e}-`) || e.startsWith(`${rawName}-`)) return e
  }
  return null
}

/**
 * The apps of a sandbox that is not running, for its details and the list: only a running sandbox has a tunnel
 * to ask (a stopped one's frps host does not resolve: seconds of DNS timeout). The apps it had when it last ran,
 * or (never seen running) those of the inner compose file; opening one wakes the sandbox.
 */
function offlineApps(meta: SandboxMeta): Array<{ host: string; service: string }> {
  const innerProject = () => { try { return loadTemplate(meta.template).inner_project_name } catch { return undefined } }
  return rememberedApps(meta.name)?.map(l => ({ host: l.url, service: l.service }))
    ?? appEntriesOffline(meta.name, dirOf(meta.name), appsDomain(), innerProject)
}

export const sandboxService = {
  /** A free name for a new sandbox nobody named (sandboxNames.ts): no sandbox has it or conflicts with it, and it
   *  would not take one of Purgatorium's own addresses. Null when none was found. From the sandbox directories only
   *  (a directory listing): asking Docker about every container took 10-20 s on a busy server; the create checks the
   *  containers again, and a create without a name draws another one on a clash. */
  async suggestName(): Promise<string | null> {
    const rawNames = existingRawNames([])
    return generateSandboxName(raw => !rawNames.has(raw) && !conflictingRawName(raw, rawNames) && !ownHostTaken(raw))
  },

  /** Creates a sandbox; while it does, a request to its address waits instead of starting it (wake.ts). */
  async createSandbox(rawName: string, createInnerStack = true, idleTimeout?: string, deepSleepAfter?: string, owner = 'admin', templateName?: string, runtimeName?: string, sshKeys?: string[], limits?: Limits): Promise<CreateSandboxResult> {
    const name = sandboxName(rawName)
    // One at a time per name: a second create of the same name (another user at the same moment) passed the
    // "does it exist" check before the first made its directory, and both worked on one sandbox
    if (!markCreating(name)) throw new Error(`Sandbox already exists: ${name}`)
    const marked = true
    try {
      return await this.createSandboxUnmarked(rawName, createInnerStack, idleTimeout, deepSleepAfter, owner, templateName, runtimeName, sshKeys, limits)
    } finally {
      if (marked) creatingDone(name)
    }
  },

  async createSandboxUnmarked(rawName: string, createInnerStack = true, idleTimeout?: string, deepSleepAfter?: string, owner = 'admin', templateName?: string, runtimeName?: string, sshKeys?: string[], limits?: Limits): Promise<CreateSandboxResult> {
    // || : an empty variable (DEFAULT_TEMPLATE= in .env) means unset, as in POST /sandboxes
    const resolvedTemplateName = templateName ?? (process.env.DEFAULT_TEMPLATE || 'starter')
    const resolvedRuntimeName = runtimeName ?? await (await import('./defaultRuntime')).defaultRuntime()
    const hostAddress = process.env.HOST_ADDRESS ?? '127.0.0.1'
    const hostDomain = process.env.HOST_DOMAIN ?? 'lvh.me'
    const registryUrl = `registry.${hostDomain}`
    // The sandbox's own addresses (apps, TCP, Docker): ${host_domain} in runtimes and templates, hostDomain in a before_script
    const appDomain = appsDomain()
    const name = sandboxName(rawName)
    // One line at the end says where the time went
    const timer = createStepTimer()

    if (sandboxDir(name) !== null) throw new Error(`Sandbox already exists: ${name}`)
    if (!sandboxesMounted()) throw new Error('opt/sandboxes is not mounted from the host (see docker-compose.yml): a sandbox created now would be lost')
    const dir = newSandboxDir(owner, name)
    const existing = await listManagedContainers()
    const rawNames = existingRawNames(existing)
    // Same raw name under another prefix (SANDBOX_PREFIX changed) would share every URL.
    if (rawNames.has(rawName)) throw new Error(`Sandbox already exists: ${rawName}`)

    const conflict = conflictingRawName(rawName, rawNames)
    if (conflict) {
      throw new Error(`Sandbox name "${rawName}" conflicts with an existing sandbox: ${conflict}`)
    }
    // Its router would also answer for one of Purgatorium's own addresses (a UI_HOST of console-admin.<domain>)
    const own = ownHostTaken(rawName)
    if (own) throw new Error(`Sandbox name "${rawName}" would take Purgatorium's own address ${own}`)

    // Both before anything is written: an unknown name must not leave a half-made sandbox dir behind
    const runtime = loadRuntime(resolvedRuntimeName)
    const template = loadTemplate(resolvedTemplateName)
    // Same for the SSH key store, which authorized_keys is written from below
    try { sshKeysOf(owner) } catch (err) {
      throw new Error(`SSH key store unreadable (data/ssh-keys.json): ${err instanceof Error ? err.message : err}`)
    }

    // Where opt/sandboxes is on the host, for the sandbox's bind mounts. /opt/sandboxes without HOST_SANDBOXES_DIR is
    // resolveHostSandboxesDir's "cannot tell": a sandbox mounted under a guess restarts for ever, so none is made
    const hostSandboxesDir = await resolveHostSandboxesDir()
    if (hostSandboxesDir === '/opt/sandboxes' && !process.env.HOST_SANDBOXES_DIR) {
      throw new Error("Purgatorium cannot tell where opt/sandboxes is on the host (it could not inspect its own container): set HOST_SANDBOXES_DIR in .env to its full path (e.g. /opt/p9m/opt/sandboxes), then docker compose up -d")
    }

    const services = (runtime.docker_compose.services ?? {}) as Record<string, unknown>
    const hasFrps = 'frps' in services

    // <raw>-docker.<domain>: where a Docker CLI reaches this dockerd through the gateway (TLS passed through)
    timer.lap('checks')
    const certs = generateCertBundle(hostAddress, name, 2048, [`${rawName}-docker.${appDomain}`])
    timer.lap('certificates')
    const createdAt = new Date().toISOString()

    const serverCertsDir = `${dir}/certs/server`
    const clientCertsDir = `${dir}/certs/client`
    fs.mkdirSync(serverCertsDir, { recursive: true })
    fs.mkdirSync(clientCertsDir, { recursive: true })
    fs.writeFileSync(path.join(serverCertsDir, 'ca.pem'), certs.caCert)
    fs.writeFileSync(path.join(serverCertsDir, 'cert.pem'), certs.serverCert)
    fs.writeFileSync(path.join(serverCertsDir, 'key.pem'), certs.serverKey)
    fs.writeFileSync(path.join(clientCertsDir, 'cert.pem'), certs.clientCert)
    fs.writeFileSync(path.join(clientCertsDir, 'key.pem'), certs.clientKey)
    fs.writeFileSync(path.join(clientCertsDir, 'ca.pem'), certs.caCert)

    fs.writeFileSync(`${dir}/instance-name`, rawName)
    fs.mkdirSync(`${dir}/inner`, { recursive: true })
    fs.writeFileSync(`${dir}/daemon.json`, daemonJson(hostDomain, runtime.daemon_json))

    const frpToken = crypto.randomBytes(16).toString('hex')
    const frpsApiPassword = newFrpsApiPassword()
    if (hasFrps) fs.writeFileSync(`${dir}/frps.toml`, frpsToml(frpToken, frpsApiPassword))

    const vars: Record<string, string> = {
      name,
      raw_name: rawName,
      runtime_name: runtime.name,
      template_name: template.name,
      // p9m.compose label: "edited" on sandboxes made from a changed compose text before it was removed
      compose_source: 'template',
      created_at: createdAt,
      // ${host_users_dir}/${name} (custom runtimes) and ${sandbox_dir} both name the sandbox's own directory
      host_users_dir: `${hostSandboxesDir}/${ownerDirName(owner)}`,
      sandbox_dir: `${hostSandboxesDir}/${ownerDirName(owner)}/${name}`,
      host_domain: appDomain,
      frp_token: frpToken,
      frps_api_auth: `p9m:${frpsApiPassword}`,
      // Names the sandbox reaches through its socat (Traefik): the registry, the UI and the users' address (the UI's when off)
      registry_host: registryUrl,
      ui_host: uiHost(),
      user_host: userHost() ?? uiHost(),
      // A template's default, cut to the server's limit for a user's sandbox
      idle_timeout: sessionDurationOf(idleTimeout ?? cappedSleepDefault('idle_timeout', template.idle_timeout ?? '30m', owner)),
      deep_sleep_after: deepSleepAfter ?? cappedSleepDefault('deep_sleep_after', template.deep_sleep_after ?? '7d', owner),
      owner: JSON.stringify(owner),
      cpus: String((limits ?? resourceDefaults().limits).cpus),
      memory: memoryForCompose((limits ?? resourceDefaults().limits).memory),
    }
    const registryPassword = crypto.randomBytes(16).toString('hex')
    fs.writeFileSync(`${dir}/registry.hash`, await hashPassword(registryPassword))
    timer.lap('files')

    let extras: Record<string, string> = {}
    if (createInnerStack && template.before_script) {
      extras = await runBeforeScript(template.before_script, { name, rawName, hostDomain: appDomain, scheme: publicUrl().startsWith('https://') ? 'https' : 'http' })
      Object.assign(vars, extras)
    }

    // start_interval (a router sooner) needs Docker Engine 25: taken out below it, or compose refuses the file
    const runtimeCompose = (await startIntervalSupported()) ? runtime.docker_compose : withoutStartInterval(runtime.docker_compose)
    fs.writeFileSync(`${dir}/docker-compose.yml`, applyVars(runtimeCompose, vars))
    let innerText: string | undefined
    if (createInnerStack) {
      const inner = applyVars(template.compose, vars)
      fs.writeFileSync(`${dir}/inner/docker-compose.yml`, inner)
      innerText = inner
    }

    // SSH (foxglove sshd reads these): host keys survive re-creation; authorized_keys must exist as a
    // file before compose up, or Docker would create a directory in its place
    fs.mkdirSync(`${dir}/ssh-host-keys`, { recursive: true })
    if (sshKeys?.length) fs.writeFileSync(`${dir}/ssh-extra-keys`, sshKeys.map(k => `${k}\n`).join(''))
    writeAuthorizedKeys(name, owner)
    const runtimeLabels = ((runtime.docker_compose.services as Record<string, { labels?: Record<string, string> }> | undefined)?.sandbox?.labels) ?? {}
    const sshPrivateKey = String(runtimeLabels['p9m.ssh']) === 'true' ? createGeneratedKey(name, owner) : undefined

    timer.lap('prepare')
    await composeUp(`${dir}/docker-compose.yml`)
    timer.lap('compose up')

    if (createInnerStack) {
      const project = template.inner_project_name ?? 'inner'
      // docker compose runs in the sandbox (see composeUpInner)
      const tries = await composeUpInner(name, project, { exec: execRun })
      timer.lap('inner stack', tries > 1 ? `${tries} tries` : undefined)
    }

    let tunnelUrls: string[] = []
    if (hasFrps && createInnerStack) {
      // Done as soon as frps serves every app the inner compose publishes (not on fixed 3 s polls)
      const expected = innerText === undefined ? [] : appHostsFromCompose(innerText, { instance: rawName, project: template.inner_project_name ?? 'inner', domain: appDomain })
      tunnelUrls = await waitForTunnels(() => frpsDomains(name), expected)
      // What frpc registered, minus ports bound to 127.0.0.1 (private to the sandbox)
      if (tunnelUrls.length) { const seen = tunnelUrls; tunnelUrls = (await appLinks(name, {}, seen)).map(l => l.url) }
      timer.lap('tunnel')
    }

    fs.writeFileSync(`${dir}/extras.json`, JSON.stringify(extras))
    // Answer once its router is there (the request that opens the Sablier session goes through it): its app links
    // work then, instead of landing on the waiting page. Not there within ~10 s: the session is opened in the background.
    if (!await primeSablierSession(name, 40, 250).catch(() => false)) openSleepSession(name)
    timer.lap('router')
    console.log(`[create] ${name} ready in ${timer.summary()}`)
    // For its Details (Created in)
    fs.writeFileSync(`${dir}/created-in`, `${timer.totalMs()}\n`)

    return {
      name,
      docker_host: '',
      ca_cert: certs.caCert,
      client_cert: certs.clientCert,
      client_key: certs.clientKey,
      tunnel_urls: tunnelUrls,
      registry_url: registryUrl,
      registry_username: rawName,
      registry_password: registryPassword,
      extras,
      ...(sshPrivateKey ? { ssh_private_key: sshPrivateKey } : {}),
    }
  },

  /** The sandboxes `only` lets through (all without it), each with its app links: the running ones are asked, so
   * filter here, not afterwards (a user's list asks their own sandboxes, not every one on the server). */
  async listSandboxes(only: (meta: SandboxMeta) => boolean = () => true): Promise<Array<SandboxMeta & { tunnel_urls: string[]; apps_stale?: true; starting?: true }>> {
    const live = await listManagedContainers()
    const running = await Promise.all(
      live.filter(only).map(async meta => {
        if (!fs.existsSync(`${dirOf(meta.name)}/frps.toml`)) return { ...meta, tunnel_urls: [] }
        if (meta.status !== 'running') return { ...meta, tunnel_urls: offlineApps(meta).map(e => e.host) }
        const [{ links, stale }, starting] = await Promise.all([appLinksForView(meta.name), justStarted(meta.name)])
        return { ...meta, tunnel_urls: links.map(l => l.url), ...(stale ? { apps_stale: true as const } : {}), ...(starting ? { starting: true as const } : {}) }
      })
    )
    const all = [...running, ...deepSleepingSandboxes(live).filter(only).map(meta => ({ ...meta, tunnel_urls: fs.existsSync(`${dirOf(meta.name)}/frps.toml`) ? offlineApps(meta).map(e => e.host) : [] }))]
    // Being created: its directory comes before its containers (deep sleep), its containers before they run (asleep)
    return all.map(s => isCreating(s.name) ? { ...s, status: 'creating' } : s)
  },

  /** Every sandbox with its state and owner, without asking the running ones for their apps (as listSandboxes does):
   * what counting for the quota needs, cheap however many sandboxes run. */
  async listSandboxStates(): Promise<SandboxMeta[]> {
    const live = await listManagedContainers()
    return [...live, ...deepSleepingSandboxes(live)].map(s => isCreating(s.name) ? { ...s, status: 'creating' } : s)
  },

  async getSandbox(name: string): Promise<SandboxInfo> {
    const containers = await listManagedContainers()
    const meta = containers.find(c => c.name === name) ?? deepSleepMeta(name)
    if (!meta) throw new Error(`Sandbox not found: ${name}`)
    const certs = readClientCerts(name)
    const hasFrps = fs.existsSync(`${dirOf(name)}/frps.toml`)
    const offline = hasFrps && meta.status !== 'running' ? offlineApps(meta) : []
    const view = hasFrps && meta.status === 'running' ? await appLinksForView(name) : null
    const starting = meta.status === 'running' && await justStarted(name)
    const tunnel_urls = !hasFrps ? []
      : view ? view.links.map(l => l.url)
      : offline.map(e => e.host)
    const extras = fs.existsSync(`${dirOf(name)}/extras.json`)
      ? JSON.parse(fs.readFileSync(`${dirOf(name)}/extras.json`, 'utf8')) as Record<string, string>
      : {}
    const createdIn = createdInMs(dirOf(name))
    return { ...meta, ...certs, tunnel_urls, ...(view?.stale ? { apps_stale: true as const } : {}), ...(starting ? { starting: true as const } : {}), extras, ...(createdIn !== undefined ? { created_in_ms: createdIn } : {}), ...(offline.length ? { app_services: Object.fromEntries(offline.map(e => [e.host, e.service])) } : {}) }
  },

  async refreshStatus(name: string): Promise<SandboxInfo> {
    return this.getSandbox(name)
  },

  async stopSandbox(name: string): Promise<void> {
    await this.getSandbox(name)
    await composeStop(`${dirOf(name)}/docker-compose.yml`)
    removeDynamicConfig(name)
  },

  /**
   * Wakes a sandbox. Asleep or in deep sleep it takes a running slot (and from deep sleep a slot): refused at
   * the owner's limit (code LIMIT). `sleep`: one of the owner's running sandboxes to put to sleep first (a swap).
   */
  async startSandbox(name: string, opts: { sleep?: string } = {}): Promise<void> {
    const sandbox = await this.getSandbox(name)
    const composePath = `${dirOf(name)}/docker-compose.yml`
    if (sandbox.status === 'running') { await composeStart(composePath); openSleepSession(name); return }
    if (opts.sleep) {
      const other = opts.sleep === name ? null : await this.getSandbox(opts.sleep).catch(() => null)
      if (!other || other.owner !== sandbox.owner || other.status !== 'running') {
        throw Object.assign(new Error(`${opts.sleep} is not another running sandbox of the same owner`), { code: 'BAD_SWAP' })
      }
    }
    const { reserveWake } = await import('./quota')
    // A swap reserves first, counting the one to sleep as gone: nothing is put to sleep for a wake that would be refused
    const slot = opts.sleep ? await reserveWake(sandbox.owner, name, sandbox.status, opts.sleep) : await reserveWake(sandbox.owner, name, sandbox.status)
    if (!slot.ok) throw Object.assign(new Error(slot.refusal.message), { code: 'LIMIT', refusal: slot.refusal })
    try {
      if (opts.sleep) await this.stopSandbox(opts.sleep)
      // Its address reaches p9m until the router is back: a waiting page, not "does not reach the sandbox"
      markWoken(name)
      // Deep sleep removed the containers: recreate them instead of starting
      if (sandbox.status === 'deep_sleep') await composeUp(composePath)
      else await composeStart(composePath)
    } finally { slot.release() }
    markWoken(name)
    openSleepSession(name)
  },

  async restartSandbox(name: string): Promise<void> {
    const sandbox = await this.getSandbox(name)
    // Restarting a stopped sandbox wakes it: within the owner's limits, like any wake
    if (sandbox.status !== 'running') return this.startSandbox(name)
    markWoken(name) // while it restarts, its address reaches p9m: a waiting page
    await composeStop(`${dirOf(name)}/docker-compose.yml`)
    await composeStart(`${dirOf(name)}/docker-compose.yml`)
    markWoken(name)
    openSleepSession(name)
  },

  /**
   * Explicit delete: nothing is destroyed until the sandbox's volumes and
   * config are safely in /opt/archive. Stop (not down) first so a failed
   * archive leaves containers Sablier can still wake. Containers are found by
   * compose project label, so a sandbox without a compose file is handled
   * too. Returns the archive dir.
   */
  async archiveSandbox(name: string): Promise<string> {
    return archiving(() => archive(name))
  }
}

// Archiving copies every volume through Purgatorium: many at once (a class deleting its sandboxes) kept everything else
// waiting. At most 4 at a time; the others wait their turn
const archiving = concurrency(4)

/** /p9m:teleport's secrets volume, as a path in the inner Docker's data (docker_data) */
const SECRETS_IN_DOCKER_DATA = './volumes/claude_secrets'

async function archive(name: string): Promise<string> {
  if (!SANDBOX_NAME.test(name)) throw new Error(`Invalid sandbox name: ${name}`)
  // Only a known sandbox directory: dirOf's fallback for an unknown name could be another directory, removed below
  const dir = sandboxDir(name)
  if (!dir || !fs.existsSync(dir)) return removeLeftover(name)
  const composePath = `${dir}/docker-compose.yml`
  const hasCompose = fs.existsSync(composePath)
  // In deep sleep there are no containers to read labels from: the compose file has the same ones
  const meta = (await listManagedContainers()).find(c => c.name === name) ?? deepSleepMeta(name)

  await stopProjectContainers(name)

  const archivedAt = new Date()
  let owner = meta?.owner
  if (!owner) { try { owner = ownerOfCompose(fs.readFileSync(composePath, 'utf8')) } catch { owner = 'admin' } }
  const dest = `${archiveRoot(owner)}/${name}-${archivedAt.toISOString().replace(/[:.]/g, '-')}`
  const volumes = await listProjectVolumes(name)
  fs.mkdirSync(`${dest}/volumes`, { recursive: true })
  // A project teleported into the sandbox keeps its secrets in the inner Docker's claude_secrets volume: never archived
  for (const volume of volumes) await exportVolume(volume, `${dest}/volumes/${volume}.tar.gz`, volume.endsWith('_docker_data') ? [SECRETS_IN_DOCKER_DATA] : [])
  fs.cpSync(dir, `${dest}/config`, { recursive: true })
  fs.writeFileSync(`${dest}/manifest.json`, JSON.stringify({
    name,
    owner,
    template: meta?.template ?? null,
    runtime: meta?.runtime || null,
    created_at: meta?.created_at ?? null,
    archived_at: archivedAt.toISOString(),
    volumes,
    secrets_excluded: true
  }, null, 2))

  // Archive is complete — only now remove the live sandbox.
  if (hasCompose) await composeDown(composePath)
  await removeProjectContainers(name)
  for (const volume of volumes) await removeVolume(volume)
  fs.rmSync(dir, { recursive: true, force: true })
  forgetSandboxDir(name)
  removeEmptyOwnerDir(dir)
  removeDynamicConfig(name)
  return dest
}

/**
 * A sandbox whose directory is gone but whose containers or volumes are not (a delete or a create that broke off half
 * way): its volumes are saved as an archive without a config (as orphan volumes are), then everything of it removed.
 * Empty when it had no volumes.
 */
async function removeLeftover(name: string): Promise<string> {
  const meta = (await listManagedContainers()).find(c => c.name === name)
  const volumes = await listProjectVolumes(name)
  if (!meta && !volumes.length) throw new Error(`Sandbox not found: ${name}`)
  await stopProjectContainers(name)
  let dest = ''
  if (volumes.length) {
    const archivedAt = new Date()
    dest = `${archiveRoot(meta?.owner || 'admin')}/${name}-${archivedAt.toISOString().replace(/[:.]/g, '-')}`
    fs.mkdirSync(`${dest}/volumes`, { recursive: true })
    for (const volume of volumes) await exportVolume(volume, `${dest}/volumes/${volume}.tar.gz`)
    fs.writeFileSync(`${dest}/manifest.json`, JSON.stringify({ name, owner: meta?.owner || 'admin', leftover: true, archived_at: archivedAt.toISOString(), volumes }, null, 2))
  }
  await removeProjectContainers(name)
  for (const volume of volumes) await removeVolume(volume)
  removeDynamicConfig(name)
  return dest
}
