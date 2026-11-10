import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSION_SECRET', 'test-secret')
vi.stubEnv('ADMIN_TOKEN', 'admin-secret')

const sandboxes: Record<string, { name: string; owner: string }> = {
  'p9m-a': { name: 'p9m-a', owner: 'alice@example.com' },
  'p9m-admin': { name: 'p9m-admin', owner: 'admin' },
}
vi.mock('../../../services/sandbox', () => ({
  sandboxService: {
    getSandbox: vi.fn(async (name: string) => {
      if (!sandboxes[name]) throw new Error(`Sandbox not found: ${name}`)
      return sandboxes[name]
    }),
  },
}))
vi.mock('../../../services/tokens', () => ({
  resolveToken: vi.fn((t: string) => t === 'p9m_alice' ? { owner: 'alice@example.com', sandbox: null } : null),
}))
const consent = vi.hoisted(() => ({
  grantCopyConsent: vi.fn(), withdrawCopyConsent: vi.fn(), takeCopyConsent: vi.fn(), recordCopy: vi.fn(),
  copyConsent: vi.fn(() => null), copyHistory: vi.fn(() => []), CONSENT_HOURS: 24,
}))
vi.mock('../../../services/copyConsent', () => consent)

const claim = (await import('../../../routes/sandboxes/[name]/copy-claim/POST')).default
const pageGet = (await import('../../../routes/sandboxes/[name]/copy-consent/GET')).default
const pagePost = (await import('../../../routes/sandboxes/[name]/copy-consent/POST')).default
const { createSession, SESSION_COOKIE } = await import('../../../services/session')

const claimReq = (name: string, body: unknown = {}, auth = 'Bearer admin-secret') =>
  new Request(`http://p9m.lvh.me/sandboxes/${name}/copy-claim`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) })
const cookie = (sub: string, role: 'user' | 'admin' = 'user') => `${SESSION_COOKIE}=${createSession(sub, role)}`
const form = (decision: string, c: string, origin = 'http://p9m.lvh.me') => new Request('http://p9m.lvh.me/sandboxes/p9m-a/copy-consent', {
  method: 'POST', headers: { cookie: c, origin, host: 'p9m.lvh.me', 'content-type': 'application/x-www-form-urlencoded' }, body: `decision=${decision}`,
})

describe('copying a sandbox', () => {
  beforeEach(() => { vi.clearAllMocks(); consent.takeCopyConsent.mockReturnValue(false) })

  describe('POST copy-claim', () => {
    it('only for the admin: the owner\'s own token cannot', async () => {
      expect((await claim(claimReq('p9m-a', {}, 'Bearer p9m_alice'))).status).toBe(403)
      expect(consent.takeCopyConsent).not.toHaveBeenCalled()
    })
    it('without the owner\'s permission: refused, with the page to send them, and nothing recorded', async () => {
      const res = await claim(claimReq('p9m-a'))
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toBe('consent_required')
      expect(body.url).toMatch(/\/sandboxes\/p9m-a\/copy-consent$/)
      expect(consent.recordCopy).not.toHaveBeenCalled()
    })
    it('with it: goes ahead and records it', async () => {
      consent.takeCopyConsent.mockReturnValue(true)
      const res = await claim(claimReq('p9m-a'))
      expect(res.status).toBe(200)
      expect((await res.json()).via).toBe('consent')
      expect(consent.recordCopy).toHaveBeenCalledWith('p9m-a', expect.objectContaining({ by: 'admin', via: 'consent' }))
    })
    it('an admin\'s own sandbox needs none', async () => {
      const res = await claim(claimReq('p9m-admin'))
      expect((await res.json()).via).toBe('own')
      expect(consent.takeCopyConsent).not.toHaveBeenCalled()
    })
    it('no_consent needs a reason, and the reason is recorded', async () => {
      expect((await claim(claimReq('p9m-a', { no_consent: true }))).status).toBe(400)
      expect((await claim(claimReq('p9m-a', { no_consent: true, reason: '  ' }))).status).toBe(400)
      expect(consent.recordCopy).not.toHaveBeenCalled()
      const res = await claim(claimReq('p9m-a', { no_consent: true, reason: 'left the company' }))
      expect((await res.json()).via).toBe('no_consent')
      expect(consent.recordCopy).toHaveBeenCalledWith('p9m-a', expect.objectContaining({ via: 'no_consent', reason: 'left the company' }))
    })
    it('an unknown sandbox is 404', async () => {
      expect((await claim(claimReq('p9m-none'))).status).toBe(404)
    })
  })

  describe('the owner\'s page', () => {
    it('signed out: to the sign-in', async () => {
      const res = await pageGet(new Request('http://p9m.lvh.me/sandboxes/p9m-a/copy-consent', { headers: { host: 'p9m.lvh.me' } }))
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toBe('/login')
    })
    it('shows the owner what a copy holds', async () => {
      const res = await pageGet(new Request('http://p9m.lvh.me/sandboxes/p9m-a/copy-consent', { headers: { host: 'p9m.lvh.me', cookie: cookie('alice@example.com') } }))
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).toContain('Allow one copy')
      expect(text).toContain('passwords')
    })
    it('the owner can allow, and withdraw', async () => {
      expect((await pagePost(form('allow', cookie('alice@example.com')))).status).toBe(200)
      expect(consent.grantCopyConsent).toHaveBeenCalledWith('p9m-a', 'alice@example.com')
      await pagePost(form('withdraw', cookie('alice@example.com')))
      expect(consent.withdrawCopyConsent).toHaveBeenCalledWith('p9m-a')
    })
    it('the admin, who is the one asking, cannot allow it for the owner', async () => {
      expect((await pagePost(form('allow', cookie('admin', 'admin')))).status).toBe(403)
      expect(consent.grantCopyConsent).not.toHaveBeenCalled()
    })
    it('nor can someone else, nor a token, nor another site', async () => {
      expect((await pagePost(form('allow', cookie('bob@example.com')))).status).toBe(403)
      const token = new Request('http://p9m.lvh.me/sandboxes/p9m-a/copy-consent', { method: 'POST', headers: { authorization: 'Bearer p9m_alice', origin: 'http://p9m.lvh.me', host: 'p9m.lvh.me', 'content-type': 'application/x-www-form-urlencoded' }, body: 'decision=allow' })
      expect((await pagePost(token)).status).toBe(303)
      expect((await pagePost(form('allow', cookie('alice@example.com'), 'https://evil.example'))).status).toBe(403)
      expect(consent.grantCopyConsent).not.toHaveBeenCalled()
    })
  })
})
