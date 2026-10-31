import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sandboxMeta } from '../helpers/sandboxMeta'

vi.mock('../../services/docker', () => ({
  listManagedContainers: vi.fn().mockResolvedValue([]),
  resolveHostSandboxesDir: vi.fn().mockResolvedValue('/host/opt/sandboxes'),
  getContainerIdByName: vi.fn().mockResolvedValue('cnt-abc'),
  getContainerStatus: vi.fn().mockResolvedValue('running'),
  engineApiVersion: vi.fn().mockResolvedValue('1.48'),
  execRun: vi.fn(),
  justStarted: vi.fn().mockResolvedValue(false)
}))

vi.mock('../../services/compose', () => ({
  composeUp: vi.fn().mockResolvedValue(undefined),
  composeUpInner: vi.fn().mockResolvedValue(undefined),
  composeStop: vi.fn().mockResolvedValue(undefined),
  composeStart: vi.fn().mockResolvedValue(undefined),
  composeDown: vi.fn().mockResolvedValue(undefined),
}))

// Opening the Sablier session needs Traefik; here only that it is asked for
// markCreating as the real one: a name being created is refused a second time until creatingDone
const creating = vi.hoisted(() => new Set<string>())
vi.mock('../../services/wake', () => ({
  primeSablierSession: vi.fn(async () => {}), markWoken: vi.fn(),
  markCreating: vi.fn((n: string) => creating.has(n) ? false : (creating.add(n), true)),
  creatingDone: vi.fn((n: string) => { creating.delete(n) }),
}))
let slot: unknown = { ok: true, release: () => {} }
vi.mock('../../services/quota', () => ({ reserveWake: vi.fn(async () => slot) }))
// The 127.0.0.1 filter is tested in appLinks.test; here frps' answer passes through
vi.mock('../../services/appLinks', async orig => {
  const real = await orig<typeof import('../../services/appLinks')>()
  return { ...real, appLinks: vi.fn(async (n: string, _d?: unknown, seen?: string[]) => (seen ?? await real.frpsDomains(n)).map(url => ({ url, port: 0 }))) }
})
vi.mock('../../services/sandboxSsh', () => ({ writeAuthorizedKeys: vi.fn(() => 0), createGeneratedKey: vi.fn(() => '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n') }))
vi.mock('../../services/sshKeys', () => ({ sshKeysOf: vi.fn(() => []) }))
vi.mock('../../services/project', () => ({
  stopProjectContainers: vi.fn().mockResolvedValue(undefined),
  removeProjectContainers: vi.fn().mockResolvedValue(undefined),
  listProjectVolumes: vi.fn().mockResolvedValue([]),
  exportVolume: vi.fn().mockResolvedValue(undefined),
  removeVolume: vi.fn().mockResolvedValue(undefined)
}))

// Sandbox directories on the mocked fs: /opt/sandboxes/admin; new sandboxes are written to /opt/sandboxes/<owner>/<name>
vi.mock('../../services/sandboxPaths', async orig => (await import('../helpers/flatSandboxPaths')).flatSandboxPaths(orig))

vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>()
  const mocked = {
    ...actual,
    existsSync: vi.fn().mockImplementation((p: unknown) =>
      /^\/opt\/(users|sandboxes)/.test(String(p)) ? false : actual.existsSync(p as string)
    ),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    cpSync: vi.fn(),
    rmSync: vi.fn(),
    readFileSync: vi.fn().mockImplementation((p: unknown, opts?: unknown) =>
      /templates|runtimes/.test(String(p)) ? actual.readFileSync(p as string, opts as BufferEncoding) : 'fake-cert'
    ),
  }
  return { ...mocked, default: mocked }
})

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

vi.stubEnv('DEFAULT_TEMPLATE', 'starter')
vi.stubEnv('DEFAULT_RUNTIME', 'dind')
vi.stubEnv('HOST_ADDRESS', '127.0.0.1')
vi.stubEnv('TEMPLATES_DIR', './templates')
vi.stubEnv('RUNTIMES_DIR', './runtimes')
vi.stubEnv('SANDBOXES_DIR', '/opt/sandboxes')
vi.stubEnv('ARCHIVE_DIR', '/opt/archive')

import { sandboxService } from '../../services/sandbox'
const realFs = await vi.importActual<typeof import('fs')>('fs')
import { listManagedContainers } from '../../services/docker'
import { primeSablierSession } from '../../services/wake'
import { writeAuthorizedKeys } from '../../services/sandboxSsh'
import { composeUp, composeUpInner, composeDown, composeStart, composeStop } from '../../services/compose'
import { listProjectVolumes, exportVolume, removeVolume, stopProjectContainers, removeProjectContainers } from '../../services/project'
import fs from 'fs'
import yaml from 'js-yaml'
import { ownerDirName, sandboxDir } from '../../services/sandboxPaths'

