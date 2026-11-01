import { describe, it, expect, vi } from 'vitest'

vi.stubEnv('ADMIN_TOKEN', 'admin-secret')
// Every runtime, as in development (the default, sysbox only, has its own test)
vi.stubEnv('ALLOWED_RUNTIMES', 'all')

const release = vi.fn()
vi.mock('../../../services/quota', () => ({ reserveSandboxSlot: vi.fn(async () => ({ ok: true, release })) }))
vi.mock('../../../services/sandbox', () => ({
  sandboxService: {
    createSandbox: vi.fn().mockImplementation(async (name: string) => {
      if (name === 'dupe') throw new Error('Sandbox already exists: dupe')
      if (name === 'nofree') throw new Error('No free ports available in template range')
      return { name, docker_host: 'tcp://1.2.3.4:32001', ca_cert: 'ca', client_cert: 'cc', client_key: 'ck' }
    }),
    suggestName: vi.fn(async () => 'k3x9q2'),
  }
}))
vi.mock('../../../services/tokens', () => ({ resolveToken: vi.fn((t: string) => t === 'p9m_user' ? { owner: 'u@example.com', sandbox: null } : null) }))
// A Docker Desktop-like host by default: no sysbox, so DEFAULT_RUNTIME=auto gives dind
let hostRuntimes = ['runc']
vi.mock('../../../services/docker', () => ({ hostResources: vi.fn(async () => ({ cpus: 20, memory: 32 * 1024 ** 3 })), dockerRuntimes: vi.fn(async () => hostRuntimes) }))
vi.mock('../../../services/templateLoader', () => {
  const all = [
    { name: 'starter', compose: { services: { portainer: {} } } },
    { name: 'tcp-demo', compose: { services: { db: {} } } },
    { name: 'empty', compose: {} },
  ]
  return { listTemplates: () => all, loadTemplate: (n: string) => all.find(t => t.name === n) }
})
vi.mock('../../../services/runtimeLoader', () => ({
  listRuntimes: () => [{ name: 'dind' }, { name: 'sysbox' }]
}))

const { default: handler } = await import('../../../routes/sandboxes/POST')
const { sandboxService } = await import('../../../services/sandbox')

