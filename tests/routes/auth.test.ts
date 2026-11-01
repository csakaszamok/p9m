import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSION_SECRET', 'test-secret')
vi.stubEnv('PUBLIC_URL', 'http://p9m.lvh.me')
vi.stubEnv('ADMIN_USER', 'admin')
vi.stubEnv('ADMIN_PASSWORD', 'pw')
vi.stubEnv('ADMIN_LOGIN', 'on')
vi.stubEnv('OIDC_ISSUER', 'https://accounts.example.com')
vi.stubEnv('OIDC_CLIENT_ID', 'cid')
vi.stubEnv('OIDC_CLIENT_SECRET', 'csecret')

let claims: Record<string, unknown> = {}
vi.mock('openid-client', () => ({
  discovery: vi.fn(async () => ({ issuer: 'mock' })),
  allowInsecureRequests: Symbol('insecure'),
  randomPKCECodeVerifier: () => 'verifier',
  calculatePKCECodeChallenge: async () => 'challenge',
  randomState: () => 'state-1',
  randomNonce: () => 'nonce-1',
  buildAuthorizationUrl: (_c: unknown, p: Record<string, string>) => new URL(`https://accounts.example.com/auth?${new URLSearchParams(p)}`),
  authorizationCodeGrant: vi.fn(async (_c: unknown, url: URL, checks: { expectedState: string }) => {
    if (url.searchParams.get('state') !== checks.expectedState) throw new Error('state mismatch')
    return { claims: () => claims }
  })
}))

const { readSession, getCookie } = await import('../../services/session')
const { signNext } = await import('../../services/appAccess/sign')
const loginPost = (await import('../../routes/login/POST')).default
const logout = (await import('../../routes/logout/POST')).default
const oidcStart = (await import('../../routes/auth/oidc/GET')).default
const callback = (await import('../../routes/auth/callback/GET')).default
const { loginLimiter } = await import('../../services/loginGuard')
beforeEach(() => loginLimiter.reset())

const cookieValue = (res: Response, name: string) =>
  res.headers.getSetCookie().find(c => c.startsWith(`${name}=`))?.split(';')[0].slice(name.length + 1)

const form = (fields: Record<string, string>, origin = 'http://p9m.lvh.me') =>
  new Request('http://p9m.lvh.me/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin, host: 'p9m.lvh.me' },
    body: new URLSearchParams(fields).toString()
  })

describe('admin login', () => {
  it('signs the admin in and redirects home', async () => {
    const res = await loginPost(form({ username: 'admin', password: 'pw' }))
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/')
    expect(readSession(cookieValue(res, 'p9m_session'))).toMatchObject({ sub: 'admin', role: 'admin' })
  })

  it('sends wrong credentials and cross-site posts back to the login page', async () => {
    const bad = await loginPost(form({ username: 'admin', password: 'nope' }))
    expect(bad.headers.get('location')).toBe('/login?error=Invalid%20username%20or%20password')
    expect(bad.headers.getSetCookie()).toEqual([])
    const csrf = await loginPost(form({ username: 'admin', password: 'pw' }, 'http://evil.example'))
    expect(csrf.status).toBe(403)
  })

  it('after signing in for a sandbox app (p9m_next): back to /auth/app/start, and the cookie cleared', async () => {
    const req = form({ username: 'admin', password: 'pw' })
    req.headers.set('cookie', `p9m_next=${signNext('/auth/app/start?rd=https%3A%2F%2Fshop-web.lvh.me%2F')}`)
    const res = await loginPost(req)
    expect(res.headers.get('location')).toBe('/auth/app/start?rd=https%3A%2F%2Fshop-web.lvh.me%2F')
    expect(res.headers.getSetCookie().some(c => /^p9m_next=;.*Max-Age=0/.test(c))).toBe(true)
    // Anything else in it: home, as without it
    const other = form({ username: 'admin', password: 'pw' })
    other.headers.set('cookie', `p9m_next=${encodeURIComponent('https://evil.example/')}`)
    expect((await loginPost(other)).headers.get('location')).toBe('/')
  })

  it('logs out by clearing the cookie', async () => {
    const res = await logout(new Request('http://p9m.lvh.me/logout', { method: 'POST', headers: { origin: 'http://p9m.lvh.me', host: 'p9m.lvh.me' } }))
    expect(res.status).toBe(303)
    expect(res.headers.getSetCookie()[0]).toMatch(/^p9m_session=; .*Max-Age=0/)
  })
})

