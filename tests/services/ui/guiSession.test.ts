import { describe, it, expect, vi, afterEach } from 'vitest'

vi.stubEnv('SESSION_SECRET', 'test-secret')
vi.stubEnv('PUBLIC_URL', 'https://console.p9m.dev')
vi.stubEnv('UI_HOST', 'console.p9m.dev')

const { createSession } = await import('../../../services/session')
const { guiSession } = await import('../../../services/ui/headlessPage')

const at = (host: string, path: string, role?: 'user' | 'admin') =>
  guiSession(new Request(`http://localhost${path}`, { headers: { host, ...(role ? { cookie: `__Host-p9m_session=${createSession(role === 'admin' ? 'admin' : 'bob@example.com', role)}` } : {}) } }))
const location = (r: unknown) => r instanceof Response ? r.headers.get('location') : null

afterEach(() => vi.stubEnv('USER_HOST', 'off'))

describe('guiSession', () => {
  it('without USER_HOST: the admin\'s session, a user\'s page, sign-in for nobody', async () => {
    expect(at('console.p9m.dev', '/overview', 'admin')).toMatchObject({ role: 'admin' })
    const page = at('console.p9m.dev', '/', 'user') as Response
    expect(await page.text()).toContain('/p9m:init https://console.p9m.dev')
    expect(location(at('console.p9m.dev', '/'))).toBe('/login')
  })
  it('with USER_HOST: the admin\'s pages on UI_HOST, the users\' page on USER_HOST, each sent to its own', async () => {
    vi.stubEnv('USER_HOST', 'sbx.p9m.dev')
    expect(at('console.p9m.dev', '/overview', 'admin')).toMatchObject({ role: 'admin' })
    expect(location(at('sbx.p9m.dev', '/overview?x=1', 'admin'))).toBe('https://console.p9m.dev/overview?x=1')
    expect(location(at('console.p9m.dev', '/', 'user'))).toBe('https://sbx.p9m.dev/')
    const page = at('sbx.p9m.dev', '/', 'user') as Response
    const html = await page.text()
    expect(html).toContain('/p9m:init https://sbx.p9m.dev')
    expect(html).not.toContain('console.p9m.dev')
  })
})