describe('POST /sandboxes', () => {
  function jsonReq(body: unknown, auth: string | null = 'Bearer admin-secret') {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (auth) headers.Authorization = auth
    return new Request('http://localhost/sandboxes', { method: 'POST', headers, body: JSON.stringify(body) })
  }

  it('returns 201 with docker_host on success', async () => {
    const res = await handler(jsonReq({ name: 'alice' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.name).toBe('alice')
    expect(body.docker_host).toBe('tcp://1.2.3.4:32001')
  })

  it('no name: a generated one, in the answer', async () => {
    for (const body of [{}, { name: null }]) {
      const res = await handler(jsonReq(body))
      expect(res.status).toBe(201)
      expect((await res.json()).name).toBe('k3x9q2')
      expect(vi.mocked(sandboxService.createSandbox).mock.lastCall?.[0]).toBe('k3x9q2')
    }
  })

  it('no name: one another create took meanwhile is drawn again, up to three times', async () => {
    vi.mocked(sandboxService.suggestName).mockResolvedValueOnce('dupe').mockResolvedValueOnce('dupe')
    const res = await handler(jsonReq({}))
    expect(res.status).toBe(201)
    expect((await res.json()).name).toBe('k3x9q2')
    vi.mocked(sandboxService.suggestName).mockResolvedValueOnce('dupe').mockResolvedValueOnce('dupe').mockResolvedValueOnce('dupe')
    expect((await handler(jsonReq({}))).status).toBe(409)
  })

  it('no name and none free: 503', async () => {
    vi.mocked(sandboxService.suggestName).mockResolvedValueOnce(null)
    const res = await handler(jsonReq({}))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/give one/)
  })

  it('a given name is never replaced, not even when taken', async () => {
    vi.mocked(sandboxService.suggestName).mockClear()
    expect((await handler(jsonReq({ name: 'dupe' }))).status).toBe(409)
    expect(sandboxService.suggestName).not.toHaveBeenCalled()
  })

  it('returns 400 for an empty or non-string name', async () => {
    for (const name of ['', '  ', 7]) expect((await handler(jsonReq({ name }))).status).toBe(400)
  })

  it('returns 409 when sandbox already exists', async () => {
    const res = await handler(jsonReq({ name: 'dupe' }))
    expect(res.status).toBe(409)
  })

  it('returns 503 when port range exhausted', async () => {
    const res = await handler(jsonReq({ name: 'nofree' }))
    expect(res.status).toBe(503)
  })

  it('sleep limits: a user may not create above them (the admin may)', async () => {
    vi.stubEnv('SANDBOX_MAX_IDLE_TIMEOUT', '2h')
    try {
      const over = await handler(jsonReq({ name: 'lim1', idle_timeout: 'off' }, 'Bearer p9m_user'))
      expect(over.status).toBe(400)
      expect((await over.json()).error).toMatch(/never is not allowed on this server: at most 2h/)
      expect((await handler(jsonReq({ name: 'lim2', idle_timeout: 'off' }))).status).toBe(201)
    } finally { vi.unstubAllEnvs(); vi.stubEnv('ADMIN_TOKEN', 'admin-secret'); vi.stubEnv('ALLOWED_RUNTIMES', 'all') }
  })

  it('passes a valid idle_timeout through to the service', async () => {
    const res = await handler(jsonReq({ name: 'idle', idle_timeout: '15m' }))
    expect(res.status).toBe(201)
    expect(vi.mocked(sandboxService.createSandbox)).toHaveBeenLastCalledWith('idle', true, '15m', undefined, 'admin', 'starter', 'dind', undefined, { cpus: 2, memory: 4 * 1024 ** 3 })
  })

  it('accepts 0 or off (never) for both, passing off to the service', async () => {
    for (const v of ['0', 'off', 0]) {
      const res = await handler(jsonReq({ name: 'never', idle_timeout: v, deep_sleep_after: v }))
      expect(res.status).toBe(201)
      expect(vi.mocked(sandboxService.createSandbox)).toHaveBeenLastCalledWith('never', true, 'off', 'off', 'admin', 'starter', 'dind', undefined, { cpus: 2, memory: 4 * 1024 ** 3 })
    }
  })

  it('rejects an idle_timeout that is not a simple duration', async () => {
    for (const idle_timeout of ['15', '1m\n  evil: x', '1.5h', 15]) {
      const res = await handler(jsonReq({ name: 'idle', idle_timeout }))
      expect(res.status).toBe(400)
    }
  })

  it('passes a valid deep_sleep_after through to the service', async () => {
    for (const deep_sleep_after of ['12h', '7d', 'off']) {
      const res = await handler(jsonReq({ name: 'deep', deep_sleep_after }))
      expect(res.status).toBe(201)
      expect(vi.mocked(sandboxService.createSandbox)).toHaveBeenLastCalledWith('deep', true, undefined, deep_sleep_after, 'admin', 'starter', 'dind', undefined, { cpus: 2, memory: 4 * 1024 ** 3 })
    }
  })

  it('rejects a malformed deep_sleep_after', async () => {
    for (const deep_sleep_after of ['30s', '7', '1.5d', 'never', '7d\n  evil: x', 7]) {
      const res = await handler(jsonReq({ name: 'deep', deep_sleep_after }))
      expect(res.status).toBe(400)
    }
  })

  it('rejects the removed ttl parameter and points to idle_timeout', async () => {
    const res = await handler(jsonReq({ name: 'old', ttl: 3600 }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('idle_timeout')
  })

  it('passes the runtime and the template through to the service', async () => {
    const { _resetDefaultRuntime } = await import('../../../services/defaultRuntime')
    _resetDefaultRuntime(); hostRuntimes = ['runc', 'sysbox-runc']
    const res = await handler(jsonReq({ name: 'tmpl', runtime: 'sysbox', template: 'tcp-demo' }))
    _resetDefaultRuntime(); hostRuntimes = ['runc']
    expect(res.status).toBe(201)
    expect(vi.mocked(sandboxService.createSandbox)).toHaveBeenLastCalledWith('tmpl', true, undefined, undefined, 'admin', 'tcp-demo', 'sysbox', undefined, { cpus: 2, memory: 4 * 1024 ** 3 })
  })

  it('fills in DEFAULT_RUNTIME / DEFAULT_TEMPLATE, else auto (dind without sysbox) and starter', async () => {
    await handler(jsonReq({ name: 'def1' }))
    expect(vi.mocked(sandboxService.createSandbox)).toHaveBeenLastCalledWith('def1', true, undefined, undefined, 'admin', 'starter', 'dind', undefined, { cpus: 2, memory: 4 * 1024 ** 3 })
    vi.stubEnv('DEFAULT_RUNTIME', 'sysbox')
    vi.stubEnv('DEFAULT_TEMPLATE', 'tcp-demo')
    const { _resetDefaultRuntime } = await import('../../../services/defaultRuntime')
    _resetDefaultRuntime(); hostRuntimes = ['runc', 'sysbox-runc'] // a host where sysbox is installed
    try {
      await handler(jsonReq({ name: 'def2' }))
      expect(vi.mocked(sandboxService.createSandbox)).toHaveBeenLastCalledWith('def2', true, undefined, undefined, 'admin', 'tcp-demo', 'sysbox', undefined, { cpus: 2, memory: 4 * 1024 ** 3 })
    } finally { delete process.env.DEFAULT_RUNTIME; delete process.env.DEFAULT_TEMPLATE; _resetDefaultRuntime(); hostRuntimes = ['runc'] }
  })

  it('rejects an unknown template, also an old single-file name, with 400', async () => {
    for (const template of ['unknown-template', 'dind-standard', 'sysbox-sandbox']) {
      const res = await handler(jsonReq({ name: 'bad', template }))
      expect(res.status, template).toBe(400)
      expect((await res.json()).error).toBe('Unknown template')
    }
  })

  it('rejects an unknown runtime with 400', async () => {
    const res = await handler(jsonReq({ name: 'bad', runtime: 'kata' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Unknown runtime')
  })

  it('without ALLOWED_RUNTIMES only sysbox: on a host without it, a create says to install sysbox (dind is for development)', async () => {
    vi.mocked(sandboxService.createSandbox).mockClear()
    vi.stubEnv('ALLOWED_RUNTIMES', '')
    const { _resetDefaultRuntime } = await import('../../../services/defaultRuntime')
    _resetDefaultRuntime(); hostRuntimes = ['runc']
    try {
      const dind = await handler(jsonReq({ name: 'nd', runtime: 'dind' }))
      expect(dind.status).toBe(400)
      expect((await dind.json()).error).toMatch(/dind is not allowed on this server/)
      const def = await handler(jsonReq({ name: 'nd2' }))
      expect(def.status).toBe(400)
      expect((await def.json()).error).toMatch(/sysbox is not installed on this host.*development only/)
      expect(sandboxService.createSandbox).not.toHaveBeenCalled()
    } finally { vi.stubEnv('ALLOWED_RUNTIMES', 'all') }
  })

  it('a runtime not in ALLOWED_RUNTIMES: 400, nothing created (the default too, saying so)', async () => {
    vi.mocked(sandboxService.createSandbox).mockClear()
    vi.stubEnv('ALLOWED_RUNTIMES', 'sysbox')
    vi.stubEnv('DEFAULT_RUNTIME', 'dind')
    try {
      const res = await handler(jsonReq({ name: 'na', runtime: 'dind' }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/dind is not allowed on this server/)
      const def = await handler(jsonReq({ name: 'na2' }))
      expect(def.status).toBe(400)
      expect((await def.json()).error).toMatch(/the default runtime \(dind\) is not allowed/)
      expect(sandboxService.createSandbox).not.toHaveBeenCalled()
    } finally { vi.stubEnv('ALLOWED_RUNTIMES', 'all'); vi.stubEnv('DEFAULT_RUNTIME', '') }
  })

  it('rejects a non-string runtime or template with 400', async () => {
    expect((await handler(jsonReq({ name: 'bad', runtime: 1 }))).status).toBe(400)
    expect((await handler(jsonReq({ name: 'bad', template: ['starter'] }))).status).toBe(400)
  })

  it('says Unknown template (400) when a stale DEFAULT_TEMPLATE names a removed template', async () => {
    vi.stubEnv('DEFAULT_TEMPLATE', 'dind-standard')
    try {
      const res = await handler(jsonReq({ name: 'stale' }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('Unknown template')
    } finally { delete process.env.DEFAULT_TEMPLATE }
  })

  it('refuses a compose text: a sandbox starts with its template as it is', async () => {
    vi.mocked(sandboxService.createSandbox).mockClear()
    for (const compose of ['services:\n  web:\n    image: nginx\n', '', 7]) {
      const res = await handler(jsonReq({ name: 'cmp', template: 'starter', compose }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/^compose was removed: a sandbox starts with its template's stack as it is/)
    }
    expect(sandboxService.createSandbox).not.toHaveBeenCalled()
  })

  it('a template without services (empty): a sandbox without a starter stack', async () => {
    vi.mocked(sandboxService.createSandbox).mockClear()
    expect((await handler(jsonReq({ name: 'e1', template: 'empty' }))).status).toBe(201)
    expect(vi.mocked(sandboxService.createSandbox).mock.lastCall?.[1]).toBe(false)
    expect((await handler(jsonReq({ name: 'e3', template: 'empty', create_inner_stack: false }))).status).toBe(201)
    expect(vi.mocked(sandboxService.createSandbox).mock.lastCall?.[1]).toBe(false)
  })


  it('passes extra SSH keys (normalized) through, and refuses bad ones with their index', async () => {
    const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILQbLq+klAOn7bvdZ+bf7t83dWYc3AfKM/YVFsjF6tLa agent'
    const res = await handler(jsonReq({ name: 'k1', ssh_keys: [`  ${key}\r\n`] }))
    expect(res.status).toBe(201)
    expect(vi.mocked(sandboxService.createSandbox)).toHaveBeenLastCalledWith('k1', true, undefined, undefined, 'admin', 'starter', 'dind', [key], { cpus: 2, memory: 4 * 1024 ** 3 })
    for (const [ssh_keys, error] of [
      ['x', 'ssh_keys must be a list of public keys'],
      [[key, 7], 'ssh_keys must be a list of public keys'],
      [Array(11).fill(key), 'at most 10 ssh_keys'],
      [[key, 'ssh-dss AAAA'], 'ssh_keys[1]: unsupported key type ssh-dss: use ssh-ed25519, ssh-rsa or ecdsa'],
    ] as const) {
      const r = await handler(jsonReq({ name: 'k2', ssh_keys }))
      expect(r.status).toBe(400)
      expect((await r.json()).error).toBe(error)
    }
  })

  it('takes cpus and memory within the ceiling, and refuses a user over it', async () => {
    await handler(jsonReq({ name: 'r1', cpus: 3, memory: '6g' }))
    expect(vi.mocked(sandboxService.createSandbox).mock.lastCall![8]).toEqual({ cpus: 3, memory: 6 * 1024 ** 3 })
    const over = await handler(jsonReq({ name: 'r2', cpus: 6 }, 'Bearer p9m_user'))
    expect(over.status).toBe(403)
    expect((await over.json()).error).toBe('at most 4 CPUs for a sandbox: ask the administrator for more')
  })

  it('requires authentication', async () => {
    const res = await handler(jsonReq({ name: 'anon' }, null))
    expect(res.status).toBe(401)
  })

  it('refuses with 409 when the caller reached the quota, creating nothing', async () => {
    const { reserveSandboxSlot } = await import('../../../services/quota')
    vi.mocked(reserveSandboxSlot).mockResolvedValueOnce({ ok: false, limit: 2, scope: 'running' })
    vi.mocked(sandboxService.createSandbox).mockClear()
    const res = await handler(jsonReq({ name: 'over' }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('2 running sandboxes allowed: put one to sleep first (Sleep in its panel), then create a new one.')
    expect(sandboxService.createSandbox).not.toHaveBeenCalled()
  })

  it('refuses with 409 at the running limit: a new sandbox runs', async () => {
    const { reserveSandboxSlot } = await import('../../../services/quota')
    vi.mocked(reserveSandboxSlot).mockResolvedValueOnce({ ok: false, limit: 1, scope: 'running' })
    const res = await handler(jsonReq({ name: 'over' }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('1 running sandbox allowed: put one to sleep first (Sleep in its panel), then create a new one.')
  })

  it('refuses with 409 above the guarantee when the server has no room to spare, saying why', async () => {
    const { reserveSandboxSlot } = await import('../../../services/quota')
    vi.mocked(reserveSandboxSlot).mockResolvedValueOnce({ ok: false, limit: 3, scope: 'room', message: '3 running sandboxes guaranteed; more only while the server has room…' })
    const res = await handler(jsonReq({ name: 'over' }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('3 running sandboxes guaranteed; more only while the server has room…')
  })

  it('releases the quota reservation whether the create succeeds or fails', async () => {
    release.mockClear()
    await handler(jsonReq({ name: 'alice' }))
    expect(release).toHaveBeenCalledTimes(1)
    release.mockClear()
    await handler(jsonReq({ name: 'dupe' }))
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('sysbox asked for on a host without sysbox-runc: 400, nothing created', async () => {
    const { _resetDefaultRuntime } = await import('../../../services/defaultRuntime')
    _resetDefaultRuntime(); hostRuntimes = ['runc']
    vi.mocked(sandboxService.createSandbox).mockClear()
    const res = await handler(jsonReq({ name: 'sbx', runtime: 'sysbox' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/sysbox is not installed on this host/)
    expect(sandboxService.createSandbox).not.toHaveBeenCalled()
    _resetDefaultRuntime()
  })
})