describe('sandbox service', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    vi.mocked(listManagedContainers).mockResolvedValue([])
    vi.mocked(composeUpInner).mockClear()
    // getTunnelUrls: frps API. createSandbox polls until two reads agree, so
    // answer every poll the same way a healthy frps would.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ proxies: [{ conf: { customDomains: ['p9m-u1-inner-http-echo-port5678.my.local'] } }] })
    })
  })

  it('creates a sandbox and returns certs + extras', async () => {
    const result = await sandboxService.createSandbox('u1')
    expect(result.name).toBe('p9m-u1')
    expect(result.docker_host).toBe('')
    expect(result.ca_cert).toMatch(/BEGIN CERTIFICATE/)
    expect(result.client_cert).toMatch(/BEGIN CERTIFICATE/)
    expect(result.client_key).toMatch(/BEGIN.*PRIVATE KEY/)
    // The starter has no Portainer
    expect(result.extras).toEqual({})
    expect(result.tunnel_urls).toEqual(['p9m-u1-inner-http-echo-port5678.my.local'])
  }, 60000)

  it('the portainer template returns its address and password', async () => {
    const result = await sandboxService.createSandbox('u1p', true, undefined, undefined, 'admin', 'portainer')
    expect(result.extras.portainer_password).toBeTruthy()
    expect(result.extras.portainer_url).toBeTruthy()
  }, 60000)

  it('keeps tunnel URLs already seen when a later frps poll fails', async () => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ proxies: [{ conf: { customDomains: ['p9m-u3-inner-http-echo-port5678.my.local'] } }] })
    })
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({}) })
    // Every later poll fails, so the loop runs all 10 × 3s waits: fast-forward them.
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      let done = false
      const pending = sandboxService.createSandbox('u3').finally(() => { done = true })
      while (!done) await vi.advanceTimersByTimeAsync(3000)
      const result = await pending
      expect(result.tunnel_urls).toEqual(['p9m-u3-inner-http-echo-port5678.my.local'])
    } finally {
      vi.useRealTimers()
    }
  }, 60000)

  // Two users at once with one name: both passed "does it exist" before either made its directory, and both went on
  it('the same name twice at once: one is created, the other refused', async () => {
    const both = await Promise.allSettled([
      sandboxService.createSandbox('twin', true, undefined, undefined, 'ann@example.com'),
      sandboxService.createSandbox('twin', true, undefined, undefined, 'bob@example.com'),
    ])
    expect(both.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const refused = both.find(r => r.status === 'rejected') as PromiseRejectedResult
    expect(String(refused.reason)).toMatch(/already exists/)
  }, 60000)

  it('throws if name already exists', async () => {
    vi.mocked(listManagedContainers).mockResolvedValueOnce([
      sandboxMeta({ name: 'p9m-dup', template: 't', status: 'running', container_id: 'abc', created_at: '' })
    ])
    await expect(sandboxService.createSandbox('dup')).rejects.toThrow('already exists')
  }, 60000)

  it('rejects a new name that is an existing name plus "-something" (would steal its Traefik routes)', async () => {
    vi.mocked(listManagedContainers).mockResolvedValueOnce([
      sandboxMeta({ name: 'p9m-alice', template: 't', status: 'running', container_id: 'abc', created_at: '' })
    ])
    await expect(sandboxService.createSandbox('alice-inner')).rejects.toThrow('conflicts with an existing sandbox')
  }, 60000)

  it('rejects a new name that an existing longer name would shadow (reverse direction)', async () => {
    vi.mocked(listManagedContainers).mockResolvedValueOnce([
      sandboxMeta({ name: 'p9m-alice-inner', template: 't', status: 'running', container_id: 'abc', created_at: '' })
    ])
    await expect(sandboxService.createSandbox('alice')).rejects.toThrow('conflicts with an existing sandbox')
  }, 60000)

  it("rejects a name whose router would answer for Purgatorium's own address (UI_HOST)", async () => {
    vi.stubEnv('UI_HOST', 'console-admin.lvh.me')
    try {
      vi.mocked(listManagedContainers).mockResolvedValueOnce([])
      await expect(sandboxService.createSandbox('console')).rejects.toThrow("would take Purgatorium's own address console-admin.lvh.me")
    } finally { vi.stubEnv('UI_HOST', '') }
  }, 60000)

  it('allows a name that merely starts with an existing name but is not prefix+dash', async () => {
    vi.mocked(listManagedContainers).mockResolvedValueOnce([
      sandboxMeta({ name: 'p9m-alice', template: 't', status: 'running', container_id: 'abc', created_at: '' })
    ])
    const result = await sandboxService.createSandbox('alicex', false)
    expect(result.name).toBe('p9m-alicex')
  }, 60000)

  it('rejects a name-prefix conflict against a deep-sleeping sandbox dir, not just live containers', async () => {
    const realExists = vi.mocked(fs.existsSync).getMockImplementation()!
    vi.mocked(fs.existsSync).mockImplementation(p => p === '/opt/sandboxes/admin' || realExists(p))
    vi.spyOn(fs, 'readdirSync').mockReturnValue(['p9m-bob'] as unknown as ReturnType<typeof fs.readdirSync>)
    try {
      await expect(sandboxService.createSandbox('bob-inner')).rejects.toThrow('conflicts with an existing sandbox')
    } finally {
      vi.mocked(fs.existsSync).mockImplementation(realExists)
      vi.mocked(fs.readdirSync).mockRestore()
    }
  }, 60000)

  it('throws on stop for unknown sandbox', async () => {
    await expect(sandboxService.stopSandbox('nobody')).rejects.toThrow('not found')
  })

  it('fills the Sablier idle timeout with a 30m default', async () => {
    vi.mocked(fs.writeFileSync).mockClear()
    await sandboxService.createSandbox('idle1', false)
    const compose = vi.mocked(fs.writeFileSync).mock.calls
      .find(c => c[0] === '/opt/sandboxes/admin/p9m-idle1/docker-compose.yml')?.[1] as string
    expect(compose).toMatch(/plugin\.sablier\.sessionDuration: 30m/)
    expect(compose).not.toContain('${idle_timeout}')
  }, 60000)

  it('lets the caller override the Sablier idle timeout', async () => {
    vi.mocked(fs.writeFileSync).mockClear()
    await sandboxService.createSandbox('idle2', false, '2m')
    const compose = vi.mocked(fs.writeFileSync).mock.calls
      .find(c => c[0] === '/opt/sandboxes/admin/p9m-idle2/docker-compose.yml')?.[1] as string
    expect(compose).toMatch(/plugin[.]sablier[.]sessionDuration: 2m/)
  }, 60000)

  it('writes an idle timeout of off (never sleep) as a 10-year Sablier session', async () => {
    vi.mocked(fs.writeFileSync).mockClear()
    await sandboxService.createSandbox('idle3', false, 'off')
    const compose = vi.mocked(fs.writeFileSync).mock.calls
      .find(c => c[0] === '/opt/sandboxes/admin/p9m-idle3/docker-compose.yml')?.[1] as string
    expect(compose).toMatch(/plugin[.]sablier[.]sessionDuration: 87600h/)
  }, 60000)

  it('labels the sandbox with deep_sleep_after, 7d by default', async () => {
    vi.mocked(fs.writeFileSync).mockClear()
    await sandboxService.createSandbox('ds1', false)
    await sandboxService.createSandbox('ds2', false, undefined, '12h')
    const compose = (n: string) => vi.mocked(fs.writeFileSync).mock.calls
      .find(c => c[0] === `/opt/sandboxes/admin/p9m-${n}/docker-compose.yml`)?.[1] as string
    expect(compose('ds1')).toMatch(/p9m\.deep_sleep_after: 7d/)
    expect(compose('ds2')).toMatch(/p9m\.deep_sleep_after: 12h/)
  }, 60000)

  it('labels the sandbox with its owner', async () => {
    vi.mocked(fs.writeFileSync).mockClear()
    await sandboxService.createSandbox('own1', false, undefined, undefined, 'alice@example.com')
    const compose = vi.mocked(fs.writeFileSync).mock.calls
      .find(c => c[0] === '/opt/sandboxes/alice@example.com/p9m-own1/docker-compose.yml')?.[1] as string
    expect(compose).toMatch(/p9m\.owner: "alice@example\.com"/)
  }, 60000)

  it("writes a new sandbox into its owner's directory, its bind mounts pointing there on the host", async () => {
    vi.mocked(fs.writeFileSync).mockClear()
    await sandboxService.createSandbox('dir1', false, undefined, undefined, 'Bob@Example.com')
    const compose = vi.mocked(fs.writeFileSync).mock.calls
      .find(c => c[0] === '/opt/sandboxes/bob@example.com/p9m-dir1/docker-compose.yml')?.[1] as string
    const doc = yaml.load(compose) as { services: { sandbox: { volumes: string[] } } }
    const binds = doc.services.sandbox.volumes.filter(v => v.startsWith('/'))
    expect(binds.length).toBeGreaterThan(3)
    for (const b of binds) expect(b).toMatch(/^\/host\/opt\/sandboxes\/bob@example\.com\/p9m-dir1\//)
  }, 60000)

  it('refuses to create a sandbox when opt/sandboxes is not mounted from the host', async () => {
    vi.stubEnv('SANDBOXES_DIR', '')
    try {
      await expect(sandboxService.createSandbox('nomount')).rejects.toThrow('opt/sandboxes is not mounted')
    } finally { vi.stubEnv('SANDBOXES_DIR', '/opt/sandboxes') }
  }, 60000)

  it('refuses a name that exists only in the legacy layout (not moved yet)', async () => {
    const realExists = vi.mocked(fs.existsSync).getMockImplementation()!
    vi.mocked(fs.existsSync).mockImplementation(p => p === '/opt/sandboxes/admin/p9m-old1' || realExists(p))
    try {
      await expect(sandboxService.createSandbox('old1')).rejects.toThrow('Sandbox already exists')
    } finally { vi.mocked(fs.existsSync).mockImplementation(realExists) }
  }, 60000)

  it('safely quotes owners containing YAML-special characters', async () => {
    const cases: Array<[string, string]> = [
      ['&a@x.com', '&a@x.com'],
      ['!bob@x.com', '!bob@x.com'],
      ['*a@x.com', '*a@x.com'],
      ['{a}@x.com', '{a}@x.com'],
      ['a$b@x.com', 'a$$b@x.com']
    ]
    for (const [i, [owner, expected]] of cases.entries()) {
      vi.mocked(fs.writeFileSync).mockClear()
      const rawName = `own-special-${i}`
      await sandboxService.createSandbox(rawName, false, undefined, undefined, owner)
      const compose = vi.mocked(fs.writeFileSync).mock.calls
        
        .find(c => c[0] === `/opt/sandboxes/${ownerDirName(owner)}/p9m-${rawName}/docker-compose.yml`)?.[1] as string
      const parsed = yaml.load(compose) as { services: { sandbox: { labels: Record<string, string> } } }
      expect(parsed.services.sandbox.labels['p9m.owner']).toBe(expected)
    }
  }, 60000)

  const written = (name: string, file: string) => vi.mocked(fs.writeFileSync).mock.calls
    .find(c => /^\/opt\/sandboxes\/[^/]+\//.test(String(c[0])) && String(c[0]).endsWith(`/${name}/${file}`))?.[1] as string | undefined
  // ${…} that Purgatorium itself fills in; anything else is left for docker compose
  const OURS = /\$\{(name|raw_name|template_name|runtime_name|compose_source|created_at|host_users_dir|host_domain|frp_token|frps_api_auth|idle_timeout|deep_sleep_after|owner|demo_password|cpus|memory|portainer_[a-z_]+)\}/

  it("gives a new sandbox's frps API a password, which socat's health check uses", async () => {
    vi.mocked(fs.writeFileSync).mockClear()
    await sandboxService.createSandbox('fa1', false)
    const auth = /\[webServer\][\s\S]*user = "(\w+)"\npassword = "([0-9a-f]{32})"/.exec(written('p9m-fa1', 'frps.toml')!)
    expect(auth).not.toBeNull()
    const socat = (yaml.load(written('p9m-fa1', 'docker-compose.yml')!) as { services: { socat: { environment: Record<string, string>; healthcheck: { test: string[] } } } }).services.socat
    expect(socat.environment.FRPS_API_AUTH).toBe(`${auth![1]}:${auth![2]}`)
    expect(socat.healthcheck.test[1]).toContain('http://$$FRPS_API_AUTH@127.0.0.1:7500/')
  }, 60000)

  // Docker Engine 25+: socat is checked every 0.5 s while it starts, so the router shows up sooner
  it("keeps socat's start_interval on an engine that takes it", async () => {
    vi.mocked(fs.writeFileSync).mockClear()
    await sandboxService.createSandbox('si1', false)
    const socat = (yaml.load(written('p9m-si1', 'docker-compose.yml')!) as { services: { socat: { healthcheck: Record<string, unknown> } } }).services.socat
    expect(socat.healthcheck.start_interval).toBe('500ms')
  }, 60000)

  // A request to its address while it is being created must not start it a second time (see wake.ts)
  it('marks a sandbox as being created for the whole create, also when it fails', async () => {
    const { markCreating, creatingDone } = await import('../../services/wake')
    vi.mocked(markCreating).mockClear(); vi.mocked(creatingDone).mockClear()
    await sandboxService.createSandbox('mc1', false)
    expect(markCreating).toHaveBeenCalledWith('p9m-mc1')
    expect(creatingDone).toHaveBeenCalledWith('p9m-mc1')
    vi.mocked(markCreating).mockClear(); vi.mocked(creatingDone).mockClear()
    await expect(sandboxService.createSandbox('mc2', false, undefined, undefined, 'admin', 'no-such-template')).rejects.toThrow()
    expect(creatingDone).toHaveBeenCalledWith('p9m-mc2')
  }, 60000)

  // Its app links must work when the create answers: the request that opens the Sablier session goes through the
  // sandbox's router, so once it passes the address answers too (and nobody lands on the waiting page)
  it('waits for the router (opening the Sablier session) before it answers, on short tries', async () => {
    vi.mocked(primeSablierSession).mockClear()
    vi.mocked(primeSablierSession).mockResolvedValueOnce(true as never)
    await sandboxService.createSandbox('ps1', false)
    expect(primeSablierSession).toHaveBeenCalledTimes(1)
    expect(primeSablierSession).toHaveBeenCalledWith('p9m-ps1', 40, 250)
  }, 60000)

  it('a router not there within those tries: the session keeps being opened in the background', async () => {
    vi.mocked(primeSablierSession).mockClear()
    vi.mocked(primeSablierSession).mockResolvedValueOnce(false as never)
    await sandboxService.createSandbox('ps2', false)
    expect(primeSablierSession).toHaveBeenCalledWith('p9m-ps2', 40, 250)
    await vi.waitFor(() => expect(primeSablierSession).toHaveBeenCalledWith('p9m-ps2', 150))
  }, 60000)

  it('skips the inner stack and the before_script when createInnerStack is false', async () => {
    vi.mocked(fs.writeFileSync).mockClear()
    const result = await sandboxService.createSandbox('u2', false)
    expect(result.name).toBe('p9m-u2')
    expect(vi.mocked(composeUpInner)).not.toHaveBeenCalled()
    expect(result.tunnel_urls).toEqual([])
    expect(result.extras).toEqual({})
    expect(written('p9m-u2', 'inner/docker-compose.yml')).toBeUndefined()
  }, 60000)

  for (const runtime of ['dind', 'sysbox']) {
    for (const template of ['starter', 'tcp-demo']) {
      it(`${runtime} + ${template}: the outer compose from the runtime, labelled with both names`, async () => {
        vi.mocked(fs.writeFileSync).mockClear()
        const raw = `m-${runtime}-${template}`
        await sandboxService.createSandbox(raw, false, undefined, undefined, 'admin', template, runtime)
        const outer = written(`p9m-${raw}`, 'docker-compose.yml')!
        const labels = (yaml.load(outer) as { services: { sandbox: { labels: Record<string, string> } } }).services.sandbox.labels
        expect(labels['p9m.runtime']).toBe(runtime)
        expect(labels['p9m.template']).toBe(template)
        expect(outer).not.toMatch(OURS)
        if (runtime === 'sysbox') expect(outer).toContain('runtime: sysbox-runc')
        else expect(outer).toContain('privileged: true')
      }, 60000)
    }
  }

  it('dind + tcp-demo: the inner compose from the template, with the generated demo password', async () => {
    vi.mocked(fs.writeFileSync).mockClear()
    const result = await sandboxService.createSandbox('demo9', true, undefined, undefined, 'admin', 'tcp-demo', 'dind')
    expect(result.extras.demo_password).toMatch(/^[0-9a-f]{24}$/)
    const inner = written('p9m-demo9', 'inner/docker-compose.yml')!
    expect(Object.keys((yaml.load(inner) as { services: Record<string, unknown> }).services)).toEqual(['db', 'redis', 'ssh', 'pgweb'])
    expect(inner).toContain(`POSTGRES_PASSWORD: ${result.extras.demo_password}`)
    expect(inner).not.toMatch(OURS)
    expect(vi.mocked(composeUpInner)).toHaveBeenCalledWith('p9m-demo9', 'inner', { exec: expect.any(Function) })
  }, 60000)

  it('labels a sandbox built from its template text as compose: template', async () => {
    vi.mocked(fs.writeFileSync).mockClear()
    await sandboxService.createSandbox('ed2', false)
    const labels = (yaml.load(written('p9m-ed2', 'docker-compose.yml')!) as { services: { sandbox: { labels: Record<string, string> } } }).services.sandbox.labels
    expect(labels['p9m.compose']).toBe('template')
  }, 60000)

  it('prepares SSH before the sandbox starts: host-key dir, extra keys file, authorized_keys', async () => {
    vi.mocked(fs.writeFileSync).mockClear(); vi.mocked(fs.mkdirSync).mockClear(); vi.mocked(writeAuthorizedKeys).mockClear()
    const order: string[] = []
    vi.mocked(writeAuthorizedKeys).mockImplementationOnce(() => { order.push('keys'); return 1 })
    vi.mocked(composeUp).mockImplementationOnce(async () => { order.push('up') })
    const extra = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILQbLq+klAOn7bvdZ+bf7t83dWYc3AfKM/YVFsjF6tLa'
    await sandboxService.createSandbox('ssh1', false, undefined, undefined, 'alice@example.com', undefined, undefined, [extra])
    expect(vi.mocked(fs.mkdirSync).mock.calls.map(c => c[0])).toContain('/opt/sandboxes/alice@example.com/p9m-ssh1/ssh-host-keys')
    expect(written('p9m-ssh1', 'ssh-extra-keys')).toBe(`${extra}\n`)
    expect(writeAuthorizedKeys).toHaveBeenCalledWith('p9m-ssh1', 'alice@example.com')
    expect(order).toEqual(['keys', 'up'])
  }, 60000)

  it('refuses to create with an unreadable SSH key store before writing anything for the sandbox', async () => {
    const { sshKeysOf } = await import('../../services/sshKeys')
    vi.mocked(sshKeysOf).mockImplementationOnce(() => { throw new SyntaxError('Unexpected token n in JSON') })
    vi.mocked(fs.writeFileSync).mockClear(); vi.mocked(fs.mkdirSync).mockClear()
    await expect(sandboxService.createSandbox('ssh3', false)).rejects.toThrow('SSH key store unreadable')
    const touched = [...vi.mocked(fs.writeFileSync).mock.calls, ...vi.mocked(fs.mkdirSync).mock.calls].map(c => String(c[0]))
    expect(touched.filter(p => p.includes('p9m-ssh3'))).toEqual([])
  }, 60000)

  it('generates the SSH key of an SSH sandbox and returns it once', async () => {
    const { createGeneratedKey } = await import('../../services/sandboxSsh')
    vi.mocked(createGeneratedKey).mockClear()
    const r = await sandboxService.createSandbox('gk1', false)
    expect(createGeneratedKey).toHaveBeenCalledWith('p9m-gk1', 'admin')
    expect(r.ssh_private_key).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----/)
  }, 60000)

  it('limits the sandbox container: the given limits, else the defaults', async () => {
    vi.mocked(fs.writeFileSync).mockClear()
    await sandboxService.createSandbox('lim1', false)
    const d = yaml.load(written('p9m-lim1', 'docker-compose.yml')!) as { services: { sandbox: Record<string, unknown>; frps: Record<string, unknown> } }
    expect(d.services.sandbox).toMatchObject({ cpus: 2, mem_limit: '4096m', memswap_limit: '4096m' })
    expect(d.services.frps.mem_limit).toBeUndefined()
    vi.mocked(fs.writeFileSync).mockClear()
    await sandboxService.createSandbox('lim2', false, undefined, undefined, 'admin', undefined, undefined, undefined, { cpus: 0.5, memory: 512 * 1024 * 1024 })
    expect((yaml.load(written('p9m-lim2', 'docker-compose.yml')!) as { services: { sandbox: Record<string, unknown> } }).services.sandbox).toMatchObject({ cpus: 0.5, mem_limit: '512m' })
  }, 60000)

  it('writes no extra keys file without extra keys', async () => {
    vi.mocked(fs.writeFileSync).mockClear()
    await sandboxService.createSandbox('ssh2', false)
    expect(written('p9m-ssh2', 'ssh-extra-keys')).toBeUndefined()
  }, 60000)

  it('refuses an unknown template or runtime before writing anything for the sandbox', async () => {
    vi.mocked(fs.writeFileSync).mockClear()
    vi.mocked(fs.mkdirSync).mockClear()
    await expect(sandboxService.createSandbox('x9', true, undefined, undefined, 'admin', 'dind-standard')).rejects.toThrow('Template not found: dind-standard')
    await expect(sandboxService.createSandbox('x9', true, undefined, undefined, 'admin', 'starter', 'nope')).rejects.toThrow('Runtime not found: nope')
    const touched = [...vi.mocked(fs.writeFileSync).mock.calls, ...vi.mocked(fs.mkdirSync).mock.calls].map(c => String(c[0]))
    expect(touched.filter(p => p.includes('p9m-x9'))).toEqual([])
  })
})

