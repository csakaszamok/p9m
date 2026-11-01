import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { handleHub } from '../../../services/hub/router'
import { createHubSession } from '../../../services/hub/session'
import { createFeedKey } from '../../../services/hub/feedKey'
import type { HubEntry } from '../../../services/hub/list'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubrouter-'))
beforeEach(() => {
  Object.assign(process.env, {
    HUB_ENABLED: 'true', HOST_DOMAIN: 'example.com', PUBLIC_URL: 'https://p9m.example.com', SESSION_SECRET: 's',
    OIDC_ALLOWED_EMAILS: 'anna@example.com', HUB_ALLOWED_DOMAINS: 'example.com',
    HUB_VOTES_FILE: path.join(dir, 'votes.json'), HUB_FEED_KEY_FILE: path.join(dir, 'key'), HUB_NAMES_FILE: path.join(dir, 'names.json'),
  })
  fs.rmSync(path.join(dir, 'votes.json'), { force: true })
})

const app: HubEntry = { id: 'shop-web.example.com', url: 'https://shop-web.example.com', title: 'Shop', description: '', service: 'web', port: 80, image: null, access: 'public', owner: 'anna@example.com', owner_name: 'Anna', sandbox: 'p9m-shop', status: 'running', updated_at: '2026-10-20T10:00:00.000Z', last_ran_at: null, last_ran_estimated: false }
const deps = { entries: async () => [app] }
const as = (sub: string) => ({ cookie: `__Host-p9m_hub=${createHubSession(sub, null)}` })
const get = (p: string, headers: Record<string, string> = {}) => handleHub(new Request(`https://hub.example.com${p}`, { headers }), deps)
const send = (method: string, p: string, headers: Record<string, string>) =>
  handleHub(new Request(`https://hub.example.com${p}`, { method, headers: { origin: 'https://hub.example.com', host: 'hub.example.com', ...headers } }), deps)

