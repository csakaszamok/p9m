import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.stubEnv('SESSION_SECRET', 'test-secret')
vi.stubEnv('PUBLIC_URL', 'https://p9m.example.com')
vi.stubEnv('APP_ACCESS_KEY_FILE', path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p9m-act-')), 'k'))

const sandboxes = [
  { name: 'p9m-shop', owner: 'alice@example.com', status: 'running' },
  { name: 'p9m-blog', owner: 'alice@example.com', status: 'running' },
  { name: 'p9m-off', owner: 'alice@example.com', status: 'deep_sleep' },
  { name: 'p9m-awake', owner: 'alice@example.com', status: 'running' },
  { name: 'p9m-secret', owner: 'bob@example.com', status: 'running' },
]
vi.mock('../../services/sandbox', () => ({
  sandboxService: {
    listSandboxStates: vi.fn(async () => sandboxes),
    getSandbox: vi.fn(async (n: string) => {
      const s = sandboxes.find(x => x.name === n)
      if (!s) throw new Error(`Sandbox not found: ${n}`)
      return s
    }),
  },
}))
vi.mock('../../services/dockerAccess', () => ({
  dockerAccessState: vi.fn((n: string) => n === 'p9m-off' || n === 'p9m-awake' ? 'needs-certs' : 'ready'),
  regenerateCerts: vi.fn(async () => {}),
}))
vi.mock('../../services/sandboxCreate', () => ({
  createSandboxRequest: vi.fn(async () => Response.json({ name: 'p9m-k3x9q2' }, { status: 201 })),
}))

const { createSession } = await import('../../services/session')
const { startDevice, deviceByUserCode, redeemDevice, _resetDevices } = await import('../../services/deviceAuth')
const { nextAfterSignIn } = await import('../../services/appAccess/start')
const { regenerateCerts } = await import('../../services/dockerAccess')
const { createSandboxRequest } = await import('../../services/sandboxCreate')
const { default: get } = await import('../../routes/activate/GET')
const { default: post } = await import('../../routes/activate/POST')

const cookie = (sub: string, role: 'user' | 'admin' = 'user') => `__Host-p9m_session=${createSession(sub, role)}`
const page = (code: string | null, c?: string, ip?: string) =>
  get(new Request(`https://p9m.example.com/activate${code === null ? '' : `?code=${encodeURIComponent(code)}`}`, { headers: { ...(c ? { cookie: c } : {}), ...(ip ? { 'x-real-ip': ip } : {}) } }))
const send = (fields: Record<string, string>, c: string | undefined = cookie('alice@example.com'), origin = 'https://p9m.example.com') =>
  post(new Request('https://p9m.example.com/activate', {
    method: 'POST', body: new URLSearchParams(fields),
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin, ...(c ? { cookie: c } : {}) },
  }))
const statusOf = (userCode: string) => deviceByUserCode(userCode)?.status
/** The confirmation code an approval page shows */
const confirmOf = (html: string) => /class="user-code" data-confirm>([A-Z]{4}-[A-Z]{4})</.exec(html)?.[1] ?? ''

