import { signValue, verifyValue, getCookie, cookieName, SESSION_MAX_AGE } from '../session'
import { hubAllowed } from '../allowlist'
import { hubUrl } from './config'

/** The Hub's own sign-in: host-only to the Hub host, so Purgatorium's session never reaches it (nor the reverse). */
export const HUB_COOKIE = 'p9m_hub'
export const HUB_OIDC_COOKIE = 'p9m_hub_oidc'
export interface HubSession { sub: string; name: string | null; exp: number }

export function createHubSession(sub: string, name: string | null, now = Date.now()): string {
  return signValue({ hub: true, sub, name, exp: Math.floor(now / 1000) + SESSION_MAX_AGE })
}

export function readHubSession(value: string | undefined, now = Date.now()): HubSession | null {
  const s = verifyValue<HubSession & { hub?: boolean }>(value)
  // hub: true keeps a Purgatorium session value from being replayed here
  if (!s || s.hub !== true || typeof s.sub !== 'string' || !s.sub || typeof s.exp !== 'number') return null
  if (s.exp <= Math.floor(now / 1000)) return null
  return { sub: s.sub, name: typeof s.name === 'string' ? s.name : null, exp: s.exp }
}

export function hubCookieHeader(name: string, value: string, maxAgeSec: number): string {
  const secure = hubUrl().startsWith('https://')
  return `${cookieName(name, secure)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`
}

/** The signed-in Hub user, re-checked against the lists on every request (taken off a list: out at once). */
export function hubViewer(req: Request): HubSession | null {
  const s = readHubSession(getCookie(req, HUB_COOKIE))
  if (!s) return null
  return s.sub === 'admin' || hubAllowed(s.sub) ? s : null
}
