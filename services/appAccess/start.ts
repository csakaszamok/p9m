import { pageSession } from '../ui/layout'
import { titleSuffix } from '../ui/brand'
import { getCookie, cookieHeader, publicUrl } from '../session'
import { accessOfHost, type HostAccess } from './hosts'
import { mayOpen, type Viewer } from './level'
import { issueTicket, signNext, readNext } from './sign'
import { LANDING } from './decide'

/**
 * /auth/app/start, on Purgatorium's own host (its session cookie is here): sign the visitor in, then hand the app's
 * host a one-time ticket, or say that this app is not open to them. Only for addresses of this Purgatorium's sandbox apps.
 */
export const NEXT_COOKIE = 'p9m_next'
const START = '/auth/app/start?'
export interface StartDeps { session: (req: Request) => Viewer | null; access: (host: string) => Promise<HostAccess | null>; env: NodeJS.ProcessEnv }
const defaults: StartDeps = { session: req => pageSession(req), access: h => accessOfHost(h), env: process.env }

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const page = (status: number, title: string, body: string) => new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}${titleSuffix()}</title><link rel="stylesheet" href="/assets/style.css"></head><body class="login"><main class="card"><h1>${esc(title)}</h1>${body}</main></body></html>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
const notAnApp = () => page(400, 'Not an app address', '<p>This link does not lead to an app here.</p>')

export async function startResponse(req: Request, deps: Partial<StartDeps> = {}): Promise<Response> {
  const d = { ...defaults, ...deps }
  const self = new URL(req.url)
  let target: URL
  try { target = new URL(self.searchParams.get('rd') ?? '') } catch { return notAnApp() }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return notAnApp()
  const a = await d.access(target.host)
  if (!a) return notAnApp()
  // Public: nothing to hand over (the app itself would receive a ticket)
  if (a.access === 'public') return new Response(null, { status: 302, headers: { location: target.toString(), 'cache-control': 'no-store' } })
  const viewer = d.session(req)
  if (!viewer) {
    const back = `${START}${self.searchParams.toString()}`
    // Like the session cookie (Secure when PUBLIC_URL is https), and signed
    return new Response(null, { status: 303, headers: { location: '/login', 'set-cookie': cookieHeader(NEXT_COOKIE, signNext(back), 600), 'cache-control': 'no-store' } })
  }
  if (!mayOpen(a.access, viewer, a.owner, d.env)) {
    const who = a.access === 'owner' ? 'only to its owner' : 'only to people who can sign in to this Purgatorium'
    return page(403, 'Not open to you', `<p>This app is open ${who}. You are signed in as <b>${esc(viewer.sub)}</b>.</p><form method="post" action="/logout"><button class="link">Sign out</button> to use another account.</form>`)
  }
  // Over Purgatorium's own scheme, never the one in rd (http would show the ticket on the way); the host without a port,
  // as /auth/app reads it
  const scheme = publicUrl().startsWith('https://') ? 'https:' : target.protocol
  const landing = new URL(`${scheme}//${target.hostname}${LANDING}`)
  landing.searchParams.set('ticket', issueTicket(target.hostname, viewer))
  landing.searchParams.set('rd', `${target.pathname}${target.search}`)
  return new Response(null, { status: 302, headers: { location: landing.toString(), 'cache-control': 'no-store' } })
}

// The /p9m:init approval page sends the visitor through sign-in too, and a sandbox's terminal (/p9m:teleport's link)
const ACTIVATE = '/activate?'
const TERMINAL = /^\/sandboxes\/[A-Za-z0-9_.-]+\/terminal(\?|$)/

/** Where to go after signing in: only back to /auth/app/start, /activate or a sandbox's terminal, from the signed cookie they set, nowhere else. */
export function nextAfterSignIn(req: Request): string | null {
  const v = readNext(getCookie(req, NEXT_COOKIE))
  // No control characters: the value becomes a Location header
  return v && (v.startsWith(START) || v.startsWith(ACTIVATE) || TERMINAL.test(v)) && !/[\u0000-\u001f\u007f]/.test(v) ? v : null
}