describe('archiveSandbox', () => {
  const name = 'p9m-arc1'
  const dir = `/opt/sandboxes/admin/${name}`
  const vol = `${name}_docker_data`
  let steps: string[]
  let realExists: (p: fs.PathLike) => boolean

  beforeEach(() => {
    steps = []
    realExists = vi.mocked(fs.existsSync).getMockImplementation()! as (p: fs.PathLike) => boolean
    vi.mocked(fs.existsSync).mockImplementation(p => String(p).startsWith(dir) || realExists(p))
    vi.mocked(listManagedContainers).mockResolvedValue([
      sandboxMeta({ name, template: 'dind-standard', status: 'exited', container_id: 'abc', created_at: '1700000000' })
    ])
    vi.mocked(listProjectVolumes).mockImplementation(async n => n === name ? [vol] : [])
    vi.mocked(stopProjectContainers).mockImplementation(async () => { steps.push('stop') })
    vi.mocked(removeProjectContainers).mockImplementation(async () => { steps.push('rmcontainers') })
    vi.mocked(exportVolume).mockImplementation(async v => { steps.push(`export:${v}`) })
    vi.mocked(fs.cpSync).mockImplementation(() => { steps.push('copy') })
    vi.mocked(fs.writeFileSync).mockImplementation(p => { if (String(p).endsWith('manifest.json')) steps.push('manifest') })
    vi.mocked(composeDown).mockImplementation(async () => { steps.push('down') })
    vi.mocked(removeVolume).mockImplementation(async v => { steps.push(`rmvol:${v}`) })
    vi.mocked(fs.rmSync).mockImplementation(p => { if (p === dir) steps.push('rmdir') })
  })

  afterEach(() => {
    vi.mocked(fs.existsSync).mockImplementation(realExists)
    vi.mocked(fs.writeFileSync).mockReset()
  })

  it('archives volumes and config before removing anything', async () => {
    const archive = await sandboxService.archiveSandbox(name)
    expect(archive).toMatch(new RegExp(`^/opt/archive/admin/${name}-`))
    expect(steps).toEqual(['stop', `export:${vol}`, 'copy', 'manifest', 'down', 'rmcontainers', `rmvol:${vol}`, 'rmdir'])
  })

  it("archives under its owner's directory, the manifest names the owner", async () => {
    vi.mocked(listManagedContainers).mockResolvedValue([
      { name, template: 'dind-standard', status: 'exited', container_id: 'abc', created_at: '1', owner: 'Ann@x.io' } as never
    ])
    const archive = await sandboxService.archiveSandbox(name)
    expect(archive).toMatch(new RegExp(`^/opt/archive/ann@x\.io/${name}-`))
    const manifest = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls.find(c => String(c[0]).endsWith('manifest.json'))![1] as string)
    expect(manifest.owner).toBe('Ann@x.io')
  })

  it("leaves a teleported project's secrets (claude_secrets) out of the inner Docker's data, and says so", async () => {
    vi.mocked(listProjectVolumes).mockImplementation(async n => n === name ? [vol, `${name}_frps`] : [])
    vi.mocked(exportVolume).mockClear()
    await sandboxService.archiveSandbox(name)
    expect(vi.mocked(exportVolume).mock.calls.map(c => [c[0], c[2]])).toEqual([[vol, ['./volumes/claude_secrets']], [`${name}_frps`, []]])
    const manifest = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls.find(c => String(c[0]).endsWith('manifest.json'))![1] as string)
    expect(manifest.secrets_excluded).toBe(true)
  })

  it('stops and removes containers even when the sandbox has no compose file', async () => {
    vi.mocked(fs.existsSync).mockImplementation(p =>
      String(p) === `${dir}/docker-compose.yml` ? false : String(p).startsWith(dir) || realExists(p))
    await sandboxService.archiveSandbox(name)
    expect(steps).toEqual(['stop', `export:${vol}`, 'copy', 'manifest', 'rmcontainers', `rmvol:${vol}`, 'rmdir'])
  })

  it('records template and creation time from the compose file when the sandbox is in deep sleep (no containers)', async () => {
    vi.mocked(listManagedContainers).mockResolvedValue([])
    const realRead = vi.mocked(fs.readFileSync).getMockImplementation()!
    vi.mocked(fs.readFileSync).mockImplementation(((p: unknown, opts?: unknown) =>
      String(p) === `${dir}/docker-compose.yml`
        ? 'services:\n  sandbox:\n    labels:\n      p9m.template: dind-standard\n      p9m.created_at: 2026-09-28T10:00:00.000Z\n'
        : realRead(p as string, opts as BufferEncoding)) as typeof fs.readFileSync)
    await sandboxService.archiveSandbox(name)
    vi.mocked(fs.readFileSync).mockImplementation(realRead)
    const manifest = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls.find(c => String(c[0]).endsWith('manifest.json'))![1] as string)
    expect(manifest).toMatchObject({ name, template: 'dind-standard', runtime: null, created_at: '2026-09-28T10:00:00.000Z' })
  })

  it('removes nothing when a volume export fails', async () => {
    vi.mocked(exportVolume).mockRejectedValueOnce(new Error('disk full'))
    await expect(sandboxService.archiveSandbox(name)).rejects.toThrow('disk full')
    expect(steps).toEqual(['stop'])
  })

  it('refuses names that could escape the users directory', async () => {
    await expect(sandboxService.archiveSandbox('..')).rejects.toThrow('Invalid sandbox name')
    expect(steps).toEqual([])
  })

  it('reports not found when there is no sandbox directory', async () => {
    await expect(sandboxService.archiveSandbox('p9m-nobody')).rejects.toThrow('not found')
  })

  it('removes nothing for an unknown sandbox even when a path of its name exists (e.g. an owner directory)', async () => {
    const known = vi.mocked(sandboxDir).getMockImplementation()!
    vi.mocked(sandboxDir).mockReturnValue(null)
    vi.mocked(listManagedContainers).mockResolvedValue([])
    vi.mocked(listProjectVolumes).mockResolvedValue([])
    try {
      await expect(sandboxService.archiveSandbox(name)).rejects.toThrow('not found')
    } finally {
      vi.mocked(sandboxDir).mockImplementation(known)
    }
    expect(steps).toEqual([])
  })

  it("a leftover's panel opens (no certificates to read), so it can be deleted", async () => {
    const known = vi.mocked(sandboxDir).getMockImplementation()!
    vi.mocked(sandboxDir).mockReturnValue(null)
    vi.mocked(fs.existsSync).mockImplementation(() => false)
    const realRead = vi.mocked(fs.readFileSync).getMockImplementation()!
    vi.mocked(fs.readFileSync).mockImplementation(((p: unknown, opts?: unknown) => {
      if (String(p).includes('/certs/')) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' })
      return realRead(p as string, opts as BufferEncoding)
    }) as typeof fs.readFileSync)
    try {
      expect(await sandboxService.getSandbox(name)).toMatchObject({ name, status: 'exited', ca_cert: '', client_cert: '', client_key: '' })
    } finally {
      vi.mocked(sandboxDir).mockImplementation(known)
      vi.mocked(fs.readFileSync).mockImplementation(realRead)
    }
  })

  it('a leftover (its directory gone, its container and volumes not): volumes archived without config, the rest removed', async () => {
    const known = vi.mocked(sandboxDir).getMockImplementation()!
    vi.mocked(sandboxDir).mockReturnValue(null)
    vi.mocked(listManagedContainers).mockResolvedValue([{ name, template: 't', status: 'exited', container_id: 'abc', created_at: '1', owner: 'ann@x.io' } as never])
    try {
      const archive = await sandboxService.archiveSandbox(name)
      expect(archive).toMatch(new RegExp(`^/opt/archive/ann@x\.io/${name}-`))
    } finally {
      vi.mocked(sandboxDir).mockImplementation(known)
    }
    // no config to copy, no directory to remove
    expect(steps).toEqual(['stop', `export:${vol}`, 'manifest', 'rmcontainers', `rmvol:${vol}`])
    const manifest = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls.find(c => String(c[0]).endsWith('manifest.json'))![1] as string)
    expect(manifest).toMatchObject({ name, owner: 'ann@x.io', leftover: true, volumes: [vol] })
  })
})

