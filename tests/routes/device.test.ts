import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

vi.stubEnv('PUBLIC_URL', 'https://p9m.example.com')
vi.mock('../../services/dockerAccess', () => ({ dockerHostName: vi.fn((n: string) => `${n.replace(/^p9m-/, '')}-docker.lvh.me`) }))
vi.mock('../../services/templateLoader', () => ({ listTemplates: vi.fn(() => [{ name: 'starter' }, { name: 'empty' }]) }))
const { approveDevice, claimDevice, denyDevice, deviceByUserCode, startDevice, _resetDevices, DEVICE_MAX_PENDING } = await import('../../services/deviceAuth')
const { default: code } = await import('../../routes/device/code/POST')
const { default: token } = await import('../../routes/device/token/POST')

const post = (h: (r: Request) => Promise<Response>, body?: string, headers: Record<string, string> = {}) => h(new Request('http://localhost/x', { method: 'POST', body, headers }))
const ask = (b?: unknown, headers?: Record<string, string>) => post(code, b === undefined ? undefined : JSON.stringify(b), headers)
const redeem = (d: unknown, c: unknown) => post(token, JSON.stringify({ device_code: d, code: c }))
const approve = (userCode: string) => { claimDevice(userCode); return approveDevice(userCode, { sandbox: 'p9m-shop', owner: 'alice@example.com' })! }

beforeEach(() => _resetDevices())

describe('POST /device/code', () => {
  it('codes, the activate address, the time; no-store', async () => {
    const res = await ask({ sandbox: 'shop' })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const b = await res.json()
    expect(b.verification_uri).toBe('https://p9m.example.com/activate')
    expect(b.verification_uri_complete).toBe(`https://p9m.example.com/activate?code=${b.user_code}`)
    expect(b.expires_in).toBe(600)
    expect(b).not.toHaveProperty('interval')
    expect(b.device_code).toMatch(/^[A-Za-z0-9_-]{40,}$/)
  })
  it('with USER_HOST, the activate address is the users\'', async () => {
    vi.stubEnv('USER_HOST', 'sbx.example.com')
    try { expect((await (await ask({})).json()).verification_uri).toBe('https://sbx.example.com/activate') }
    finally { vi.stubEnv('USER_HOST', 'off') }
  })

  it('no body or {}: a new sandbox; a template for it; the address it came from is kept', async () => {
    const plain = await (await ask()).json()
    expect(deviceByUserCode(plain.user_code)).toMatchObject({ sandbox: null, template: null })
    const t = await (await ask({ template: 'empty' }, { 'x-real-ip': '203.0.113.5' })).json()
    expect(deviceByUserCode(t.user_code)).toMatchObject({ sandbox: null, template: 'empty', ip: '203.0.113.5' })
    expect((await ask({})).status).toBe(200)
  })

  it('a bad sandbox, an unknown template, both, or a bad body: 400', async () => {
    expect((await ask({ sandbox: 'a'.repeat(64) })).status).toBe(400)
    expect((await ask({ sandbox: 'Shop!' })).status).toBe(400)
    expect((await ask({ sandbox: 5 })).status).toBe(400)
    const unknown = await ask({ template: 'nope' })
    expect(unknown.status).toBe(400)
    expect((await unknown.json()).error).toMatch(/unknown template/)
    expect((await ask({ template: 5 })).status).toBe(400)
    expect((await ask({ sandbox: 'shop', template: 'starter' })).status).toBe(400)
    expect((await post(code, 'nope')).status).toBe(400)
    expect((await ask([1])).status).toBe(400)
  })

  it('at the cap: 503', async () => {
    for (let i = 0; i < DEVICE_MAX_PENDING; i++) startDevice({ ip: `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}` })
    const res = await ask()
    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect((await res.json()).error).toMatch(/too many pending codes/)
  })
})

describe('POST /device/token', () => {
  it('a missing device_code or code: 400', async () => {
    expect((await post(token, JSON.stringify({ code: 'BCDF-GHJK' }))).status).toBe(400)
    expect((await redeem(5, 'BCDF-GHJK')).status).toBe(400)
    expect((await redeem('x', '')).status).toBe(400)
    expect((await redeem('x', 5)).status).toBe(400)
    expect((await post(token, 'nope')).status).toBe(400)
    expect((await post(token)).status).toBe(400)
  })

  it('pending (409), a wrong code (400), then the right one: the link once, then 410', async () => {
    const d = await (await ask({ sandbox: 'shop' })).json()
    const pending = await redeem(d.device_code, 'BCDF-GHJK')
    expect(pending.status).toBe(409)
    expect(await pending.json()).toEqual({ status: 'pending' })
    const confirm = approve(d.user_code)
    const wrong = await redeem(d.device_code, 'BBBB-BBBB')
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toEqual({ status: 'wrong', tries_left: 4 })
    const ok = await redeem(d.device_code, confirm)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toBe('no-store')
    const b = await ok.json()
    expect(b.status).toBe('approved')
    expect(b.sandbox).toBe('p9m-shop')
    expect(b.name).toBe('shop')
    expect(b.url).toMatch(/^https:\/\/p9m\.example\.com\/project-dir\/[A-Za-z0-9_-]{40,}$/)
    expect(b.command).toBe(`curl -sf "${b.url}" | tar -x -C "<project folder>"`)
    expect(b.context_commands).toHaveLength(2)
    const again = await redeem(d.device_code, confirm)
    expect(again.status).toBe(410)
    expect(await again.json()).toEqual({ status: 'expired' })
  })

  it('denied: 403; unknown code: 410', async () => {
    const d = await (await ask()).json()
    denyDevice(d.user_code)
    const denied = await redeem(d.device_code, 'BCDF-GHJK')
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ status: 'denied' })
    expect((await redeem('unknown', 'BCDF-GHJK')).status).toBe(410)
  })

  it('the old /device/poll is gone: without the confirmation code there is no token', () => {
    expect(fs.existsSync(path.join(process.cwd(), 'routes/device/poll'))).toBe(false)
  })
})
