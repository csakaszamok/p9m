// The device-approval flow behind /p9m:init: the agent asks for a code, the user approves it in the browser and gets a
// confirmation code, which they paste back into Claude Code. Whoever sends someone else a link gets nothing from it:
// the token only comes with the confirmation code, shown in the approver's browser.
// In memory and single-use like the project link: a restart just means asking again.
import crypto from 'node:crypto'

/** How long a device code works, from when it was made, and again from its approval */
export const DEVICE_TTL_MS = 10 * 60_000
/** Most unexpired codes at once, so nobody can fill the memory (an entry is a few hundred bytes) */
export const DEVICE_MAX_PENDING = 10_000
/**
 * Most pending codes of one client address: a new one beyond it pushes out that address's oldest pending code, never
 * refused. /device/code needs no sign-in, and refusing at a cap let a loop of requests stop /p9m:init for everyone;
 * now a loop only pushes out its own address's codes (a room behind one NAT shares that fate).
 */
export const DEVICE_MAX_PER_ADDRESS = 500
/** Wrong confirmation codes before the request is gone */
export const DEVICE_MAX_TRIES = 5

// No vowels and no look-alikes: a code read out loud or typed from a screen stays unambiguous
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'

type Status = 'pending' | 'working' | 'approved' | 'denied'
/** sandbox: one of the user's to tie to; null: a new one, from template (null: the default) */
export interface DeviceRequest { sandbox: string | null; template: string | null; ip: string | null }
interface Entry extends DeviceRequest { userCode: string; status: Status; expires: number; tries: number; confirm?: string; grant?: { sandbox: string; owner: string } }

const devices = new Map<string, Entry>()
const userCodes = new Map<string, string>()
/** The device codes of each client address, oldest first */
const byAddress = new Map<string | null, Set<string>>()

function drop(deviceCode: string, e: Entry) {
  devices.delete(deviceCode)
  userCodes.delete(e.userCode)
  const mine = byAddress.get(e.ip)
  mine?.delete(deviceCode)
  if (mine && !mine.size) byAddress.delete(e.ip)
}

function purge(now: number) {
  for (const [d, e] of devices) if (e.expires <= now) drop(d, e)
}

/** Upper case, without spaces and dashes, so `bcdf-ghjk` finds BCDF-GHJK */
export function normalizeUserCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '')
}

function newCode(): string {
  let c = ''
  for (let i = 0; i < 8; i++) c += USER_CODE_ALPHABET[crypto.randomInt(USER_CODE_ALPHABET.length)]
  return c
}

const pretty = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`

/** The live entry behind a user code; null when unknown or expired */
function byUserCode(userCode: string, now: number): [string, Entry] | null {
  const d = userCodes.get(normalizeUserCode(userCode))
  const e = d && devices.get(d)
  if (!d || !e) return null
  if (e.expires <= now) { drop(d, e); return null }
  return [d, e]
}

/** A new device code for the agent and the user code to show; throws at the cap */
export function startDevice(req: Partial<DeviceRequest> = {}, now = Date.now()): { device_code: string; user_code: string } {
  purge(now)
  const ip = req.ip ?? null
  const mine = byAddress.get(ip)
  if (mine && mine.size >= DEVICE_MAX_PER_ADDRESS) {
    // Oldest first (a Set keeps insertion order); one being approved or approved is someone's sign-in under way
    for (const d of mine) { const e = devices.get(d); if (e?.status === 'pending') { drop(d, e); break } }
  }
  if (devices.size >= DEVICE_MAX_PENDING) throw new Error('too many pending')
  let code = newCode()
  while (userCodes.has(code)) code = newCode()
  const device_code = crypto.randomBytes(32).toString('base64url')
  devices.set(device_code, { sandbox: req.sandbox ?? null, template: req.template ?? null, ip, userCode: code, status: 'pending', expires: now + DEVICE_TTL_MS, tries: 0 })
  userCodes.set(code, device_code)
  byAddress.set(ip, (byAddress.get(ip) ?? new Set()).add(device_code))
  return { device_code, user_code: pretty(code) }
}

/** What the approval page shows for a user code; null when unknown or expired */
export function deviceByUserCode(userCode: string, now = Date.now()): DeviceRequest & { status: Status } | null {
  const f = byUserCode(userCode, now)
  return f ? { sandbox: f[1].sandbox, template: f[1].template, ip: f[1].ip, status: f[1].status } : null
}

/** Takes a pending code for an approval that takes a while (a create, new Docker keys): a second click finds it busy */
export function claimDevice(userCode: string, now = Date.now()): boolean {
  const f = byUserCode(userCode, now)
  if (!f || f[1].status !== 'pending') return false
  f[1].status = 'working'
  return true
}

/** The approval failed: pending again, to try once more */
export function releaseDevice(userCode: string, now = Date.now()): void {
  const f = byUserCode(userCode, now)
  if (f && f[1].status === 'working') f[1].status = 'pending'
}

/** Approves a claimed code: the confirmation code to show the user (XXXX-XXXX); null when unknown, expired or not claimed */
export function approveDevice(userCode: string, grant: { sandbox: string; owner: string }, now = Date.now()): string | null {
  const f = byUserCode(userCode, now)
  if (!f || f[1].status !== 'working') return null
  const e = f[1]
  e.status = 'approved'
  e.grant = { sandbox: grant.sandbox, owner: grant.owner }
  e.confirm = newCode()
  // The time to paste it starts now (a create can take a while)
  e.expires = now + DEVICE_TTL_MS
  return pretty(e.confirm)
}

/** Denies a pending code; false when unknown, expired or already decided */
export function denyDevice(userCode: string, now = Date.now()): boolean {
  const f = byUserCode(userCode, now)
  if (!f || f[1].status !== 'pending') return false
  f[1].status = 'denied'
  return true
}

function sameCode(a: string, b: string): boolean {
  const x = crypto.createHash('sha256').update(a).digest()
  const y = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(x, y)
}

export type Redeemed =
  | { status: 'pending' } | { status: 'denied' } | { status: 'expired' }
  | { status: 'wrong'; tries_left: number }
  | { status: 'approved'; sandbox: string; owner: string }

/** The agent hands in the confirmation code the user pasted; approved and denied are told once, then the entry is gone */
export function redeemDevice(deviceCode: string, confirm: string, now = Date.now()): Redeemed {
  const e = devices.get(deviceCode)
  if (!e) return { status: 'expired' }
  if (e.expires <= now) { drop(deviceCode, e); return { status: 'expired' } }
  if (e.status === 'denied') { drop(deviceCode, e); return { status: 'denied' } }
  if (e.status !== 'approved' || !e.confirm || !e.grant) return { status: 'pending' }
  if (!sameCode(normalizeUserCode(confirm), e.confirm)) {
    e.tries++
    if (e.tries >= DEVICE_MAX_TRIES) { drop(deviceCode, e); return { status: 'expired' } }
    return { status: 'wrong', tries_left: DEVICE_MAX_TRIES - e.tries }
  }
  drop(deviceCode, e)
  return { status: 'approved', sandbox: e.grant.sandbox, owner: e.grant.owner }
}

/** For tests */
export function _resetDevices(): void {
  devices.clear()
  userCodes.clear()
  byAddress.clear()
}