describe('sysbox runtime', () => {
  function written(path: string): string {
    return vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0] === path)?.[1] as string
  }

  beforeEach(() => {
    vi.mocked(fs.writeFileSync).mockClear()
    vi.mocked(listManagedContainers).mockResolvedValue([])
  })

  it('keeps the dind daemon.json free of hosts/tls (its entrypoint passes those as flags)', async () => {
    await sandboxService.createSandbox('dj1', false)
    const cfg = JSON.parse(written('/opt/sandboxes/admin/p9m-dj1/daemon.json'))
    expect(cfg['registry-mirrors']).toBeDefined()
    expect(cfg.hosts).toBeUndefined()
    // The p9m registry, reached through Traefik inside: its public certificate is not verifiable there
    expect(cfg['insecure-registries']).toContain(`registry.${process.env.HOST_DOMAIN ?? 'lvh.me'}`)
  }, 60000)

  it('merges the runtime daemon_json so plain dockerd serves TLS on 2376', async () => {
    vi.stubEnv('DEFAULT_RUNTIME', 'sysbox')
    try {
      await sandboxService.createSandbox('sb1', false)
    } finally {
      vi.stubEnv('DEFAULT_RUNTIME', 'dind')
    }
    const cfg = JSON.parse(written('/opt/sandboxes/admin/p9m-sb1/daemon.json'))
    expect(cfg['registry-mirrors']).toBeDefined()
    expect(cfg.hosts).toContain('tcp://0.0.0.0:2376')
    expect(cfg.tlsverify).toBe(true)
    expect(cfg.tlscert).toBe('/certs/server/cert.pem')
  }, 60000)

  it('renders a sysbox sandbox with the same sleep/wake wiring as dind', async () => {
    vi.stubEnv('DEFAULT_RUNTIME', 'sysbox')
    try {
      await sandboxService.createSandbox('sb2', false)
    } finally {
      vi.stubEnv('DEFAULT_RUNTIME', 'dind')
    }
    const compose = yaml.load(written('/opt/sandboxes/admin/p9m-sb2/docker-compose.yml')) as {
      services: Record<string, { runtime?: string; privileged?: boolean; image?: string; labels?: Record<string, string>; volumes?: string[] }>
      volumes: Record<string, unknown>
    }
    const sandbox = compose.services.sandbox
    expect(sandbox.runtime).toBe('sysbox-runc')
    expect(sandbox.privileged).toBeUndefined()
    expect(sandbox.image).toMatch(/-sysbox$/)
    expect(sandbox.volumes).toContain('docker_data:/var/lib/docker')
    expect(sandbox.labels?.['sablier.group']).toBe('p9m-sb2')
    expect(compose.volumes).toHaveProperty('docker_data')
    const socat = compose.services.socat.labels!
    expect(socat['traefik.http.routers.frps-p9m-sb2.middlewares']).toBe('access-p9m-sb2@http,sablier-p9m-sb2')
    expect(socat['traefik.docker.allownonrunning']).toBeUndefined() // its router exists only while it runs
    expect(compose.services.frps.labels?.['sablier.group']).toBe('p9m-sb2')
  }, 60000)
})

