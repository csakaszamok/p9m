import { escapeHtml, html, pageSession, redirect } from '../../services/ui/layout'
import { oidcEnabled, providerName } from '../../services/oidc'
import { capacityHtml, loginCapacity } from '../../services/loginCapacity'
import { brandTitle, faviconTag, logoImg } from '../../services/ui/brand'
import { adminLoginEnabled } from '../../services/loginGuard'
import { isUserHost, userUrl } from '../../services/userHost'

export default async (req: Request): Promise<Response> => {
  if (pageSession(req)) return redirect('/')
  const error = new URL(req.url).searchParams.get('error')
  // Off (the default): the form is not there at all; nor on the users' address (USER_HOST), the admin's is UI_HOST
  const adminEnabled = adminLoginEnabled() && !isUserHost(req.headers.get('host'))
  const capacity = capacityHtml(await loginCapacity.get())
  const name = brandTitle()
  return html(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in${name ? ` — ${escapeHtml(name)}` : ''}</title><link rel="stylesheet" href="/assets/style.css">
${faviconTag()}</head>
<body class="login">
<div class="heat"></div>
<div class="card">
  ${logoImg(56, 'logo')}
  ${name ? `<h1>${escapeHtml(name)}</h1>` : ''}
  <p class="muted">Your own Docker sandboxes.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  ${capacity}
  ${oidcEnabled() ? `<a class="primary wide" href="/auth/oidc">Sign in with ${escapeHtml(providerName())}</a>` : ''}
  ${adminEnabled ? `<details${oidcEnabled() ? '' : ' open'}><summary>Administrator sign-in</summary>
  <form method="post" action="/login">
    <label>Username<input name="username" autocomplete="username" required></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
    <button class="primary wide">Sign in</button>
  </form></details>` : ''}
  ${oidcEnabled() ? claudeCodeHint() : ''}
  ${!oidcEnabled() && !adminEnabled ? '<p class="error">No sign-in method is on: set up OIDC, or for the admin ADMIN_LOGIN=on.</p>' : ''}
</div>
<p class="about-foot"><a href="/about">About · AGPL-3.0</a></p>
<script src="/assets/embers.js" defer></script>
</body></html>`)
}

/** For users with Claude Code, and for their agent that reads this page: the plugin, from its official marketplace, and
 *  the command that ties a project to a sandbox here (with this server's users' address) */
function claudeCodeHint(): string {
  return `<details class="agents"><summary>Using Claude Code?</summary>
  <p>Install the Purgatorium plugin once, in a terminal:</p>
  <pre class="code">claude plugin marketplace add p9m-team/p9m
claude plugin install p9m@p9m</pre>
  <p>Then in Claude Code, in your project's folder:</p>
  <pre class="code">/p9m:init ${escapeHtml(userUrl())}</pre>
  <p class="muted">It signs you in here and gets the project a sandbox.</p>
  </details>`
}
