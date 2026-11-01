import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSION_SECRET', 'test-secret')
const { LoginLimiter, loginLimiter, adminLoginEnabled, adminSignIn, clientAddress, waitText, oidcSignInFailed,
  FREE_FAILURES, ADMIN_FAILURES_PER_HOUR } = await import('../../services/loginGuard')
const { hubLoginPage } = await import('../../services/hub/page')
const login = (await import('../../routes/login/GET')).default

const MIN = 60_000

describe('adminLoginEnabled', () => {
  it('off unless ADMIN_LOGIN is on, and only with a user and a password', () => {
    const creds = { ADMIN_USER: 'admin', ADMIN_PASSWORD: 'pw' }
    expect(adminLoginEnabled(creds)).toBe(false)
    expect(adminLoginEnabled({ ...creds, ADMIN_LOGIN: 'off' })).toBe(false)
    for (const on of ['on', 'ON', 'true', '1', 'yes', ' on ']) expect(adminLoginEnabled({ ...creds, ADMIN_LOGIN: on }), on).toBe(true)
    expect(adminLoginEnabled({ ADMIN_USER: 'admin', ADMIN_LOGIN: 'on' })).toBe(false)
  })
})

describe('LoginLimiter', () => {
  let t = 0
  const clock = () => t
  beforeEach(() => { t = 1_000_000 })

  it(`lets ${FREE_FAILURES - 1} failures go, then waits 1 min, 2, 4… up to an hour`, () => {
    const l = new LoginLimiter(clock)
    for (let i = 1; i < FREE_FAILURES; i++) { l.failed('1.2.3.4'); expect(l.waitFor('1.2.3.4')).toBe(0) }
    l.failed('1.2.3.4'); expect(l.waitFor('1.2.3.4')).toBe(1 * MIN)
    t += MIN; l.failed('1.2.3.4'); expect(l.waitFor('1.2.3.4')).toBe(2 * MIN)
    t += 2 * MIN; l.failed('1.2.3.4'); expect(l.waitFor('1.2.3.4')).toBe(4 * MIN)
    for (let i = 0; i < 10; i++) { t += l.waitFor('1.2.3.4'); l.failed('1.2.3.4') }
    expect(l.waitFor('1.2.3.4')).toBe(60 * MIN)
    expect(l.waitFor('5.6.7.8')).toBe(0) // another address is not touched
  })

  it('failures far apart start the count again; a success forgets the address', () => {
    const l = new LoginLimiter(clock)
    for (let i = 0; i < FREE_FAILURES - 1; i++) l.failed('a')
    t += 16 * MIN; l.failed('a'); expect(l.waitFor('a')).toBe(0)
    for (let i = 0; i < FREE_FAILURES; i++) l.failed('b')
    l.succeeded('b'); expect(l.waitFor('b')).toBe(0)
  })

  it(`stops the admin's sign-in for everyone after ${ADMIN_FAILURES_PER_HOUR} failures in an hour from many addresses`, () => {
    const l = new LoginLimiter(clock)
    for (let i = 0; i < ADMIN_FAILURES_PER_HOUR - 1; i++) l.failed(`10.0.${i}.1`, true)
    expect(l.adminWait()).toBe(0)
    l.failed('10.9.9.9', true)
    expect(l.adminWait()).toBe(60 * MIN)
    t += 60 * MIN; expect(l.adminWait()).toBe(0)
    for (let i = 0; i < ADMIN_FAILURES_PER_HOUR; i++) l.failed(`11.0.${i}.1`) // OIDC failures do not count here
    expect(l.adminWait()).toBe(0)
  })
})

describe('adminSignIn', () => {
  const ok = vi.fn(async (u: string, p: string) => u === 'admin' && p === 'pw')
  beforeEach(() => { vi.stubEnv('ADMIN_USER', 'admin'); vi.stubEnv('ADMIN_PASSWORD', 'pw'); vi.stubEnv('ADMIN_LOGIN', 'on'); ok.mockClear() })

  it('off: refused without looking at the password', async () => {
    vi.stubEnv('ADMIN_LOGIN', 'off')
    expect(await adminSignIn('1.1.1.1', 'admin', 'pw', ok, new LoginLimiter())).toBe('Administrator sign-in is turned off')
    expect(ok).not.toHaveBeenCalled()
  })

  it('signs in; wrong passwords count, and a waiting address is refused even with the right one', async () => {
    const l = new LoginLimiter()
    expect(await adminSignIn('1.1.1.1', 'admin', 'pw', ok, l)).toBeNull()
    for (let i = 0; i < FREE_FAILURES; i++) expect(await adminSignIn('1.1.1.1', 'admin', 'guess', ok, l)).toBe('Invalid username or password')
    ok.mockClear()
    expect(await adminSignIn('1.1.1.1', 'admin', 'pw', ok, l)).toBe('Too many failed sign-ins: try again in 1 minute')
    expect(ok).not.toHaveBeenCalled()
    expect(await adminSignIn('2.2.2.2', 'admin', 'pw', ok, l)).toBeNull()
  })

  it('OIDC: a failed callback is logged, never counted against its address (a room behind one address)', () => {
    loginLimiter.reset()
    for (let i = 0; i < FREE_FAILURES * 3; i++) oidcSignInFailed('3.3.3.3', new Error('state mismatch'))
    expect(loginLimiter.waitFor('3.3.3.3')).toBe(0)
  })
})

describe('clientAddress', () => {
  it("behind Traefik (a private address): the last X-Forwarded-For entry, the one Traefik added", () => {
    expect(clientAddress('172.18.0.5', '203.0.113.7')).toBe('203.0.113.7')
    expect(clientAddress('::ffff:172.18.0.5', '6.6.6.6, 203.0.113.7')).toBe('203.0.113.7')
    expect(clientAddress('172.18.0.5', undefined)).toBe('172.18.0.5')
  })
  it('a public client on the API port cannot choose its address with X-Forwarded-For', () => {
    expect(clientAddress('198.51.100.9', '1.2.3.4')).toBe('198.51.100.9')
    expect(clientAddress(undefined, undefined)).toBe('unknown')
  })
})

describe('waitText', () => {
  it('minutes, then hours', () => {
    expect(waitText(30_000)).toBe('1 minute')
    expect(waitText(4 * MIN)).toBe('4 minutes')
    expect(waitText(60 * MIN)).toBe('1 hour')
  })
})

describe('the sign-in pages', () => {
  const page = async () => (await login(new Request('http://p9m.lvh.me/login'))).text()
  beforeEach(() => { vi.stubEnv('ADMIN_USER', 'admin'); vi.stubEnv('ADMIN_PASSWORD', 'pw') })

  it('show the admin form only with ADMIN_LOGIN=on', async () => {
    vi.stubEnv('ADMIN_LOGIN', 'off')
    expect(await page()).not.toContain('Administrator sign-in')
    expect(await page()).toContain('No sign-in method is on')
    expect(hubLoginPage({ title: 'Hub', error: null, sso: null, admin: false })).not.toContain('name="password"')
    vi.stubEnv('ADMIN_LOGIN', 'on')
    expect(await page()).toContain('Administrator sign-in')
    expect(hubLoginPage({ title: 'Hub', error: null, sso: null, admin: true })).toContain('name="password"')
  })
})
