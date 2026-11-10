// Users have no web UI: they get and use their sandboxes from Claude Code (/p9m:init, approved in /activate).
// The admin keeps every page.
import type { Session } from '../session'
import { publicUrl } from '../session'
import { isUserHost, onAdminHost, userUrl } from '../userHost'
import { escapeHtml, html, pageSession, redirect } from './layout'
import { brandTitle, faviconTag, logoImg } from './brand'
import { aboutFoot } from './aboutFoot'

/**
 * The session of a web UI page (the admin's); a user's sign-in gets the page that points to Claude Code. With
 * USER_HOST on, each on their own address: the admin's pages on UI_HOST, the users' page on USER_HOST.
 */
export function guiSession(req: Request): Session | Response {
  const session = pageSession(req)
  if (!session) return redirect('/login')
  const url = new URL(req.url)
  if (session.role === 'admin') return isUserHost(req.headers.get('host')) ? redirect(`${publicUrl()}${url.pathname}${url.search}`) : session
  return onAdminHost(req) ? redirect(`${userUrl()}/`) : headlessPage(session.sub)
}

export function headlessPage(sub: string): Response {
  const name = brandTitle()
  const url = escapeHtml(userUrl())
  const line = (s: string) => `<div class="copy-line"><code>${s}</code></div>`
  return html(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name ? escapeHtml(name) : 'Purgatorium'}</title><link rel="stylesheet" href="/assets/style.css">
${faviconTag()}</head>
<body class="login">
<div class="heat"></div>
<div class="card headless">
  ${logoImg(56, 'logo')}
  ${name ? `<h1>${escapeHtml(name)}</h1>` : ''}
  <p class="muted">Signed in as ${escapeHtml(sub)}. Your sandboxes live in Claude Code: there is nothing more to do here.</p>
  <ol>
    <li>Once on this computer, in a terminal:
      ${line('claude plugin marketplace add p9m-team/p9m')}
      ${line('claude plugin install p9m@p9m')}</li>
    <li>In Claude Code, in your project's folder, for a new sandbox:
      ${line(`/p9m:init ${url}`)}
      or for one you already have: ${line(`/p9m:init ${url} &lt;name&gt;`)}</li>
    <li>Approve in the browser page it opens, then paste the code it shows into Claude Code.</li>
  </ol>
  <form method="post" action="/logout"><button>Sign out</button></form>
</div>
${aboutFoot()}
<script src="/assets/embers.js" defer></script>
</body></html>`)
}
