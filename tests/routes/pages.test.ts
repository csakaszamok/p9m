import { describe, it, expect, vi } from 'vitest'

vi.stubEnv('SESSION_SECRET', 'test-secret')
vi.mock('../../services/sandbox', () => ({
  sandboxService: {
    getSandbox: vi.fn(async (n: string) => {
      if (n !== 'p9m-mine') throw new Error(`Sandbox not found: ${n}`)
      return { name: n, owner: 'alice@example.com' }
    }),
  },
}))
vi.stubEnv('OIDC_ISSUER', 'https://accounts.example.com')
vi.stubEnv('OIDC_CLIENT_ID', 'cid')
vi.stubEnv('OIDC_CLIENT_SECRET', 'cs')
vi.stubEnv('OIDC_PROVIDER_NAME', 'Google')

const { createSession } = await import('../../services/session')
const index = (await import('../../routes/index/GET')).default
const admin = (await import('../../routes/admin/GET')).default
const overview = (await import('../../routes/overview/GET')).default
const tokens = (await import('../../routes/settings/tokens/GET')).default
const sshKeys = (await import('../../routes/settings/ssh-keys/GET')).default
const login = (await import('../../routes/login/GET')).default
const asset = (await import('../../routes/assets/[file]/GET')).default
const terminalPage = (await import('../../routes/sandboxes/[name]/terminal/GET')).default
const logsPage = (await import('../../routes/sandboxes/[name]/logs/GET')).default

const as = (sub: string, role: 'user' | 'admin') => ({ cookie: `p9m_session=${createSession(sub, role)}` })
const ADMIN = as('admin', 'admin')
const r = (p: string, headers: Record<string, string> = {}) => new Request(`http://p9m.lvh.me${p}`, { headers })