describe('OIDC login', () => {
  beforeEach(() => { claims = { email: 'Alice@Example.com', email_verified: true } })

  async function start() {
    const res = await oidcStart(new Request('http://p9m.lvh.me/auth/oidc'))
    expect(res.status).toBe(302)
    const target = new URL(res.headers.get('location')!)
    expect(target.searchParams.get('redirect_uri')).toBe('http://p9m.lvh.me/auth/callback')
    expect(target.searchParams.get('code_challenge_method')).toBe('S256')
    return cookieValue(res, 'p9m_oidc')!
  }
  const cb = (flow: string | undefined, state = 'state-1') =>
    callback(new Request(`http://p9m.lvh.me/auth/callback?code=abc&state=${state}`, { headers: flow ? { cookie: `p9m_oidc=${flow}` } : {} }))

  it('creates a user session from a verified email', async () => {
    const res = await cb(await start())
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/')
    expect(readSession(cookieValue(res, 'p9m_session'))).toMatchObject({ sub: 'alice@example.com', role: 'user' })
    expect(res.headers.getSetCookie().some(c => /^p9m_oidc=; .*Max-Age=0/.test(c))).toBe(true)
  })

  it('signed in for a sandbox app (p9m_next): back to /auth/app/start', async () => {
    const flow = await start()
    const res = await callback(new Request('http://p9m.lvh.me/auth/callback?code=abc&state=state-1', { headers: { cookie: `p9m_oidc=${flow}; p9m_next=${signNext('/auth/app/start?rd=x')}` } }))
    expect(res.headers.get('location')).toBe('/auth/app/start?rd=x')
    expect(res.headers.getSetCookie().some(c => /^p9m_next=;.*Max-Age=0/.test(c))).toBe(true)
  })

  // A workshop: everyone behind one company address. Failed Google sign-ins (a wrong account, a cancelled or
  // expired flow) and failed admin passwords from that address must not lock the others out of Google sign-in:
  // a callback cannot be guessed (the provider's code, bound to the browser's flow cookie)
  it('failed sign-ins from a shared address never refuse a valid Google sign-in from it', async () => {
    const room = (flow: string | undefined, state = 'state-1') =>
      callback(new Request(`http://p9m.lvh.me/auth/callback?code=abc&state=${state}`, { headers: { 'x-p9m-client-ip': '198.51.100.7', ...(flow ? { cookie: `p9m_oidc=${flow}` } : {}) } }))
    for (let i = 0; i < 12; i++) await room(await start(), 'other-state')
    const pw = form({ username: 'admin', password: 'nope' })
    pw.headers.set('x-p9m-client-ip', '198.51.100.7')
    for (let i = 0; i < 6; i++) await loginPost(pw.clone())
    const res = await room(await start())
    expect(res.headers.get('location')).toBe('/')
    expect(readSession(cookieValue(res, 'p9m_session'))).toMatchObject({ sub: 'alice@example.com' })
  })

  it('rejects missing flow, bad state, no email and unverified email', async () => {
    for (const res of [
      await cb(undefined),
      await cb(await start(), 'other-state'),
      await (async () => { claims = { email_verified: true }; return cb(await start()) })(),
      await (async () => { claims = { email: 'x@y.z', email_verified: false }; return cb(await start()) })()
    ]) {
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toMatch(/^\/login\?error=/)
      expect(cookieValue(res, 'p9m_session')).toBeUndefined()
    }
  })

  it('refuses an account that is not on OIDC_ALLOWED_DOMAINS / OIDC_ALLOWED_EMAILS, and says why', async () => {
    vi.stubEnv('OIDC_ALLOWED_DOMAINS', 'example.com')
    try {
      claims = { email: 'mallory@gmail.com', email_verified: true }
      const res = await cb(await start())
      expect(res.status).toBe(303)
      expect(decodeURIComponent(res.headers.get('location')!)).toContain('mallory@gmail.com) may not sign in here')
      expect(cookieValue(res, 'p9m_session')).toBeUndefined()
      claims = { email: 'Alice@Example.com', email_verified: true }
      expect(readSession(cookieValue(await cb(await start()), 'p9m_session'))).toMatchObject({ sub: 'alice@example.com' })
    } finally { vi.stubEnv('OIDC_ALLOWED_DOMAINS', '') }
  })

  it('with USER_HOST, the callback comes back to the host the sign-in started on; a user on the admin\'s is sent to theirs', async () => {
    vi.stubEnv('USER_HOST', 'sbx.lvh.me')
    vi.stubEnv('OIDC_ADMIN_EMAILS', 'boss@example.com')
    try {
      const startOn = async (host: string) => {
        const res = await oidcStart(new Request(`http://${host}/auth/oidc`, { headers: { host } }))
        return { flow: cookieValue(res, 'p9m_oidc')!, redirect: new URL(res.headers.get('location')!).searchParams.get('redirect_uri') }
      }
      const cbOn = (host: string, flow: string) =>
        callback(new Request(`http://${host}/auth/callback?code=abc&state=state-1`, { headers: { host, cookie: `p9m_oidc=${flow}` } }))
      const user = await startOn('sbx.lvh.me')
      expect(user.redirect).toBe('http://sbx.lvh.me/auth/callback')
      claims = { email: 'bob@example.com', email_verified: true }
      expect(readSession(cookieValue(await cbOn('sbx.lvh.me', user.flow), 'p9m_session'))).toMatchObject({ sub: 'bob@example.com', role: 'user' })
      // On the admin's address: no session, on to the users' sign-in
      const there = await startOn('p9m.lvh.me')
      expect(there.redirect).toBe('http://p9m.lvh.me/auth/callback')
      const res = await cbOn('p9m.lvh.me', there.flow)
      expect(res.headers.get('location')).toBe('http://sbx.lvh.me/auth/oidc')
      expect(cookieValue(res, 'p9m_session')).toBeUndefined()
      // The admin signs in there
      claims = { email: 'boss@example.com', email_verified: true }
      expect(readSession(cookieValue(await cbOn('p9m.lvh.me', (await startOn('p9m.lvh.me')).flow), 'p9m_session'))).toMatchObject({ role: 'admin' })
    } finally { vi.stubEnv('USER_HOST', 'off'); vi.stubEnv('OIDC_ADMIN_EMAILS', ''); claims = { email: 'Alice@Example.com', email_verified: true } }
  })

  it('an address on OIDC_ADMIN_EMAILS gets an admin session; anyone else a user one', async () => {
    vi.stubEnv('OIDC_ADMIN_EMAILS', 'alice@example.com')
    try {
      expect(readSession(cookieValue(await cb(await start()), 'p9m_session'))).toMatchObject({ sub: 'alice@example.com', role: 'admin' })
      claims = { email: 'bob@example.com', email_verified: true }
      expect(readSession(cookieValue(await cb(await start()), 'p9m_session'))).toMatchObject({ sub: 'bob@example.com', role: 'user' })
    } finally { vi.stubEnv('OIDC_ADMIN_EMAILS', '') }
  })

  it('rejects a claims email with no "@" (a lax provider could otherwise hand out sub "admin")', async () => {
    claims = { email: 'admin', email_verified: true }
    const res = await cb(await start())
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toMatch(/^\/login\?error=/)
    expect(cookieValue(res, 'p9m_session')).toBeUndefined()
  })
})
