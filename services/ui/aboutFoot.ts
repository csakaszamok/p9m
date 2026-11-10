import { escapeHtml } from './layout'
import { githubLinkEnabled } from './brand'
import { p9mVersion, REPO } from '../repoInfo'

/**
 * The foot line of the pages users and visitors see (sign-in, the users' page, the Hub): which version runs, linked to
 * its release notes (just the text with GITHUB_LINK=off), and the About page that AGPL-3.0 section 5(d) asks for.
 */
export function aboutFoot(tag: 'p' | 'footer' = 'p', version = p9mVersion(), link = githubLinkEnabled()): string {
  const v = version ? escapeHtml(version) : null
  const shown = !v ? '' : link
    ? `<a href="https://github.com/${REPO}/releases/tag/v${v}" target="_blank" rel="noopener" title="What is new in this version">Purgatorium v${v}</a> · `
    : `<span>Purgatorium v${v}</span> · `
  return `<${tag} class="about-foot">${shown}<a href="/about">About · AGPL-3.0</a></${tag}>`
}