describe('deep-sleeping sandboxes in the API', () => {
  const name = 'p9m-ds9'
  const dir = `/opt/sandboxes/admin/${name}`
  let realExists: (p: fs.PathLike) => boolean
  let realRead: typeof fs.readFileSync

  beforeEach(() => {
    realExists = vi.mocked(fs.existsSync).getMockImplementation()! as (p: fs.PathLike) => boolean
    realRead = vi.mocked(fs.readFileSync).getMockImplementation()! as typeof fs.readFileSync
    vi.mocked(listManagedContainers).mockResolvedValue([])
    vi.mocked(fs.existsSync).mockImplementation(p => p === '/opt/sandboxes/admin' || String(p).startsWith(dir) || realExists(p))
    vi.spyOn(fs, 'readdirSync').mockReturnValue([name, 'Bad..Name', 'p9m-nocompose'] as unknown as ReturnType<typeof fs.readdirSync>)
    vi.mocked(fs.readFileSync).mockImplementation(((p: unknown, o?: unknown) =>
      p === `${dir}/docker-compose.yml`
        ? 'services:\n  sandbox:\n    labels:\n      p9m.template: dind-standard\n      p9m.created_at: "2026-09-01T00:00:00Z"\n      p9m.owner: alice@example.com\n'
        : p === `${dir}/extras.json` ? '{}'
        : realRead(p as string, o as BufferEncoding)) as typeof fs.readFileSync)
  })

  afterEach(() => {
    vi.mocked(fs.existsSync).mockImplementation(realExists)
    vi.mocked(fs.readFileSync).mockImplementation(realRead)
    vi.mocked(fs.readdirSync).mockRestore()
  })

  it('lists a container-less sandbox dir as deep_sleep', async () => {
    const list = await sandboxService.listSandboxes()
    expect(list).toEqual([expect.objectContaining({ name, status: 'deep_sleep', template: 'dind-standard', owner: 'alice@example.com', tunnel_urls: [] })])
  })

  // Counting for the quota needs states and owners only: the full list asks every running sandbox's inner Docker
  // for its apps, which took seconds per create on a server with many sandboxes
  it('lists states and owners without asking any sandbox for its apps', async () => {
    const { appLinks } = await import('../../services/appLinks')
    const { listManagedContainers } = await import('../../services/docker')
    vi.mocked(listManagedContainers).mockResolvedValueOnce([{ name: 'p9m-run', status: 'running', owner: 'bob@x', template: 't', runtime: 'dind', compose: 'template', ssh: false, container_id: 'c', created_at: '' }] as never)
    vi.mocked(appLinks).mockClear()
    const states = await sandboxService.listSandboxStates()
    expect(states.map(s => [s.name, s.status, s.owner])).toEqual([['p9m-run', 'running', 'bob@x'], [name, 'deep_sleep', 'alice@example.com']])
    expect(appLinks).not.toHaveBeenCalled()
  })

  it('returns deep_sleep details for such a sandbox', async () => {
    const info = await sandboxService.getSandbox(name)
    expect(info.status).toBe('deep_sleep')
    expect(info.tunnel_urls).toEqual([])
  })

  it('starts a deep-sleeping sandbox with compose up', async () => {
    vi.mocked(composeUp).mockClear()
    await sandboxService.startSandbox(name)
    expect(composeUp).toHaveBeenCalledWith(`${dir}/docker-compose.yml`)
  })

  // Sablier only puts a sandbox to sleep once it has a session, and only an HTTP request opens one:
  // without this a sandbox woken from the panel or the API would run until someone opens it.
  it('opens the Sablier session after a start or a restart, so the sandbox sleeps again on its own', async () => {
    vi.mocked(primeSablierSession).mockClear()
    await sandboxService.startSandbox(name)
    expect(primeSablierSession).toHaveBeenCalledWith(name, 150)
    vi.mocked(primeSablierSession).mockClear()
    await sandboxService.restartSandbox(name)
    expect(primeSablierSession).toHaveBeenCalledWith(name, 150)
  })
})