describe('handleHub', () => {
  it('is 404 everywhere when the Hub is off', async () => {
    process.env.HUB_ENABLED = 'false'
    expect((await get('/', as('peter@example.com'))).status).toBe(404)
  })
  it('sends a visitor to sign in, and serves the page to a viewer', async () => {
    expect((await get('/')).headers.get('location')).toBe('/login')
    const page = await get('/', as('peter@example.com'))
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('/assets/hub.js')
  })
  it('lists apps with votes, whether you voted, and whether it is yours', async () => {
    const r = await (await get('/api/hub', as('peter@example.com'))).json()
    expect(r.apps[0]).toMatchObject({ id: 'shop-web.example.com', votes: 0, voted: false, mine: false })
    expect(r.apps[0]).not.toHaveProperty('sandbox')
    expect((await get('/api/hub')).status).toBe(401)
  })
  it('votes once, takes it back; also for your own app; not for an app that is not on the Hub, not cross-site', async () => {
    expect((await send('PUT', '/api/hub/apps/shop-web.example.com/vote', as('peter@example.com'))).status).toBe(200)
    expect((await (await get('/api/hub', as('eva@example.com'))).json()).apps[0].votes).toBe(1)
    expect((await send('DELETE', '/api/hub/apps/shop-web.example.com/vote', as('peter@example.com'))).status).toBe(200)
    // As a GitHub star: the owner may vote for their own app too
    expect((await send('PUT', '/api/hub/apps/shop-web.example.com/vote', as('anna@example.com'))).status).toBe(200)
    expect((await (await get('/api/hub', as('anna@example.com'))).json()).apps[0]).toMatchObject({ votes: 1, voted: true, mine: true })
    expect((await send('PUT', '/api/hub/apps/nope.example.com/vote', as('peter@example.com'))).status).toBe(404)
    expect((await send('PUT', '/api/hub/apps/shop-web.example.com/vote', { ...as('peter@example.com'), origin: 'https://evil.example' })).status).toBe(403)
  })
  it('serves the feed with the key only', async () => {
    const key = createFeedKey()
    expect((await get(`/feed.xml?key=${key}`)).status).toBe(200)
    expect((await get(`/feed.json?key=${key}`)).headers.get('content-type')).toContain('application/feed+json')
    expect((await get('/feed.xml?key=wrong')).status).toBe(404)
    expect((await get('/feed.xml')).status).toBe(404)
  })
  it('does not expose Purgatorium on the Hub host', async () => {
    for (const p of ['/sandboxes', '/mcp', '/swagger', '/swagger.json', '/me', '/overview']) {
      expect((await get(p, as('anna@example.com'))).status).toBe(404)
    }
  })
  it('signs the admin in with the password', async () => {
    process.env.ADMIN_USER = 'admin'; process.env.ADMIN_PASSWORD = 'pw'; process.env.ADMIN_LOGIN = 'on'
    const r = await handleHub(new Request('https://hub.example.com/login', { method: 'POST', headers: { origin: 'https://hub.example.com', host: 'hub.example.com', 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=pw' }), deps)
    expect(r.status).toBe(303)
    expect(r.headers.get('set-cookie')).toContain("__Host-p9m_hub=")
  })
})

describe('handleHub: app access', () => {
  const dom: HubEntry = { ...app, id: 'shop-dom.example.com', url: 'https://shop-dom.example.com', title: 'Board', access: 'domain' }
  const d = { entries: async () => [app, dom] }
  const list = async (sub: string) => (await (await handleHub(new Request('https://hub.example.com/api/hub', { headers: as(sub) }), d)).json()).apps.map((a: { id: string }) => a.id)
  it('a domain app shows to viewers who can sign in to Purgatorium; Hub-only viewers see public apps only', async () => {
    expect(await list('anna@example.com')).toEqual(['shop-web.example.com', 'shop-dom.example.com'])
    expect(await list('peter@example.com')).toEqual(['shop-web.example.com'])
  })
  it('the admin sees domain apps too (the admin opens every app)', async () => {
    expect(await list('admin')).toEqual(['shop-web.example.com', 'shop-dom.example.com'])
  })
  it('a Hub-only viewer cannot vote for a domain app (404)', async () => {
    const r = await handleHub(new Request('https://hub.example.com/api/hub/apps/shop-dom.example.com/vote', { method: 'PUT', headers: { origin: 'https://hub.example.com', host: 'hub.example.com', ...as('peter@example.com') } }), d)
    expect(r.status).toBe(404)
  })
})

describe('handleHub: images', () => {
  const PNG = (() => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(320, 16); b.writeUInt32BE(180, 20); return b })()
  it('lists each app’s image address, serves it to signed-in users only, and starts a refresh in the background', async () => {
    process.env.HUB_IMAGES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hubimg-'))
    const { refreshImages } = await import('../../../services/hub/images')
    await refreshImages([{ ...app, image: '/shot.png' }], { get: async () => ({ status: 200, body: PNG }) })
    let refreshed: unknown[] | null = null
    const d = { entries: async () => [app], refresh: (list: unknown[]) => { refreshed = list } }
    const list = await (await handleHub(new Request('https://hub.example.com/api/hub', { headers: as('peter@example.com') }), d)).json()
    expect(list.apps[0].image).toMatch(/^\/api\/hub\/apps\/shop-web\.example\.com\/image\?v=[0-9a-f]{12}$/)
    expect(refreshed).toHaveLength(1)
    const img = await handleHub(new Request(`https://hub.example.com${list.apps[0].image}`, { headers: as('peter@example.com') }), d)
    expect(img.status).toBe(200)
    expect(img.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await img.arrayBuffer())).toEqual(PNG)
    expect((await handleHub(new Request(`https://hub.example.com${list.apps[0].image}`), d)).status).toBe(401)
    expect((await handleHub(new Request('https://hub.example.com/api/hub/apps/none.example.com/image', { headers: as('peter@example.com') }), d)).status).toBe(404)
  })
  it('an app without a stored image has image: null', async () => {
    process.env.HUB_IMAGES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hubimg-'))
    const list = await (await handleHub(new Request('https://hub.example.com/api/hub', { headers: as('peter@example.com') }), { entries: async () => [app], refresh: () => {} })).json()
    expect(list.apps[0].image).toBeNull()
  })
})

describe('handleHub: About', () => {
  it('serves the license notices without sign-in, and the Hub pages link to them', async () => {
    const res = await get('/about')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Based on Purgatorium (p9m)')
    expect(await (await get('/login')).text()).toContain('href="/about"')
    expect(await (await get('/', as('anna@example.com'))).text()).toContain('href="/about"')
  })
})
