import { describe, it, expect } from 'vitest'
import { aboutFoot } from '../../services/ui/aboutFoot'

describe('the foot line of the public pages', () => {
  it('names the version, linked to its release notes, and keeps the About link', () => {
    const html = aboutFoot('p', '0.20.0', true)
    expect(html).toContain('href="https://github.com/csakaszamok/p9m/releases/tag/v0.20.0"')
    expect(html).toContain('Purgatorium v0.20.0')
    expect(html).toContain('<a href="/about">About · AGPL-3.0</a>')
  })
  it('with GITHUB_LINK=off: the version as text, no link to GitHub', () => {
    const html = aboutFoot('p', '0.20.0', false)
    expect(html).toContain('<span>Purgatorium v0.20.0</span>')
    expect(html).not.toContain('github.com')
  })
  it('an unknown version: only the About link', () => {
    expect(aboutFoot('footer', null, true)).toBe('<footer class="about-foot"><a href="/about">About · AGPL-3.0</a></footer>')
  })
  it('escapes what it is given', () => {
    expect(aboutFoot('p', '1<2', true)).not.toContain('1<2')
  })
})
