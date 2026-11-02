import { pageSession } from './ui/layout'
import { getOwnedSandbox } from './access'
import { CONTAINER_NAME } from './sandboxContainers'
import { terminalResume, type TerminalResume } from './terminalResume'

export const MAX_TERMINALS_PER_USER = 5
const open = new Map<string, number>()
export function terminalOpened(sub: string): void { open.set(sub, (open.get(sub) ?? 0) + 1) }
export function terminalClosed(sub: string): void {
  const n = (open.get(sub) ?? 0) - 1
  if (n > 0) open.set(sub, n); else open.delete(sub)
}

export type GateResult = { ok: true; name: string; container?: string; resume?: TerminalResume; sub: string; release: () => void } | { ok: false; status: 401 | 403 | 404 | 429; reason: string }

/** Whether this websocket upgrade may open a shell: a browser session (no tokens), same origin, own sandbox.
 * `?container=` opens it in that container of the sandbox's own Docker instead; with `&resume=&dir=` it continues a
 * teleported conversation there (terminalResume.ts). Users and the admin alike: each only their own sandboxes. */
export async function checkTerminalUpgrade(url: string, headers: Record<string, string | string[] | undefined>): Promise<GateResult> {
  const m = /^\/sandboxes\/([^/]+)\/terminal$/.exec(url.split('?')[0])
  if (!m) return { ok: false, status: 404, reason: 'Not found' }
  const params = new URLSearchParams(url.split('?')[1] ?? '')
  const container = params.get('container') || undefined
  if (container !== undefined && !CONTAINER_NAME.test(container)) return { ok: false, status: 404, reason: 'Not found' }
  // A teleported conversation to continue (?resume=&dir=, only with a container): checked here, before any shell
  const resume = terminalResume(params)
  if (resume === 'bad') return { ok: false, status: 404, reason: 'Not found' }
  let name: string
  try { name = decodeURIComponent(m[1]) } catch { return { ok: false, status: 404, reason: 'Not found' } }
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
  const cookie = one(headers.cookie)
  // A page on another site can open a websocket with the user's cookie: only our own pages may
  let originHost = ''
  try { originHost = new URL(one(headers.origin)).host } catch { /* missing or bad */ }
  if (!originHost || originHost !== one(headers.host)) {
    return cookie.includes('p9m_session=') ? { ok: false, status: 403, reason: 'Cross-site request rejected' } : { ok: false, status: 401, reason: 'Sign in first' }
  }
  // Only the session cookie counts: a bearer token never opens a terminal. A user's too (the API takes only the
  // admin's): their own sandboxes' terminals are the one page users have, the link /p9m:teleport gives them
  const session = pageSession(new Request(`http://localhost${url}`, { headers: { cookie } }))
  if (!session) return { ok: false, status: 401, reason: 'Sign in first' }
  const p = { sub: session.sub, role: session.role, via: 'session' as const }
  try { await getOwnedSandbox(p, name) } catch { return { ok: false, status: 404, reason: `Sandbox not found: ${name}` } }
  // Check and take the slot in one step (no await between): parallel upgrades cannot all slip under the limit
  if ((open.get(p.sub) ?? 0) >= MAX_TERMINALS_PER_USER) return { ok: false, status: 429, reason: `At most ${MAX_TERMINALS_PER_USER} terminals at once` }
  terminalOpened(p.sub)
  let released = false
  const sub = p.sub
  return { ok: true, name, ...(container ? { container } : {}), ...(resume ? { resume } : {}), sub, release: () => { if (!released) { released = true; terminalClosed(sub) } } }
}
