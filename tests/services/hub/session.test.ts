import { describe, it, expect, beforeEach } from 'vitest'
import { createHubSession, readHubSession, hubCookieHeader, hubViewer, HUB_COOKIE } from '../../../services/hub/session'

beforeEach(() => {
  process.env.SESSION_SECRET = 'test-secret'
  process.env.HOST_DOMAIN = 'example.com'
  process.env.PUBLIC_URL = 'https://p9m.example.com'
  process.env.OIDC_ALLOWED_EMAILS = 'anna@example.com'
  process.env.HUB_ALLOWED_DOMAINS = 'example.com'
})

const req = (cookie?: string) => new Request('https://hub.example.com/', { headers: cookie ? { cookie } : {} })

describe('hub session', () => {
  it('round-trips and expires', () => {
    const v = createHubSession('peter@example.com', 'Péter', 0)
    expect(readHubSession(v, 0)).toMatchObject({ sub: 'peter@example.com', name: 'Péter' })
    expect(readHubSession(v, 8 * 24 * 3600 * 1000)).toBeNull()
    expect(readHubSession(v + 'x', 0)).toBeNull()
  })
  it('is a Secure, host-only cookie on an https Hub', () => {
    const h = hubCookieHeader(HUB_COOKIE, 'v', 60)
    expect(h).toContain('__Host-p9m_hub=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure')
    expect(h).not.toContain('Domain=')
  })
  it('hubViewer re-checks the lists', () => {
    expect(hubViewer(req(`__Host-p9m_hub=${createHubSession('peter@example.com', null)}`))?.sub).toBe('peter@example.com')
    expect(hubViewer(req(`__Host-p9m_hub=${createHubSession('admin', null)}`))?.sub).toBe('admin')
    expect(hubViewer(req(`__Host-p9m_hub=${createHubSession('eve@other.org', null)}`))).toBeNull()
    expect(hubViewer(req())).toBeNull()
  })
})

describe('the Hub cookies are __Host- over https: a sandbox app (a sibling host) cannot plant one', () => {
  it('written and read as __Host-; a planted plain p9m_hub is ignored', () => {
    expect(hubCookieHeader(HUB_COOKIE, 'v', 60)).toMatch(/^__Host-p9m_hub=v; Path=\/; .*Secure$/)
    expect(hubCookieHeader('p9m_hub_oidc', 'v', 60)).toMatch(/^__Host-p9m_hub_oidc=v;/)
    const value = createHubSession('anna@example.com', 'Anna')
    expect(hubViewer(new Request('https://hub.example.com/', { headers: { cookie: `p9m_hub=${value}` } }))).toBeNull()
    expect(hubViewer(new Request('https://hub.example.com/', { headers: { cookie: `__Host-p9m_hub=${value}` } }))?.sub).toBe('anna@example.com')
  })
})