describe('/activate', () => {
  beforeEach(() => {
    _resetDevices()
    vi.mocked(regenerateCerts).mockReset().mockResolvedValue(undefined)
    vi.mocked(createSandboxRequest).mockClear()
  })

  it('no session: to sign-in, and back to this code after it', async () => {
    const res = await page('bcdf-ghjk')
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/login')
    const value = res.headers.get('set-cookie')!.split(';')[0].slice("__Host-p9m_next=".length)
    expect(nextAfterSignIn(new Request('https://p9m.example.com/', { headers: { cookie: `__Host-p9m_next=${value}` } }))).toBe('/activate?code=bcdf-ghjk')
  })

  it('with USER_HOST, on the admin\'s address: to the users\' one, with the code', async () => {
    vi.stubEnv('USER_HOST', 'sbx.example.com')
    try {
      const at = (host: string) => get(new Request(`https://${host}/activate?code=bcdf-ghjk`, { headers: { host, cookie: cookie('alice@example.com') } }))
      const res = await at('p9m.example.com')
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toBe('https://sbx.example.com/activate?code=bcdf-ghjk')
      // On the users' address it is the page itself (here: an unknown code)
      expect((await at('sbx.example.com')).headers.get('location')).toBeNull()
    } finally { vi.stubEnv('USER_HOST', 'off') }
  })

  it('a code for my sandbox: the code and the sandbox, nothing to pick', async () => {
    const { user_code } = startDevice({ sandbox: 'shop' })
    const res = await page(user_code.toLowerCase(), cookie('alice@example.com'))
    expect(res.status).toBe(200)
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    const html = await res.text()
    expect(html).toContain('Connect Claude Code')
    expect(html).toContain(user_code)
    expect(html).toContain('<b>shop</b>')
    expect(html).not.toContain('<select')
    expect(html).not.toContain('name="sandbox"')
    expect(html).toMatch(/>Approve</)
    expect(html).toContain('>Deny<')
  })

  it('the page warns to approve only a code you started yourself', async () => {
    const { user_code } = startDevice({ sandbox: 'shop' })
    expect(await (await page(user_code, cookie('alice@example.com'))).text())
      .toContain('Approve only if you just ran /p9m:init yourself and Claude Code shows this same code. Never approve a code someone sent you.')
  })

  it('no sandbox in the request: a new one from the default template, nothing to pick', async () => {
    const { user_code } = startDevice()
    const html = await (await page(user_code, cookie('alice@example.com'))).text()
    expect(html).toContain('a new sandbox from the <b>starter</b> template')
    expect(html).toContain('>Create and approve<')
    // While it is created, the buttons give way to this (ui/activate.js)
    expect(html).toContain('<form method="post" action="/activate" data-activate>')
    expect(html).toContain('data-busy="Creating the sandbox…"')
    expect(html).toContain('<script src="/assets/activate.js" defer></script>')
    expect(html).not.toContain('<select')
    expect(html).not.toContain('p9m-shop')
  })

  it('a new sandbox from the template Claude Code asked for', async () => {
    const { user_code } = startDevice({ template: 'tcp-demo' })
    expect(await (await page(user_code, cookie('alice@example.com'))).text()).toContain('a new sandbox from the <b>tcp-demo</b> template')
  })

  it("someone else's sandbox, or none by that name: an error, never saying whether it exists", async () => {
    for (const name of ['p9m-secret', 'nope']) {
      const { user_code } = startDevice({ sandbox: name })
      const res = await page(user_code, cookie('alice@example.com'))
      // Not 404, which Traefik swaps for its own page
      expect(res.status).toBe(403)
      const html = await res.text()
      expect(html).toContain('You have no sandbox named')
      expect(html).not.toContain('>Approve<')
      expect(html).not.toContain('p9m-shop')
    }
  })

  it('the admin may approve a named sandbox of a user', async () => {
    const { user_code } = startDevice({ sandbox: 'shop' })
    expect(await (await page(user_code, cookie('admin', 'admin'))).text()).toContain('<b>shop</b>')
  })

  it('Docker access not ready: the button says it enables it; a restart only for one that is awake', async () => {
    const off = startDevice({ sandbox: 'off' })
    const offHtml = await (await page(off.user_code, cookie('alice@example.com'))).text()
    expect(offHtml).toContain('Enable Docker access and approve')
    expect(offHtml).toContain('data-busy="Turning on Docker access…"')
    expect(offHtml).not.toContain('restarts')
    const awake = startDevice({ sandbox: 'awake' })
    expect(await (await page(awake.user_code, cookie('alice@example.com'))).text()).toContain('The sandbox restarts')
  })

  it('asked for from another address than the browser: a warning; the same: none', async () => {
    const { user_code } = startDevice({ ip: '198.51.100.7' })
    const other = await (await page(user_code, cookie('alice@example.com'), '203.0.113.5')).text()
    expect(other).toContain("asked for from another address (198.51.100.7) than this browser's (203.0.113.5)")
    const same = await (await page(user_code, cookie('alice@example.com'), '198.51.100.7')).text()
    expect(same).not.toContain('another address')
  })

  it('unknown or missing code: 410 (not 404, which Traefik swaps for its own page), run /p9m:init again', async () => {
    for (const c of ['ZZZZ-ZZZZ', null]) {
      const res = await page(c, cookie('alice@example.com'))
      expect(res.status).toBe(410)
      expect(await res.text()).toContain('This code has expired or is unknown: run /p9m:init again.')
    }
  })

  it('escapes what the agent sent', async () => {
    const { user_code } = startDevice({ sandbox: '<script>x</script>' })
    const html = await (await page(user_code, cookie('alice@example.com'))).text()
    expect(html).not.toContain('<script>x')
  })

  it("POST approve someone else's sandbox: 403, still pending", async () => {
    const { user_code } = startDevice({ sandbox: 'p9m-secret' })
    const res = await send({ code: user_code, decision: 'approve' })
    expect(res.status).toBe(403)
    expect(statusOf(user_code)).toBe('pending')
  })

  it('POST approve my own: the confirmation code, which gets the link for it', async () => {
    const { device_code, user_code } = startDevice({ sandbox: 'shop' })
    const res = await send({ code: user_code, decision: 'approve' })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Approved. Paste this code into Claude Code:')
    expect(html).toContain('Only into your own Claude Code')
    expect(html).toContain('<button type="button" data-copy-from="[data-confirm]">Copy</button>')
    const confirm = confirmOf(html)
    expect(confirm).toMatch(/^[A-Z]{4}-[A-Z]{4}$/)
    expect(redeemDevice(device_code, confirm)).toEqual({ status: 'approved', sandbox: 'p9m-shop', owner: 'alice@example.com' })
    expect(regenerateCerts).not.toHaveBeenCalled()
    expect(createSandboxRequest).not.toHaveBeenCalled()
  })

  it('POST approve a new sandbox: created as POST /sandboxes would, for me, with the template asked for', async () => {
    const { device_code, user_code } = startDevice({ template: 'tcp-demo' })
    const html = await (await send({ code: user_code, decision: 'approve' })).text()
    expect(createSandboxRequest).toHaveBeenCalledTimes(1)
    expect(vi.mocked(createSandboxRequest).mock.calls[0]).toEqual([{ sub: 'alice@example.com', role: 'user', via: 'session' }, { template: 'tcp-demo' }])
    expect(redeemDevice(device_code, confirmOf(html))).toEqual({ status: 'approved', sandbox: 'p9m-k3x9q2', owner: 'alice@example.com' })
  })

  it('POST approve a new sandbox without a template: the default', async () => {
    const { user_code } = startDevice()
    await send({ code: user_code, decision: 'approve' })
    expect(vi.mocked(createSandboxRequest).mock.calls[0][1]).toEqual({})
  })

  it('the create fails (a limit): its error, still pending to try again', async () => {
    const { user_code } = startDevice()
    vi.mocked(createSandboxRequest).mockResolvedValueOnce(Response.json({ error: '1 running sandbox allowed: put one to sleep first' }, { status: 409 }))
    const res = await send({ code: user_code, decision: 'approve' })
    expect(res.status).toBe(409)
    expect(await res.text()).toContain('The sandbox could not be created: 1 running sandbox allowed')
    expect(statusOf(user_code)).toBe('pending')
  })

  it('a second click while the first still creates: told to wait, one create', async () => {
    const { user_code } = startDevice()
    let done!: () => void
    vi.mocked(createSandboxRequest).mockImplementationOnce(() => new Promise(r => { done = () => r(Response.json({ name: 'p9m-k3x9q2' }, { status: 201 })) }))
    const first = send({ code: user_code, decision: 'approve' })
    await vi.waitFor(() => expect(createSandboxRequest).toHaveBeenCalledTimes(1))
    const second = await send({ code: user_code, decision: 'approve' })
    expect(second.status).toBe(409)
    expect(await second.text()).toContain('being approved in another tab')
    done()
    expect(confirmOf(await (await first).text())).toMatch(/^[A-Z]{4}-[A-Z]{4}$/)
    expect(createSandboxRequest).toHaveBeenCalledTimes(1)
  })

  it("the admin approving a user's sandbox: the grant is the owner's", async () => {
    const { device_code, user_code } = startDevice({ sandbox: 'shop' })
    const html = await (await send({ code: user_code, decision: 'approve' }, cookie('admin', 'admin'))).text()
    expect(redeemDevice(device_code, confirmOf(html))).toEqual({ status: 'approved', sandbox: 'p9m-shop', owner: 'alice@example.com' })
  })

  it('POST deny: denied', async () => {
    const { device_code, user_code } = startDevice({ sandbox: 'shop' })
    const res = await send({ code: user_code, decision: 'deny' })
    expect(await res.text()).toContain('Denied.')
    expect(redeemDevice(device_code, 'BCDF-GHJK')).toEqual({ status: 'denied' })
  })

  it('POST from another site or without a session: refused, still pending', async () => {
    const { user_code } = startDevice({ sandbox: 'shop' })
    expect((await send({ code: user_code, decision: 'approve' }, cookie('alice@example.com'), 'https://evil.example.com')).status).toBe(403)
    const anon = await send({ code: user_code, decision: 'approve' }, '')
    expect(anon.status).toBe(303)
    expect(anon.headers.get('location')).toBe('/login')
    expect(statusOf(user_code)).toBe('pending')
  })

  it('POST with an unknown code: 410', async () => {
    const res = await send({ code: 'ZZZZ-ZZZZ', decision: 'approve' })
    expect(res.status).toBe(410)
  })

  it('POST approve without Docker access: new certificates first (no restart in deep sleep), then approved', async () => {
    const { device_code, user_code } = startDevice({ sandbox: 'off' })
    vi.mocked(regenerateCerts).mockImplementation(async () => { expect(statusOf(user_code)).toBe('working') })
    const html = await (await send({ code: user_code, decision: 'approve' })).text()
    expect(regenerateCerts).toHaveBeenCalledTimes(1)
    expect(vi.mocked(regenerateCerts).mock.calls[0][0]).toBe('p9m-off')
    expect(vi.mocked(regenerateCerts).mock.calls[0][1]).toHaveProperty('restart')
    expect(redeemDevice(device_code, confirmOf(html))).toMatchObject({ status: 'approved', sandbox: 'p9m-off' })
  })

  it('the certificates fail: 500 with the error, still pending', async () => {
    const { user_code } = startDevice({ sandbox: 'off' })
    vi.mocked(regenerateCerts).mockRejectedValue(new Error('restart <failed>'))
    const res = await send({ code: user_code, decision: 'approve' })
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('restart &lt;failed&gt;')
    expect(statusOf(user_code)).toBe('pending')
  })
})
