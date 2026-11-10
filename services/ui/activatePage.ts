// The /activate card (approving a /p9m:init code), shared by its GET and POST
import { escapeHtml, html } from './layout'
import { brandTitle, faviconTag, logoImg } from './brand'
import { rawNameOf, sandboxName } from '../naming'
import { normalizeUserCode } from '../deviceAuth'

/** The full name of what the agent sent: the short name the user sees, or already the full one */
export const fullSandboxName = (s: string) => rawNameOf(s) !== null ? s : sandboxName(s)

/** XXXX-XXXX, as the agent showed it */
export function displayCode(input: string): string {
  const c = normalizeUserCode(input)
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c
}

/** The card; body is HTML (escape what goes in it) */
export function activatePage(body: string, status = 200, heading = 'Connect Claude Code'): Response {
  const name = brandTitle()
  return html(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)}${name ? ` — ${escapeHtml(name)}` : ''}</title><link rel="stylesheet" href="/assets/style.css">
${faviconTag()}</head>
<body class="login">
<div class="heat"></div>
<div class="card">
  ${logoImg(56, 'logo')}
  <h1>${escapeHtml(heading)}</h1>
  ${body}
</div>
<script src="/assets/embers.js" defer></script>
<script src="/assets/activate.js" defer></script>
</body></html>`, status)
}

// Never 404: Traefik puts its own not-found page in place of every 404 (dynamic/errors.yml), and this text would be lost
export const expiredPage = () => activatePage('<p class="error">This code has expired or is unknown: run /p9m:init again.</p>', 410)
export const messagePage = (text: string, status = 200, cls = 'muted') => activatePage(`<p class="${cls}">${escapeHtml(text)}</p>`, status)

/** The template a new sandbox gets: the one Claude Code asked for, or the server's default */
export const newSandboxTemplate = (template: string | null) => template ?? (process.env.DEFAULT_TEMPLATE || 'starter')

/** A code that is not pending any more */
export function statusPage(status: 'working' | 'approved' | 'denied' | 'pending', code = 200): Response {
  return status === 'working'
    ? messagePage('This code is being approved in another tab: wait for that one.', code)
    : messagePage(`This code was already ${status}.`, code)
}

/** Approved: the confirmation code to paste back into Claude Code */
export const confirmPage = (confirm: string) => activatePage(`<p>Approved. Paste this code into Claude Code:</p>
  <div class="copy-line confirm-line"><p class="user-code" data-confirm>${escapeHtml(confirm)}</p><button type="button" data-copy-from="[data-confirm]">Copy</button></div>
  <p class="approve-warn">Only into your own Claude Code, and to nobody else: whoever has this code gets into the sandbox. It works once, for 10 minutes.</p>`)
