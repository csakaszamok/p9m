import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brandTitle, brandLogo, customLogoFile, githubLinkEnabled, logoImg, faviconTag, titleSuffix } from '../../services/ui/brand'
import { renderPage } from '../../services/ui/layout'

const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv
const page = () => renderPage({ title: 'x', view: 'mine', session: { sub: 'root', role: 'admin', exp: 0 }, body: '' })

describe('brand', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('defaults: Purgatorium, the built-in logo, the GitHub card', () => {
    expect(brandTitle(env({}))).toBe('Purgatorium Agentium')
    expect(brandLogo(env({}))).toBe('/assets/logo.svg')
    expect(githubLinkEnabled(env({}))).toBe(true)
    expect(titleSuffix(env({}))).toBe(' — Purgatorium Agentium')
  })
  it('UI_TITLE: an own name, or none', () => {
    expect(brandTitle(env({ UI_TITLE: 'Example <Lab>' }))).toBe('Example <Lab>')
    expect(titleSuffix(env({ UI_TITLE: 'Example <Lab>' }))).toBe(' — Example &lt;Lab&gt;')
    expect(brandTitle(env({ UI_TITLE: ' None ' }))).toBeNull()
    expect(titleSuffix(env({ UI_TITLE: 'none' }))).toBe('')
  })
  it('UI_LOGO: none, an address, or a file served as /assets/custom-logo', () => {
    expect(brandLogo(env({ UI_LOGO: 'none' }))).toBeNull()
    expect(logoImg(20, '', env({ UI_LOGO: 'none' }))).toBe('')
    expect(faviconTag(env({ UI_LOGO: 'none' }))).toBe('')
    expect(brandLogo(env({ UI_LOGO: 'https://example.com/logo.png' }))).toBe('https://example.com/logo.png')
    expect(brandLogo(env({ UI_LOGO: '/app/data/logo.png' }))).toBe('/assets/custom-logo')
    // Not square: only the height
    expect(logoImg(20, '', env({ UI_LOGO: '/app/data/logo.png' }))).toBe('<img src="/assets/custom-logo" alt="" height="20">')
  })
  it('reads the logo file; nothing for an unknown type or a missing file', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brand-')), 'logo.png')
    fs.writeFileSync(file, 'png')
    expect(customLogoFile(env({ UI_LOGO: file }))).toMatchObject({ type: 'image/png' })
    expect(customLogoFile(env({ UI_LOGO: file + '.txt' }))).toBeNull()
    expect(customLogoFile(env({ UI_LOGO: file.replace('logo', 'gone') }))).toBeNull()
    expect(customLogoFile(env({ UI_LOGO: 'https://example.com/logo.png' }))).toBeNull()
  })
  it('the app bar: GITHUB_LINK=off drops the card, none drops the name and the logo', () => {
    vi.stubEnv('USER_PREFS_FILE', path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-')), 'user-prefs.json'))
    expect(page()).toContain('class="repo-badge"')
    expect(page()).toMatch(/<span class="brand"><img src="\/assets\/logo.svg"[^>]*>Purgatorium Agentium<\/span>/)
    vi.stubEnv('GITHUB_LINK', 'off')
    vi.stubEnv('UI_TITLE', 'none')
    vi.stubEnv('UI_LOGO', 'none')
    const html = page()
    expect(html).not.toContain('repo-badge')
    expect(html).not.toContain('class="brand"')
    expect(html).not.toContain('rel="icon"')
    expect(html).toContain('<title>x</title>')
  })
})