describe('pages', () => {
  it('redirects to /login without a session', async () => {
    for (const handler of [index, admin, tokens]) {
      const res = await handler(r('/x'))
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/login')
    }
  })

  it('renders My sandboxes with navigation for the admin', async () => {
    const res = await index(r('/', as('admin', 'admin')))
    const html = await res.text()
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    expect(html).toContain('data-view="mine"')
    expect(html).toContain('href="/admin"')
    expect(html).toContain('<script src="/assets/app.js"')
  })

  // Headless: users get and use their sandboxes from Claude Code; the sign-in only approves /p9m:init
  it('a user gets no web UI on any page: the Claude Code steps instead', async () => {
    const user = as('alice@example.com', 'user')
    for (const [handler, path] of [[index, '/'], [overview, '/overview'], [tokens, '/settings/tokens'], [sshKeys, '/settings/ssh-keys'], [terminalPage, '/sandboxes/p9m-mine/terminal'], [logsPage, '/sandboxes/p9m-mine/logs']] as const) {
      const res = await handler(r(path, user))
      expect(res.status, path).toBe(200)
      expect(res.headers.get('x-frame-options'), path).toBe('DENY')
      const html = await res.text()
      expect(html, path).toContain('Signed in as alice@example.com')
      expect(html, path).toContain('/p9m:init http://p9m.lvh.me')
      expect(html, path).toContain('claude plugin install p9m@p9m')
      expect(html, path).toContain('action="/logout"')
      expect(html, path).not.toContain('/assets/app.js')
      expect(html, path).not.toContain('data-sandbox=')
    }
  })

  it('offers the new token as a .env for an agent, on My sandboxes and Access tokens', async () => {
    for (const res of [await index(r('/', ADMIN)), await tokens(r('/settings/tokens', ADMIN))]) {
      const html = await res.text()
      expect(html).toContain('data-download-env')
      expect(html).toContain('data-export-dialog')
      expect(html).toContain('keep it out of git')
    }
  })

  it('keeps non-admins out of the admin page', async () => {
    const res = await admin(r('/admin', as('alice@example.com', 'user')))
    expect(await res.text()).toContain('Signed in as alice@example.com')
    const ok = await admin(r('/admin', as('admin', 'admin')))
    expect(await ok.text()).toContain('data-view="all"')
  })

  it('renders the terminal page for the owner only, loading xterm from our own assets', async () => {
    const page = await terminalPage(r('/sandboxes/p9m-mine/terminal', ADMIN))
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('/assets/xterm.js')
    expect(html).toContain('/assets/terminal.js')
    expect(html).toContain('data-sandbox="p9m-mine"')
    expect((await terminalPage(r('/sandboxes/p9m-other/terminal', ADMIN))).status).toBe(404)
    expect((await terminalPage(r('/sandboxes/p9m-mine/terminal'))).status).toBe(302)
  })

  it("a terminal in one of the sandbox's containers names it on the page; an odd name is not found", async () => {
    const html = await (await terminalPage(r('/sandboxes/p9m-mine/terminal?container=claude-dev', ADMIN))).text()
    expect(html).toContain('data-container="claude-dev"')
    expect(html).toContain('/ claude-dev')
    expect((await terminalPage(r('/sandboxes/p9m-mine/terminal?container=%3Cx%3E', ADMIN))).status).toBe(404)
  })

  // A sandbox's app on another *.<domain> is same-site: it could frame our pages (the terminal above all)
  it('forbids framing of every page', async () => {
    for (const res of [
      await terminalPage(r('/sandboxes/p9m-mine/terminal', ADMIN)),
      await index(r('/', ADMIN)),
      await login(r('/login')),
    ]) {
      expect(res.headers.get('x-frame-options')).toBe('DENY')
      expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
    }
  })

  it('renders the logs page for the owner only', async () => {
    const page = await logsPage(r('/sandboxes/p9m-mine/logs', ADMIN))
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('/assets/logs.js')
    expect(html).toContain('data-sandbox="p9m-mine"')
    expect(page.headers.get('x-frame-options')).toBe('DENY')
    expect((await logsPage(r('/sandboxes/p9m-other/logs', ADMIN))).status).toBe(404)
    expect((await logsPage(r('/sandboxes/p9m-mine/logs'))).status).toBe(302)
  })

  it('loads the panel script before app.js and serves it', async () => {
    const html = await (await index(r('/', ADMIN))).text()
    expect(html.indexOf('/assets/panel.js')).toBeGreaterThan(-1)
    expect(html.indexOf('/assets/panel.js')).toBeLessThan(html.indexOf('/assets/app.js'))
    expect((await asset(r('/assets/panel.js'))).status).toBe(200)
  })

  it('serves the logs script', async () => {
    expect((await asset(r('/assets/logs.js'))).status).toBe(200)
  })

  it('serves the vendored xterm files and the terminal script', async () => {
    for (const f of ['xterm.js', 'xterm.css', 'addon-fit.js', 'terminal.js', 'idle.js']) expect((await asset(r(`/assets/${f}`))).status, f).toBe(200)
  })

  it('renders the SSH keys page, linked from the header', async () => {
    const page = await (await sshKeys(r('/settings/ssh-keys', ADMIN))).text()
    expect(page).toContain('data-view="ssh-keys"')
    expect(page).toContain('data-ssh-key-form')
    expect(page).toContain('data-confirm-dialog')
    const home = await (await index(r('/', ADMIN))).text()
    expect(home).toContain('href="/settings/ssh-keys"')
    expect(home).toContain('name="ssh_keys"')
  })

  it('renders the tokens page', async () => {
    expect(await (await tokens(r('/settings/tokens', ADMIN))).text()).toContain('data-view="tokens"')
  })

  it('offers a token limited to one sandbox, on the tokens page and next to a sandbox', async () => {
    const tokensPage = await (await tokens(r('/settings/tokens', ADMIN))).text()
    expect(tokensPage).toContain('name="sandbox"')
    expect(tokensPage).toContain('Bearer p9m_')
    const home = await (await index(r('/', ADMIN))).text()
    expect(home).toContain('data-token-dialog')
  })

  // The browser's confirm() can be switched off ("prevent this page from creating additional
  // dialogs") or missing (embedded browsers): it then answers Cancel at once and Archive / Revoke
  // silently do nothing. Both pages ask with their own <dialog> instead.
  it('asks for confirmation with its own dialog, never the browser confirm()', async () => {
    const home = await (await index(r('/', ADMIN))).text()
    const tokensPage = await (await tokens(r('/settings/tokens', ADMIN))).text()
    for (const page of [home, tokensPage]) expect(page).toContain('data-confirm-dialog')
    const js = await (await asset(r('/assets/app.js'))).text()
    expect(js).not.toMatch(/(^|[^.\w])confirm\(/m)
  })

  it('login page shows the provider button and an escaped error', async () => {
    const html = await (await login(r('/login?error=%3Cb%3Ebad%3C%2Fb%3E'))).text()
    expect(html).toContain('Sign in with Google')
    expect(html).toContain('&lt;b&gt;bad&lt;/b&gt;')
    expect(html).not.toContain('<b>bad</b>')
  })

  it('shows the logo: favicon on every page, next to the name in the top bar', async () => {
    const home = await (await index(r('/', ADMIN))).text()
    expect(home).toContain('<link rel="icon" href="/assets/logo.svg" type="image/svg+xml">')
    expect(home).toMatch(/class="brand"><img src="\/assets\/logo.svg"/)
    const loginPage = await (await login(r('/login'))).text()
    expect(loginPage).toContain('<link rel="icon" href="/assets/logo.svg" type="image/svg+xml">')
  })

  it('the sign-in page shows the sandbox places above the sign-in buttons', async () => {
    const { loginCapacity } = await import('../../services/loginCapacity')
    vi.spyOn(loginCapacity, 'get').mockResolvedValueOnce({ used: 143, limit: 200 })
    const page = await (await login(r('/login'))).text()
    expect(page).toContain('Sandbox places: 143 taken · 57 free')
    expect(page.indexOf('class="capacity')).toBeLessThan(page.indexOf('Sign in with Google'))
  })

  // Counting needs Docker; without it (here: no listSandboxes) the page still comes, without the line
  it('the sign-in page without the sandbox places when they cannot be counted', async () => {
    const page = await (await login(r('/login'))).text()
    expect(page).toContain('Sign in with Google')
    expect(page).not.toContain('class="capacity')
  })

  it('the sign-in page has the ember background', async () => {
    const loginPage = await (await login(r('/login'))).text()
    expect(loginPage).toContain('<script src="/assets/embers.js" defer></script>')
  })

  it('the topbar has a place for the server places, filled by app.js on every page', async () => {
    for (const res of [await index(r('/', ADMIN)), await tokens(r('/settings/tokens', ADMIN))]) {
      expect(/<header class="topbar">[\s\S]*?<\/header>/.exec(await res.text())?.[0]).toContain('data-places hidden')
    }
  })

  it('the sandbox page has the compose viewer', async () => {
    const home = await (await index(r('/', ADMIN))).text()
    expect(home).toContain('data-compose-dialog')
    expect(home).not.toContain('data-compose-tab')
  })

  // Most creates use the template's stack as it is: its compose is one click away, not a 24-line box to scroll past
  it('New sandbox: the starter stack is shown, read-only, in a section that starts closed', async () => {
    const home = await (await index(r('/', ADMIN))).text()
    const section = /<details[^>]*data-compose-section[^>]*>[\s\S]*?<\/details>/.exec(home)?.[0] ?? ''
    expect(section).toContain('data-compose-view')
    // The template's stack cannot be changed: nothing in the form to send a compose text with
    expect(section).not.toMatch(/<textarea|name="compose"/)
    expect(section).not.toMatch(/<details[^>]*data-compose-section[^>]*\bopen\b/)
  })

  it('the sandbox page has the TCP connect dialog', async () => {
    const home = await (await index(r('/', ADMIN))).text()
    expect(home).toContain('data-connect-dialog')
    expect(home).toContain('data-runtimes')
    expect(home).toContain('data-compose-view')
    expect(home).toContain('data-resource-dialog')
    expect(home).toContain('name="cpus"')
    expect(home).toContain('name="memory"')
    expect(home).toContain('name="runtime"')
  })

  it('serves only the known assets', async () => {
    const js = await asset(r('/assets/app.js'))
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toMatch(/javascript/)
    expect((await asset(r('/assets/style.css'))).headers.get('content-type')).toMatch(/text\/css/)
    expect((await asset(r('/assets/secret.env'))).status).toBe(404)
  })

  it('serves the ember animation, the waiting-page poller, the approval page script and the logo', async () => {
    for (const f of ['embers.js', 'waiting.js', 'activate.js']) {
      const res = await asset(r(`/assets/${f}`))
      expect(res.status, f).toBe(200)
      expect(res.headers.get('content-type'), f).toMatch(/javascript/)
    }
    const logo = await asset(r('/assets/logo.svg'))
    expect(logo.status).toBe(200)
    expect(logo.headers.get('content-type')).toMatch(/image\/svg\+xml/)
    expect(await logo.text()).toContain('<svg')
  })
})

describe('Overview: the Hub feed link', () => {
  it('has the Hub feed block (shown for the admin by app.js)', async () => {
    const overview = (await import('../../routes/overview/GET')).default
    const res = await overview(new Request('http://localhost/overview', { headers: { cookie: `p9m_session=${createSession('admin', 'admin')}` } }))
    const body = await res.text()
    expect(body).toContain('id="hub-feed" hidden')
    expect(body).toContain('id="hub-feed-new"')
  })
})