describe('tunnel URLs only for running sandboxes', () => {
  // A stopped sandbox's frps/socat hosts do not resolve; asking them stalls the
  // request for seconds (DNS timeout) and can only ever return nothing.
  const name = 'p9m-asleep1'
  let realExists: (p: fs.PathLike) => boolean

  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ proxies: [] }) })
    realExists = vi.mocked(fs.existsSync).getMockImplementation()! as (p: fs.PathLike) => boolean
    vi.mocked(fs.existsSync).mockImplementation(p => String(p) === `/opt/sandboxes/admin/${name}/frps.toml` || realExists(p))
    vi.mocked(listManagedContainers).mockResolvedValue([
      sandboxMeta({ name, owner: 'admin', template: 't', status: 'exited', container_id: 'x', created_at: '' })
    ])
  })

  afterEach(() => { vi.mocked(fs.existsSync).mockImplementation(realExists) })

  it('does not query frps for an asleep sandbox in details or the list', async () => {
    expect((await sandboxService.getSandbox(name)).tunnel_urls).toEqual([])
    expect((await sandboxService.listSandboxes()).find(s => s.name === name)?.tunnel_urls).toEqual([])
    expect(mockFetch).not.toHaveBeenCalled()
  })

  // The inner compose file has only the template's stack; apps deployed later (Portainer, ssh) are remembered
  it('an asleep sandbox shows the apps it had when it last ran, in its details and the list', async () => {
    const realRead = vi.mocked(fs.readFileSync).getMockImplementation()!
    const apps = [{ url: 'asleep1-inner-web-port8080.lvh.me', port: 8080, service: 'web' }, { url: 'asleep1-portainer.lvh.me', port: 9000, service: 'portainer' }]
    vi.mocked(fs.readFileSync).mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) =>
      String(p) === `/opt/sandboxes/admin/${name}/apps.json` ? JSON.stringify(apps) : realRead(p, o as never)) as typeof fs.readFileSync)
    try {
      const info = await sandboxService.getSandbox(name)
      expect(info.tunnel_urls).toEqual(['asleep1-inner-web-port8080.lvh.me', 'asleep1-portainer.lvh.me'])
      expect(info.app_services).toEqual({ 'asleep1-inner-web-port8080.lvh.me': 'web', 'asleep1-portainer.lvh.me': 'portainer' })
      // The list too (list_sandboxes for an agent): the same apps, not none
      expect((await sandboxService.listSandboxes()).find(s => s.name === name)?.tunnel_urls).toEqual(['asleep1-inner-web-port8080.lvh.me', 'asleep1-portainer.lvh.me'])
      expect(mockFetch).not.toHaveBeenCalled()
    } finally { vi.mocked(fs.readFileSync).mockImplementation(realRead) }
  })
})

