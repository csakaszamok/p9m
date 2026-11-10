import { escapeHtml } from '../ui/layout'
import { aboutFoot } from '../ui/aboutFoot'
import type { HubSession } from './session'
import { faviconTag, logoImg } from '../ui/brand'

const head = (title: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
${faviconTag()}<link rel="stylesheet" href="/assets/hub.css"></head>`

/** The Hub: no Purgatorium navigation, no sandboxes; the list comes from /api/hub (ui/hub.js). */
export function hubPage(opts: { title: string; viewer: HubSession }): string {
  const who = escapeHtml(opts.viewer.name ?? opts.viewer.sub)
  return `${head(`${opts.title} — Hub`)}<body>
<header class="top"><a class="brand" href="/">${logoImg(22)} ${escapeHtml(opts.title)}</a>
<form method="post" action="/logout" class="who"><span>${who}</span><button class="link">Sign out</button></form></header>
<main>
<div class="tools"><input id="q" type="search" placeholder="Search apps…" aria-label="Search apps">
<div class="seg" id="sort"><button data-v="popular" class="on">Popular</button><button data-v="new">New</button></div>
<div class="seg" id="filter"><button data-v="all" class="on">All</button><button data-v="running">Running</button><button data-v="asleep">Asleep</button></div></div>
<ul id="apps" class="apps" aria-live="polite"></ul>
<div id="empty" class="empty" hidden><p>No apps here yet.</p><p>To publish one, add <code>p9m.publish: "true"</code> to its container's labels.
<a href="https://csakaszamok.github.io/p9m/latest/hub/" target="_blank" rel="noopener">How to publish</a></p></div>
</main>${aboutFoot('footer')}<script src="/assets/hub.js"></script></body></html>`
}

export function hubLoginPage(opts: { title: string; error: string | null; sso: string | null; admin?: boolean }): string {
  return `${head(`${opts.title} — Hub`)}<body class="login"><main class="box">
<h1>${logoImg(28)} ${escapeHtml(opts.title)}</h1>
${opts.error ? `<p class="error">${escapeHtml(opts.error)}</p>` : ''}
${opts.sso ? `<a class="primary wide" href="/auth/oidc">Sign in with ${escapeHtml(opts.sso)}</a>` : ''}
${opts.admin ? `<details${opts.sso ? '' : ' open'}><summary>Administrator</summary>
<form method="post" action="/login"><label>User <input name="username" autocomplete="username"></label>
<label>Password <input name="password" type="password" autocomplete="current-password"></label>
<button class="primary wide">Sign in</button></form></details>` : ''}</main>${aboutFoot('footer')}</body></html>`
}
