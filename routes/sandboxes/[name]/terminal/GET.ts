import { html, escapeHtml, htmlTag, pageSession } from '../../../../services/ui/layout'
import { guiSession } from '../../../../services/ui/headlessPage'
import { cookieHeader } from '../../../../services/session'
import { NEXT_COOKIE } from '../../../../services/appAccess/start'
import { signNext } from '../../../../services/appAccess/sign'
import { onAdminHost, userUrl } from '../../../../services/userHost'
import { terminalResume } from '../../../../services/terminalResume'
import { getOwnedSandbox } from '../../../../services/access'
import { rawNameOf } from '../../../../services/naming'
import { faviconTag, logoImg, titleSuffix } from '../../../../services/ui/brand'
import { CONTAINER_NAME } from '../../../../services/sandboxContainers'

const goTo = (location: string, cookie?: string) => new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store', ...(cookie ? { 'set-cookie': cookie } : {}) } })

/** The browser terminal page (?container=: in that container of the sandbox's own Docker; &resume=&dir=: continuing a
 *  teleported conversation there, see terminalResume.ts); the websocket on this same path is handled in server.ts
 *  (upgrade). The admin's page, and the one page users have besides /activate: their own sandboxes' terminals, the
 *  link /p9m:teleport gives them. */
export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url)
  const here = `${url.pathname}${url.search}`
  const signedIn = pageSession(req)
  // Users on their own address (USER_HOST): a link with UI_HOST goes there, signed in or not
  if (signedIn?.role !== 'admin' && onAdminHost(req)) return goTo(`${userUrl()}${here}`)
  // Not signed in: back here after sign-in, as /activate does
  if (!signedIn) return goTo('/login', cookieHeader(NEXT_COOKIE, signNext(here), 600))
  const session = signedIn.role === 'admin' ? guiSession(req) : signedIn
  if (session instanceof Response) return session
  let name: string
  try { name = decodeURIComponent(new URL(req.url).pathname.split('/')[2]) } catch { return html('<p>Sandbox not found.</p>', 404) }
  try { await getOwnedSandbox({ sub: session.sub, role: session.role, via: 'session' }, name) } catch { return html('<p>Sandbox not found.</p>', 404) }
  const container = url.searchParams.get('container') || null
  if (container !== null && !CONTAINER_NAME.test(container)) return html('<p>Container not found.</p>', 404)
  const resume = terminalResume(url.searchParams)
  if (resume === 'bad') return html('<p>Not a conversation to continue.</p>', 404)
  const short = escapeHtml(rawNameOf(name) ?? name) + (container ? ` / ${escapeHtml(container)}` : '')
  return html(`<!DOCTYPE html>
${htmlTag(session.sub)}<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${short} — terminal${titleSuffix()}</title>
${faviconTag()}
<link rel="stylesheet" href="/assets/xterm.css"><link rel="stylesheet" href="/assets/style.css">
</head><body class="terminal-page" data-sandbox="${escapeHtml(name)}"${container ? ` data-container="${escapeHtml(container)}"` : ''}${resume ? ` data-resume="${escapeHtml(resume.resume)}" data-dir="${escapeHtml(resume.dir)}"` : ''}>
<header class="topbar"><span class="brand">${logoImg(20)}${short}</span>
<span class="muted" data-term-status>connecting…</span><button class="link" data-term-reconnect hidden>Reconnect</button></header>
<div data-term></div>
<script src="/assets/xterm.js"></script><script src="/assets/addon-fit.js"></script><script src="/assets/terminal.js"></script><script src="/assets/idle.js" defer></script>
</body></html>`)
}
