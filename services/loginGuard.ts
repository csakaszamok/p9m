// Sign-in against guessing: the admin's password sign-in is off unless ADMIN_LOGIN=on (an emergency door, not the
// everyday way in), and failed sign-ins are limited per client address, with a cap on the admin's across all of them.
import { checkAdminLogin } from './principal'

/** ADMIN_LOGIN=on: the local admin (ADMIN_USER / ADMIN_PASSWORD) may sign in on the sign-in page. Off by default. */
export function adminLoginEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['on', 'true', '1', 'yes'].includes((env.ADMIN_LOGIN ?? '').trim().toLowerCase())
    && !!env.ADMIN_USER && !!env.ADMIN_PASSWORD
}

/** Failed sign-ins from one address before it has to wait */
export const FREE_FAILURES = 5
/** Failures further apart than this start the count again */
export const FAILURE_WINDOW_MS = 15 * 60_000
/** The first wait; it doubles with each further failure, up to MAX_WAIT_MS */
export const FIRST_WAIT_MS = 60_000
export const MAX_WAIT_MS = 60 * 60_000
/** Failed admin sign-ins from all addresses together in an hour: above it, the admin's sign-in waits for everyone */
export const ADMIN_FAILURES_PER_HOUR = 30
const HOUR = 60 * 60_000

interface Strikes { n: number; last: number; until: number }

export class LoginLimiter {
  private byAddress = new Map<string, Strikes>()
  private adminFailures: number[] = []
  constructor(private now: () => number = Date.now) {}

  /** Milliseconds this address still has to wait (0: it may try). */
  waitFor(address: string): number {
    const s = this.byAddress.get(address)
    return s ? Math.max(0, s.until - this.now()) : 0
  }

  /** Milliseconds until the admin's password sign-in may be tried again by anyone (0: now). */
  adminWait(): number {
    const now = this.now()
    this.adminFailures = this.adminFailures.filter(t => now - t < HOUR)
    return this.adminFailures.length >= ADMIN_FAILURES_PER_HOUR ? this.adminFailures[0] + HOUR - now : 0
  }

  /** A failed sign-in: from the FREE_FAILURES-th on, the address waits 1 min, then 2, 4… up to an hour. */
  failed(address: string, admin = false): void {
    const now = this.now()
    if (admin) this.adminFailures.push(now)
    const s = this.byAddress.get(address)
    const n = s && now - s.last <= Math.max(FAILURE_WINDOW_MS, s.until - s.last) ? s.n + 1 : 1
    const until = n >= FREE_FAILURES ? now + Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** (n - FREE_FAILURES)) : 0
    this.byAddress.set(address, { n, last: now, until })
    this.prune(now)
  }

  /** A sign-in that worked: the address starts again from nothing. */
  succeeded(address: string): void { this.byAddress.delete(address) }

  /** Forget every failure (tests). */
  reset(): void { this.byAddress.clear(); this.adminFailures = [] }

  // Many addresses (a spread-out attack) must not grow the map without end
  private prune(now: number): void {
    if (this.byAddress.size < 10_000) return
    for (const [a, s] of this.byAddress) if (now - s.last > FAILURE_WINDOW_MS && s.until <= now) this.byAddress.delete(a)
  }
}

export const loginLimiter = new LoginLimiter()

/** The header server.ts puts the client's address in (a client sending its own is overwritten). */
export const CLIENT_IP_HEADER = 'x-p9m-client-ip'

const PRIVATE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i

/**
 * The client's address: the connection's own, or, when that is a private one (Traefik on the Docker network),
 * the last X-Forwarded-For entry, the one Traefik added. A client on the published API port cannot pick its own.
 */
export function clientAddress(remote: string | undefined, forwardedFor: string | undefined): string {
  const own = (remote ?? '').replace(/^::ffff:/, '')
  if (!PRIVATE.test(own) || !forwardedFor) return own || 'unknown'
  const last = forwardedFor.split(',').map(s => s.trim()).filter(Boolean).pop()
  return last ? last.replace(/^::ffff:/, '') : own
}

/**
 * The admin's password sign-in (the portal's and the Hub's): null when it worked, else what to tell the browser.
 * Off, or waiting: the password is not even looked at.
 */
export async function adminSignIn(address: string, user: string, password: string, check = checkAdminLogin, limiter = loginLimiter): Promise<string | null> {
  if (!adminLoginEnabled()) {
    console.log(`[login] ${address}: admin sign-in refused (ADMIN_LOGIN is off)`)
    return 'Administrator sign-in is turned off'
  }
  const wait = Math.max(limiter.waitFor(address), limiter.adminWait())
  if (wait > 0) {
    console.log(`[login] ${address}: refused, too many failed sign-ins (${Math.ceil(wait / 1000)} s to wait)`)
    return `Too many failed sign-ins: try again in ${waitText(wait)}`
  }
  if (!(await check(user, password))) {
    limiter.failed(address, true)
    console.log(`[login] ${address}: failed admin sign-in`)
    return 'Invalid username or password'
  }
  limiter.succeeded(address)
  console.log(`[login] ${address}: admin signed in`)
  return null
}

/**
 * An OIDC callback that did not sign anyone in: logged, never counted against its address. A callback cannot be
 * guessed (the provider's code, bound to the browser's flow cookie), and a whole room behind one company address
 * would lock itself out with a few wrong accounts or cancelled sign-ins.
 */
export function oidcSignInFailed(address: string, err: unknown): void {
  console.log(`[login] ${address}: failed sign-in with OIDC: ${err instanceof Error ? err.message : err}`)
}

/** "3 minutes" / "1 hour", for a message. */
export function waitText(ms: number): string {
  const min = Math.ceil(ms / 60_000)
  return min >= 60 ? `${Math.ceil(min / 60)} hour${min > 60 ? 's' : ''}` : `${min} minute${min === 1 ? '' : 's'}`
}
