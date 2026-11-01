import crypto from 'node:crypto'
import { uiHost } from './uiHost'
import { parseDuration } from './duration'

export type Role = 'user' | 'admin'
/** seen: when its user last did something (seconds); the session ends SESSION_IDLE_TIMEOUT after it */
export interface Session { sub: string; role: Role; exp: number; seen?: number }

export const SESSION_COOKIE = 'p9m_session'
export const SESSION_MAX_AGE = 7 * 24 * 3600
export const DEFAULT_IDLE_TIMEOUT = '30m'

/** SESSION_IDLE_TIMEOUT in seconds (default 30m): signed out after that long without doing anything; null = off. */
export function idleTimeout(env: NodeJS.ProcessEnv = process.env): number | null {
  const v = (env.SESSION_IDLE_TIMEOUT ?? '').trim().toLowerCase()
  if (v === 'off' || v === '0') return null
  const ms = parseDuration(v || DEFAULT_IDLE_TIMEOUT, 'smhd') ?? parseDuration(DEFAULT_IDLE_TIMEOUT)!
  return Math.floor(ms / 1000)
}

let generatedSecret: string | undefined

function secret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET
  if (!generatedSecret) {
    generatedSecret = crypto.randomBytes(32).toString('hex')
    console.warn('[session] SESSION_SECRET is not set; using a temporary one (everyone is signed out on restart)')
  }
  return generatedSecret
}

function mac(data: string): string {
  return crypto.createHmac('sha256', secret()).update(data).digest('base64url')
}

export function signValue(payload: object): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${data}.${mac(data)}`
}

export function verifyValue<T>(value: string | undefined): T | null {
  if (!value) return null
  const dot = value.lastIndexOf('.')
  if (dot < 1) return null
  const data = value.slice(0, dot)
  const sig = Buffer.from(value.slice(dot + 1))
  const expected = Buffer.from(mac(data))
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as T
  } catch {
    return null
  }
}

export function createSession(sub: string, role: Role, now = Date.now()): string {
  const t = Math.floor(now / 1000)
  return signValue({ sub, role, exp: t + SESSION_MAX_AGE, seen: t })
}

/** A session made before seen existed: as if last active when it was made. */
const seenOf = (s: Session) => typeof s.seen === 'number' ? s.seen : s.exp - SESSION_MAX_AGE

export function readSession(value: string | undefined, now = Date.now(), env: NodeJS.ProcessEnv = process.env): Session | null {
  const s = verifyValue<Session>(value)
  if (!s || typeof s.sub !== 'string' || !s.sub || (s.role !== 'user' && s.role !== 'admin') || typeof s.exp !== 'number') return null
  const t = Math.floor(now / 1000)
  if (s.exp <= t) return null
  const idle = idleTimeout(env)
  if (idle !== null && t - seenOf(s) >= idle) return null
  return { sub: s.sub, role: s.role, exp: s.exp, seen: seenOf(s) }
}

/** Seconds left before the session ends for doing nothing (null: no idle limit). */
export function idleLeft(s: Session, now = Date.now(), env: NodeJS.ProcessEnv = process.env): number | null {
  const idle = idleTimeout(env)
  return idle === null ? null : Math.max(0, seenOf(s) + idle - Math.floor(now / 1000))
}

/** The session cookie again, its user active now (the 7-day end stays); null for no valid session. */
export function touchedSessionCookie(value: string | undefined, now = Date.now(), env: NodeJS.ProcessEnv = process.env): string | null {
  const s = readSession(value, now, env)
  if (!s) return null
  const t = Math.floor(now / 1000)
  return cookieHeader(SESSION_COOKIE, signValue({ sub: s.sub, role: s.role, exp: s.exp, seen: t }), s.exp - t)
}

/**
 * Purgatorium's (and the Hub's) own sign-in cookies. A sandbox app is a sibling of Purgatorium's host and can set a cookie for the
 * whole parent domain: one of these planted there would sign a visitor in as someone else. Over https they are
 * __Host- (the browser takes such a cookie only from this host, with Path=/ and never a Domain); over http (local
 * dev on lvh.me) a browser does not allow the prefix, so the plain name.
 */
const HOST_ONLY = new Set(['p9m_session', 'p9m_oidc', 'p9m_next', 'p9m_hub', 'p9m_hub_oidc'])
export function cookieName(name: string, secure = publicUrl().startsWith('https://')): string {
  return secure && HOST_ONLY.has(name) ? `__Host-${name}` : name
}

export function getCookie(req: Request, name: string): string | undefined {
  name = cookieName(name)
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

export function publicUrl(): string {
  return (process.env.PUBLIC_URL ?? `http://${uiHost()}`).replace(/\/+$/, '')
}

export function cookieHeader(name: string, value: string, maxAgeSec: number): string {
  const secure = publicUrl().startsWith('https://') ? '; Secure' : ''
  return `${cookieName(name)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`
}
