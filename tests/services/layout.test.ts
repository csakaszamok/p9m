import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderPage, SANDBOX_VIEW_BODY, breadcrumb, initials } from '../../services/ui/layout'
import { setView, setTheme } from '../../services/userPrefs'

const user = { sub: 'anna', role: 'user' as const, exp: 0 }
const admin = { sub: 'root', role: 'admin' as const, exp: 0 }
const page = (session: typeof user | typeof admin) => renderPage({ title: 'x', view: 'mine', session, body: '' })

describe('renderPage: light / dark theme', () => {
  beforeEach(() => {
    vi.stubEnv('USER_PREFS_FILE', path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-')), 'user-prefs.json'))
    vi.stubEnv('GITHUB_STATS', 'off')
  })
  afterEach(() => { vi.unstubAllEnvs() })

  it("until one is chosen the browser decides (no data-theme); then the account's choice", () => {
    expect(page(user)).toMatch(/<html lang="en">/)
    setTheme('anna', 'light')
    expect(page(user)).toContain('<html lang="en" data-theme="light">')
    expect(page(admin)).toMatch(/<html lang="en">/)
  })
  it('has the switch in the app bar, for users and the admin', () => {
    for (const s of [user, admin]) expect(page(s)).toMatch(/<button type="button" class="theme-switch" data-theme-toggle[^>]*aria-label="[^"]+"/)
  })
})

describe('renderPage: Simple / Advanced', () => {
  beforeEach(() => {
    vi.stubEnv('USER_PREFS_FILE', path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-')), 'user-prefs.json'))
    vi.stubEnv('GITHUB_STATS', 'off')
  })
  afterEach(() => { vi.unstubAllEnvs() })

  it('a user starts in Simple, the admin in Advanced', () => {
    expect(page(user)).toContain('data-mode="simple"')
    expect(page(admin)).toContain('data-mode="advanced"')
  })
  it('follows the choice saved for the account', () => {
    vi.stubEnv('USER_VIEW_SWITCH', 'true')
    setView('anna', 'advanced')
    expect(page(user)).toContain('data-mode="advanced"')
  })
  it('has the switch in the topbar, the current one pressed', () => {
    vi.stubEnv('USER_VIEW_SWITCH', 'true')
    const html = page(user)
    expect(html).toMatch(/<button[^>]*data-mode-set="simple"[^>]*aria-pressed="true"/)
    expect(html).toMatch(/<button[^>]*data-mode-set="advanced"[^>]*aria-pressed="false"/)
  })
  it('without USER_VIEW_SWITCH=true: a user is in Simple with no switch, whatever they chose; the admin keeps it', () => {
    setView('anna', 'advanced')
    const html = page(user)
    expect(html).toContain('data-mode="simple"')
    expect(html).not.toContain('data-mode-set')
    expect(html).not.toContain('class="mode-switch"')
    expect(page(admin)).toMatch(/<button[^>]*data-mode-set="advanced"[^>]*aria-pressed="true"/)
  })
  it('marks what Simple hides: Overview, Settings, tokens, SSH keys', () => {
    const html = page(user)
    expect(html).toMatch(/<a class="rail-item adv" href="\/overview"/)
    expect(html).toMatch(/<a class="rail-item adv" href="\/settings\/tokens"/)
    expect(html).toMatch(/<a class="rail-item adv" href="\/settings\/ssh-keys"/)
    expect(html).toMatch(/<div class="rail-sec adv">Settings<\/div>/)
    expect(html).toMatch(/<a class="rail-item active" href="\/"/)
  })
  it('the rail marks the current page; All sandboxes for the admin only', () => {
    const at = (view: 'overview' | 'mine' | 'all' | 'tokens' | 'ssh-keys') => renderPage({ title: 'x', view, session: admin, body: '' })
    expect(at('mine')).toMatch(/<a class="rail-item active" href="\/" aria-current="page"/)
    expect(at('tokens')).toMatch(/<a class="rail-item adv active" href="\/settings\/tokens" aria-current="page"/)
    expect(at('all')).toMatch(/<a class="rail-item active" href="\/admin" aria-current="page"/)
    expect(page(user)).not.toContain('href="/admin"')
    expect(page(admin)).toContain('href="/admin"')
    for (const v of ['overview', 'mine', 'all', 'tokens', 'ssh-keys'] as const) expect(at(v)).not.toContain('class="subnav')
  })
  it('breadcrumbs per page', () => {
    expect(breadcrumb('tokens')).toContain('<span>Settings</span> › <span>Access tokens</span>')
    expect(breadcrumb('ssh-keys')).toContain('<span>Settings</span> › <span>SSH keys</span>')
    expect(breadcrumb('mine')).toMatch(/<a href="\/" data-crumb-root>Sandboxes<\/a>/)
    expect(breadcrumb('all')).toMatch(/<a href="\/admin" data-crumb-root>All sandboxes<\/a>/)
    expect(page(user)).toContain('data-crumbs')
  })
  it('initials for the account button', () => {
    expect(initials('anna')).toBe('AN')
    expect(initials('jane.doe@x.io')).toBe('JD')
    expect(initials('root')).toBe('RO')
    expect(initials('')).toBe('?')
  })
  it('the account menu holds the mode switch, About and Sign out', () => {
    vi.stubEnv('USER_VIEW_SWITCH', 'true')
    const menu = /<div class="account-menu" data-account-menu hidden>[\s\S]*?<\/div><!--\/account-menu-->/.exec(page(user))?.[0] ?? ''
    expect(menu).toContain('data-mode-set="simple"')
    expect(menu).toContain('href="/about"')
    expect(menu).toContain('action="/logout"')
    expect(menu).toContain('data-idle-left')
    expect(page(user)).toMatch(/<button type="button" class="avatar" data-account-toggle aria-haspopup="true" aria-expanded="false" aria-label="Account">AN<\/button>/)
  })
  it('no brand, no logo, no GitHub: the app bar keeps the menu button, search and account', () => {
    vi.stubEnv('GITHUB_LINK', 'off')
    vi.stubEnv('UI_TITLE', 'none')
    vi.stubEnv('UI_LOGO', 'none')
    const html = page(user)
    expect(html).toContain('data-rail-toggle')
    expect(html).toContain('class="app-search"')
    expect(html).toContain('data-account-toggle')
    expect(html).not.toContain('repo-badge')
  })
  describe('Let your agent deploy (the same window in both views)', () => {
    const dlg = /<dialog data-export-dialog>[\s\S]*?<\/dialog>/.exec(SANDBOX_VIEW_BODY)?.[0] ?? ''
    // Not simple-only: Advanced shows the same two ways
    const claude = /<section class="agent-way" data-way="claude">[\s\S]*?<\/section>/.exec(dlg)?.[0] ?? ''
    const other = /<section class="agent-way" data-way="other">[\s\S]*?<\/section>/.exec(dlg)?.[0] ?? ''
    const options = /<details class="adv export-options">[\s\S]*?<\/details>/.exec(dlg)?.[0] ?? ''

    it('one title for both views', () => {
      expect(dlg).toContain('<h2>Let your agent deploy</h2>')
      expect(dlg).not.toContain('Export for coding agents</h2>')
    })
    it('Advanced only: Options with the token name, expiry, no Docker keys and Copy as .env', () => {
      expect(options).toContain('<label>Token name<input name="name"')
      expect(options).toContain('<label>Expires<select name="expires_in"')
      expect(options).toMatch(/<input type="checkbox" name="no_docker"/)
      expect(options).toMatch(/<button type="button"[^>]*data-copy-env[^>]*>Copy as \.env<\/button>/)
    })
    it('Claude Code: install the plugin once, then the init line to copy', () => {
      expect(claude).toContain('claude plugin install p9m@p9m')
      expect(claude).not.toContain('--config')
      expect(claude).not.toContain('data-plugin-token')
      expect(claude).toMatch(/data-init-cmd/)
      expect(claude).toMatch(/<button type="button"[^>]*data-copy-from="\[data-init-cmd\]"[^>]*>Copy<\/button>/)
      expect(claude).toContain('approve in the browser page it opens')
    })
    it('Claude Code, in Claude Code instead: the /plugin commands', () => {
      const other = /<details[^>]*>[\s\S]*?<\/details>/.exec(claude)?.[0] ?? ''
      expect(other).toContain('<code>/plugin marketplace add p9m-team/p9m</code>')
      expect(other).toContain('<code>/plugin install p9m@p9m</code>')
    })
    it('the zip keeps its Download button', () => {
      expect(dlg).toMatch(/<button class="primary" value="download" data-export-download>Download<\/button>/)
    })
    it('other agents: the zip, unpacked by the agent', () => {
      expect(other).toContain('set up the p9m zip from my Downloads in this project and deploy')
    })
  })
})

describe('sleep settings fields', () => {
  // Both the New sandbox form and the Sleep settings dialog
  const patterns = [...SANDBOX_VIEW_BODY.matchAll(/<input name="idle_timeout"[^>]*pattern="([^"]+)"/g)].map(m => new RegExp(`^(?:${m[1]})$`))
  it('Sleep after no traffic takes days too', () => {
    expect(patterns.length).toBe(2)
    for (const p of patterns) {
      for (const ok of ['30m', '2h', '1d', '0', 'off']) expect(p.test(ok), ok).toBe(true)
      for (const bad of ['0m', '1.5d', '1w']) expect(p.test(bad), bad).toBe(false)
    }
  })
})

describe('the sandbox page', () => {
  it('details open in a closable drawer, hidden until a sandbox is chosen', () => {
    expect(SANDBOX_VIEW_BODY).toMatch(/<aside class="drawer" data-drawer hidden/)
    expect(SANDBOX_VIEW_BODY).toMatch(/<button type="button" class="drawer-close" data-drawer-close aria-label="Close details">/)
    expect(SANDBOX_VIEW_BODY).toContain('<div class="panel" data-panel>')
    expect(SANDBOX_VIEW_BODY).not.toContain('Select a sandbox')
  })
  it('the free-text filter is the app bar search, the status filter stays in the toolbar', () => {
    vi.stubEnv('USER_PREFS_FILE', path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-')), 'user-prefs.json'))
    expect(SANDBOX_VIEW_BODY).not.toContain('data-filter-text')
    expect(SANDBOX_VIEW_BODY).toMatch(/<div class="list-toolbar">[\s\S]*data-filter-status/)
    const html = renderPage({ title: 'x', view: 'mine', session: user, body: SANDBOX_VIEW_BODY })
    expect(html.match(/data-filter-text/g)).toHaveLength(1)
    vi.unstubAllEnvs()
  })
})