describe('HTTPS routing in runtimes', () => {
  for (const runtime of ['dind', 'sysbox']) {
    it(`${runtime}: the sandbox router listens on web and websecure`, () => {
      const t = yaml.load(realFs.readFileSync(`runtimes/${runtime}.yaml`, 'utf8')) as { docker_compose: { services: { socat: { labels: Record<string, string> } } } }
      expect(t.docker_compose.services.socat.labels['traefik.http.routers.frps-${name}.entrypoints']).toBe('web,websecure')
    })
  }

  it('builds the Portainer URL with the PUBLIC_URL scheme', async () => {
    const prev = process.env.PUBLIC_URL
    process.env.PUBLIC_URL = 'https://p9m.example.com'
    try {
      vi.mocked(listManagedContainers).mockResolvedValue([])
      // the portainer template's before_script makes the URL; it only runs with the template's stack
      const r = await sandboxService.createSandbox('sch1', true, undefined, undefined, 'admin', 'portainer')
      expect(r.extras.portainer_url).toMatch(/^https:\/\/sch1-portainer\./)
    } finally {
      if (prev === undefined) delete process.env.PUBLIC_URL
      else process.env.PUBLIC_URL = prev
    }
  }, 60000)
})

describe('startSandbox and the limits', () => {
  const refusal = { reason: 'running', title: 'Running limit reached', message: 'Running limit reached: 1 running sandbox allowed, running now: shop. Put one to sleep first.', limit: 1, running: ['p9m-shop'] }
  beforeEach(() => { vi.mocked(composeUp).mockClear(); vi.mocked(composeStart).mockClear(); vi.mocked(composeStop).mockClear(); slot = { ok: true, release: vi.fn() } })

  it('asleep or in deep sleep: refused at the limit, nothing started', async () => {
    const { reserveWake } = await import('../../services/quota')
    const spy = vi.spyOn(sandboxService, 'getSandbox')
    slot = { ok: false, refusal }
    for (const status of ['exited', 'deep_sleep']) {
      spy.mockResolvedValueOnce({ name: 'p9m-x', owner: 'u@x', status } as never)
      await expect(sandboxService.startSandbox('p9m-x')).rejects.toMatchObject({ code: 'LIMIT', refusal })
      expect(reserveWake).toHaveBeenLastCalledWith('u@x', 'p9m-x', status)
    }
    expect(composeStart).not.toHaveBeenCalled(); expect(composeUp).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('starts within the limit and releases the reservation; a running one is not checked', async () => {
    const { reserveWake } = await import('../../services/quota')
    const spy = vi.spyOn(sandboxService, 'getSandbox')
    spy.mockResolvedValueOnce({ name: 'p9m-x', owner: 'u@x', status: 'exited' } as never)
    await sandboxService.startSandbox('p9m-x')
    expect(composeStart).toHaveBeenCalledWith('/opt/sandboxes/admin/p9m-x/docker-compose.yml')
    expect((slot as { release: () => void }).release).toHaveBeenCalled()
    vi.mocked(reserveWake).mockClear()
    spy.mockResolvedValueOnce({ name: 'p9m-x', owner: 'u@x', status: 'running' } as never)
    await sandboxService.startSandbox('p9m-x')
    expect(reserveWake).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('swap: puts the named running sandbox of the same owner to sleep first, then wakes this one', async () => {
    const spy = vi.spyOn(sandboxService, 'getSandbox')
    spy.mockImplementation(async (n: string) => ({ name: n, owner: 'u@x', status: n === 'p9m-shop' ? 'running' : 'exited' }) as never)
    await sandboxService.startSandbox('p9m-x', { sleep: 'p9m-shop' })
    expect(composeStop).toHaveBeenCalledWith('/opt/sandboxes/admin/p9m-shop/docker-compose.yml')
    expect(composeStart).toHaveBeenCalledWith('/opt/sandboxes/admin/p9m-x/docker-compose.yml')
    expect(vi.mocked(composeStop).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(composeStart).mock.invocationCallOrder[0])
    spy.mockRestore()
  })

  it("swap refused, nothing put to sleep: itself, not running, or someone else's", async () => {
    const spy = vi.spyOn(sandboxService, 'getSandbox')
    spy.mockImplementation(async (n: string) => ({ name: n, owner: n === 'p9m-theirs' ? 'v@x' : 'u@x', status: n === 'p9m-idle' ? 'exited' : n === 'p9m-x' ? 'exited' : 'running' }) as never)
    for (const sleep of ['p9m-x', 'p9m-idle', 'p9m-theirs']) {
      await expect(sandboxService.startSandbox('p9m-x', { sleep })).rejects.toMatchObject({ code: 'BAD_SWAP' })
    }
    expect(composeStop).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('final review fixes: restart, wake timing, swap order', () => {
  const refusal = { reason: 'running', title: 'Running limit reached', message: 'Running limit reached: 1 running sandbox allowed, running now: shop. Put one to sleep first.', limit: 1, running: ['p9m-shop'] }
  beforeEach(() => { vi.mocked(composeStart).mockClear(); vi.mocked(composeStop).mockClear(); slot = { ok: true, release: vi.fn() } })

  it('restart of an asleep sandbox is a wake: refused at the limit, nothing stopped or started', async () => {
    const spy = vi.spyOn(sandboxService, 'getSandbox')
    spy.mockResolvedValue({ name: 'p9m-b', owner: 'u@x', status: 'exited' } as never)
    slot = { ok: false, refusal }
    await expect(sandboxService.restartSandbox('p9m-b')).rejects.toMatchObject({ code: 'LIMIT' })
    expect(composeStop).not.toHaveBeenCalled(); expect(composeStart).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('marks the sandbox woken before its start (its router appears only later), also on a restart', async () => {
    const { markWoken } = await import('../../services/wake')
    const spy = vi.spyOn(sandboxService, 'getSandbox')
    spy.mockResolvedValue({ name: 'p9m-b', owner: 'u@x', status: 'exited' } as never)
    vi.mocked(markWoken).mockClear()
    await sandboxService.startSandbox('p9m-b')
    expect(vi.mocked(markWoken).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(composeStart).mock.invocationCallOrder[0])
    spy.mockResolvedValue({ name: 'p9m-b', owner: 'u@x', status: 'running' } as never)
    vi.mocked(markWoken).mockClear(); vi.mocked(composeStop).mockClear()
    await sandboxService.restartSandbox('p9m-b')
    expect(vi.mocked(markWoken).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(composeStop).mock.invocationCallOrder[0])
    spy.mockRestore()
  })

  it('a swap reserves first, counting the one to sleep as gone: still over the limit → nothing put to sleep', async () => {
    const { reserveWake } = await import('../../services/quota')
    const spy = vi.spyOn(sandboxService, 'getSandbox')
    spy.mockImplementation(async (n: string) => ({ name: n, owner: 'u@x', status: n === 'p9m-shop' ? 'running' : 'exited' }) as never)
    slot = { ok: false, refusal }
    await expect(sandboxService.startSandbox('p9m-x', { sleep: 'p9m-shop' })).rejects.toMatchObject({ code: 'LIMIT' })
    expect(reserveWake).toHaveBeenLastCalledWith('u@x', 'p9m-x', 'exited', 'p9m-shop')
    expect(composeStop).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
