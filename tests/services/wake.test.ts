import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sandboxMeta } from '../helpers/sandboxMeta'

vi.mock('../../services/docker', () => ({ listManagedContainers: vi.fn().mockResolvedValue([]) }))
vi.mock('../../services/compose', () => ({ composeUp: vi.fn(), composeStart: vi.fn() }))
let refusal: unknown = null
vi.mock('../../services/quota', () => ({ reserveWake: vi.fn(async () => (refusal ? { ok: false, refusal } : { ok: true, release: () => {} })) }))

vi.mock('../../services/sandboxPaths', async orig => (await import('../helpers/flatSandboxPaths')).flatSandboxPaths(orig))

let dirs: string[] = []
let certs = false
let composeText = 'traefik.http.routers.frps-x.entrypoints: web,websecure'
vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>()
  const mocked = {
    ...actual,
    existsSync: vi.fn((p: string) => p === '/opt/sandboxes/admin' || dirs.some(d => p === `/opt/sandboxes/admin/${d}/docker-compose.yml`) || (certs && (p === '/app/certs/tls.crt' || p === '/app/certs/tls.key'))),
    readdirSync: vi.fn(() => [...dirs, 'Bad..Name', 'other-thing']),
    readFileSync: vi.fn(() => composeText)
  }
  return { ...mocked, default: mocked }
})

// node:http.get / request mock: each call answers with the next queued { status, body }
const httpCalls: Array<{ hostname: string; headers: Record<string, string> }> = []
let httpAnswers: Array<{ status: number; body: string }> = []
let httpAnswered = 0 // requests whose response has ended
vi.mock('node:http', async () => {
  const { EventEmitter } = await import('node:events')
  const get = (opts: { hostname: string; headers: Record<string, string> }, cb: (res: unknown) => void) => {
    httpCalls.push(opts)
    const answer = httpAnswers.shift() ?? { status: 404, body: 'frps 404' }
    const res = Object.assign(new EventEmitter(), { statusCode: answer.status, setEncoding: () => {} })
    const req = Object.assign(new EventEmitter(), { destroy: () => {}, end: () => {} })
    setImmediate(() => { cb(res); res.emit('data', answer.body); res.emit('end'); httpAnswered++ })
    return req
  }
  // requestViaTraefik uses request(); same answers
  return { default: { get, request: get }, get, request: get }
})

// node:https.get mock (used once HTTPS is enabled)
const httpsCalls: Array<{ hostname: string; port: number; servername: string; rejectUnauthorized: boolean; headers: Record<string, string> }> = []
vi.mock('node:https', async () => {
  const { EventEmitter } = await import('node:events')
  const get = (opts: typeof httpsCalls[number], cb: (res: unknown) => void) => {
    httpsCalls.push(opts)
    const res = Object.assign(new EventEmitter(), { statusCode: 404, setEncoding: () => {} })
    const req = Object.assign(new EventEmitter(), { destroy: () => {}, end: () => {} })
    setImmediate(() => { cb(res); res.emit('data', 'frps 404'); res.emit('end') })
    return req
  }
  // requestViaTraefik uses request(); same answers
  return { default: { get, request: get }, get, request: get }
})

import { findSandboxDirByHost, wakeByHost, movedAppHost, primeSablierSession, cancelSablierPrime, sablierStopDone } from '../../services/wake'
import { composeUp, composeStart } from '../../services/compose'
import { listManagedContainers } from '../../services/docker'

describe('movedAppHost', () => {
  beforeEach(() => { dirs = ['p9m-a', 'p9m-ab'] })

  it("an app's address under HOST_DOMAIN from before APPS_DOMAIN: the same one under the apps domain", () => {
    vi.stubEnv('HOST_DOMAIN', 'p9m.dev')
    vi.stubEnv('APPS_DOMAIN', 'p9m.app')
    try {
      expect(movedAppHost('ab-web.p9m.dev')).toBe('ab-web.p9m.app')
      expect(movedAppHost('AB-Web.P9m.dev:443')).toBe('ab-web.p9m.app')
      expect(movedAppHost('zzz-web.p9m.dev')).toBeNull()   // no such sandbox
      expect(movedAppHost('ab-web.p9m.app')).toBeNull()    // already there
      expect(movedAppHost('p9m.dev')).toBeNull()
      expect(movedAppHost('ab-web.sub.p9m.dev')).toBeNull()
    } finally { vi.unstubAllEnvs() }
  })

  it('nothing moved without an APPS_DOMAIN of its own', () => {
    expect(movedAppHost('ab-web.lvh.me')).toBeNull()
  })
})

describe('findSandboxDirByHost', () => {
  beforeEach(() => { dirs = ['p9m-a', 'p9m-ab'] })

  it('matches the longest raw-name prefix, ignoring port and case', () => {
    expect(findSandboxDirByHost('ab-inner-web-port80.lvh.me')).toBe('p9m-ab')
    expect(findSandboxDirByHost('a-portainer.lvh.me')).toBe('p9m-a')
    expect(findSandboxDirByHost('AB-Inner-Web-Port80.LVH.ME:80')).toBe('p9m-ab')
  })

  it('only accepts hosts the sandbox router would match (<raw>-<x>.<HOST_DOMAIN>)', () => {
    expect(findSandboxDirByHost('a.lvh.me')).toBeNull()              // bare raw name: no sandbox router
    expect(findSandboxDirByHost('ab-web.other-domain.com')).toBeNull() // foreign domain
    expect(findSandboxDirByHost('ab-web.sub.lvh.me')).toBeNull()      // extra label
    expect(findSandboxDirByHost('ab-.lvh.me')).toBeNull()             // empty suffix after raw-
  })

  it('finds new p9m- sandboxes next to legacy p9m- ones', () => {
    dirs = ['p9m-a', 'p9m-shop']
    expect(findSandboxDirByHost('shop-portainer.lvh.me')).toBe('p9m-shop')
    expect(findSandboxDirByHost('a-portainer.lvh.me')).toBe('p9m-a')
  })

  it('with APPS_DOMAIN, the hosts under it: not those under HOST_DOMAIN', () => {
    vi.stubEnv('HOST_DOMAIN', 'p9m.dev')
    vi.stubEnv('APPS_DOMAIN', 'p9m.app')
    try {
      expect(findSandboxDirByHost('ab-web.p9m.app')).toBe('p9m-ab')
      expect(findSandboxDirByHost('ab-web.p9m.dev')).toBeNull()
    } finally { vi.unstubAllEnvs() }
  })

  it('returns null for unknown hosts and dirs without a compose file', () => {
    expect(findSandboxDirByHost('zzz-web.lvh.me')).toBeNull()
    expect(findSandboxDirByHost('')).toBeNull()
    dirs = []
    expect(findSandboxDirByHost('a-web.lvh.me')).toBeNull()
  })
})

describe('wakeByHost', () => {
  beforeEach(() => {
    vi.mocked(composeUp).mockReset()
    vi.mocked(listManagedContainers).mockResolvedValue([])
  })

  it('reports not_found for hosts without a sandbox', async () => {
    dirs = []
    expect(await wakeByHost('x-web.lvh.me')).toEqual({ result: 'not_found' })
  })

  it('starts compose up once while a wake is in progress', async () => {
    dirs = ['p9m-w1']
    vi.mocked(composeUp).mockReturnValue(new Promise(() => {}))
    expect(await wakeByHost('w1-web.lvh.me')).toEqual({ result: 'started', name: 'p9m-w1', from: 'deep_sleep' })
    // The waiting page reloads every 3 s: it keeps saying where the sandbox wakes from
    expect(await wakeByHost('w1-web.lvh.me')).toEqual({ result: 'in_progress', name: 'p9m-w1', from: 'deep_sleep' })
    expect(composeUp).toHaveBeenCalledTimes(1)
    expect(composeUp).toHaveBeenCalledWith('/opt/sandboxes/admin/p9m-w1/docker-compose.yml')
  })

  it('lets the next request retry after compose up failed', async () => {
    dirs = ['p9m-w2']
    vi.mocked(composeUp).mockRejectedValueOnce(new Error('pull failed')).mockReturnValue(new Promise(() => {}))
    expect((await wakeByHost('w2-web.lvh.me')).result).toBe('started')
    await vi.waitFor(async () => expect((await wakeByHost('w2-web.lvh.me')).result).toBe('started'))
    expect(composeUp).toHaveBeenCalledTimes(2)
  })

  it('opens a Sablier session through the sandbox router once compose up is done', { timeout: 10000 }, async () => {
    // Without a request through the Sablier middleware the woken sandbox has no
    // session and would never go back to sleep.
    dirs = ['p9m-w4']
    httpCalls.length = 0
    httpAnswers = [
      { status: 200, body: '<div data-p9m-waiting><p>rebuilding after a long sleep</p></div>' }, // Traefik has not picked up the router yet
      { status: 404, body: 'frps: no such proxy' }                    // passed Sablier (session opened), frps 404
    ]
    vi.mocked(composeUp).mockResolvedValue(undefined)
    await wakeByHost('w4-web.lvh.me')
    await vi.waitFor(() => expect(httpCalls).toHaveLength(2), { timeout: 5000 })
    await new Promise(r => setTimeout(r, 1500))
    expect(httpCalls).toHaveLength(2) // stopped once through the sandbox router
    // fetch() cannot set Host, so this must be a raw http request with an explicit Host header
    expect(httpCalls[1].hostname).toBe('traefik')
    expect(httpCalls[1].headers).toEqual({ host: 'w4-p9m-wake.lvh.me' })
  })

  it('with HTTPS on, primes the session over HTTPS (plain HTTP is redirected before Sablier sees it)', { timeout: 10000 }, async () => {
    dirs = ['p9m-w5']
    certs = true
    httpCalls.length = 0; httpsCalls.length = 0
    vi.mocked(composeUp).mockResolvedValue(undefined)
    try {
      await wakeByHost('w5-web.lvh.me')
      await vi.waitFor(() => expect(httpsCalls).toHaveLength(1), { timeout: 5000 })
      expect(httpsCalls[0]).toMatchObject({ hostname: 'traefik', port: 443, servername: 'w5-p9m-wake.lvh.me', rejectUnauthorized: false, headers: { host: 'w5-p9m-wake.lvh.me' } })
      expect(httpCalls).toHaveLength(0)
    } finally {
      certs = false
    }
  })

  it('treats a redirect as "not through the sandbox router yet" and retries', { timeout: 10000 }, async () => {
    dirs = ['p9m-w6']
    httpCalls.length = 0
    httpAnswers = [{ status: 301, body: '' }, { status: 404, body: 'frps: no such proxy' }]
    vi.mocked(composeUp).mockResolvedValue(undefined)
    await wakeByHost('w6-web.lvh.me')
    await vi.waitFor(() => expect(httpCalls).toHaveLength(2), { timeout: 5000 })
  })

  it('with HTTPS on, reports a sandbox whose router predates HTTPS instead of waking it forever', async () => {
    dirs = ['p9m-w7']
    certs = true
    composeText = 'traefik.http.routers.frps-p9m-w7.entrypoints: web'
    vi.mocked(composeUp).mockClear()
    try {
      expect(await wakeByHost('w7-web.lvh.me')).toEqual({ result: 'outdated', name: 'p9m-w7' })
      expect(composeUp).not.toHaveBeenCalled()
    } finally {
      certs = false
      composeText = 'traefik.http.routers.frps-x.entrypoints: web,websecure'
    }
  })

  it('does not start containers that already exist; right after its own wake it waits for the router', async () => {
    dirs = ['p9m-w3']
    vi.mocked(composeUp).mockResolvedValue(undefined)
    expect((await wakeByHost('w3-web.lvh.me')).result).toBe('started')
    await vi.waitFor(() => expect(composeUp).toHaveBeenCalled())
    vi.mocked(listManagedContainers).mockResolvedValue([sandboxMeta({ name: 'p9m-w3', template: 't', status: 'running', container_id: 'x', created_at: '' })])
    // While the start is still under way it says where from; once it is done, the router grace answers
    await vi.waitFor(async () => expect(await wakeByHost('w3-web.lvh.me')).toEqual({ result: 'in_progress', name: 'p9m-w3' }), { timeout: 5000 })
    expect(composeUp).toHaveBeenCalledTimes(1)
  })

  it('reports no_route for existing containers it did not just wake: the request should have hit the sandbox router', async () => {
    // e.g. an https:// request to a sandbox whose router only listens on `web` — waking it would loop forever
    dirs = ['p9m-w8']
    vi.mocked(listManagedContainers).mockResolvedValue([sandboxMeta({ name: 'p9m-w8', template: 't', status: 'running', container_id: 'x', created_at: '' })])
    expect(await wakeByHost('w8-web.lvh.me')).toEqual({ result: 'no_route', name: 'p9m-w8' })
    expect(composeUp).not.toHaveBeenCalled()
  })
})

describe('wakeByHost: every wake through p9m', () => {
  const lim = { reason: 'running', title: 'Running limit reached', message: 'Running limit reached: 1 running sandbox allowed, running now: shop. Put one to sleep first.', limit: 1, running: ['p9m-shop'] }
  beforeEach(() => { refusal = null; vi.mocked(composeUp).mockReset(); vi.mocked(composeStart).mockReset() })

  it('an asleep sandbox (its router is gone while it is stopped): starts it, from asleep', async () => {
    dirs = ['p9m-zz']
    vi.mocked(listManagedContainers).mockResolvedValue([sandboxMeta({ name: 'p9m-zz', owner: 'u@x', template: 't', status: 'exited', container_id: 'x', created_at: '' })] as never)
    vi.mocked(composeStart).mockReturnValue(new Promise(() => {}))
    expect(await wakeByHost('zz-web.lvh.me')).toEqual({ result: 'started', name: 'p9m-zz', from: 'asleep' })
    expect(composeStart).toHaveBeenCalledWith('/opt/sandboxes/admin/p9m-zz/docker-compose.yml')
    expect(composeUp).not.toHaveBeenCalled()
  })

  it('at the limit: the refusal, nothing started', async () => {
    const { reserveWake } = await import('../../services/quota')
    dirs = ['p9m-lim']
    composeText = 'traefik.http.routers.frps-x.entrypoints: web,websecure\n      p9m.owner: "u@x"'
    vi.mocked(listManagedContainers).mockResolvedValue([])
    refusal = lim
    expect(await wakeByHost('lim-web.lvh.me')).toEqual({ result: 'limit', name: 'p9m-lim', refusal: lim })
    expect(reserveWake).toHaveBeenLastCalledWith('u@x', 'p9m-lim', 'deep_sleep')
    expect(composeUp).not.toHaveBeenCalled()
    composeText = 'traefik.http.routers.frps-x.entrypoints: web,websecure'
  })

  it('a sandbox started from the panel a moment ago: waits for its router (in_progress), not no_route', async () => {
    const { markWoken } = await import('../../services/wake')
    dirs = ['p9m-pn']
    vi.mocked(listManagedContainers).mockResolvedValue([sandboxMeta({ name: 'p9m-pn', owner: 'u@x', template: 't', status: 'running', container_id: 'x', created_at: '' })] as never)
    markWoken('p9m-pn')
    expect(await wakeByHost('pn-web.lvh.me')).toEqual({ result: 'in_progress', name: 'p9m-pn' })
  })
})

// A request to a sandbox's address while it is being created (its directory exists, its containers not yet)
// read as deep sleep and started a second compose up next to the create's
describe('a sandbox being created', () => {
  it('is not woken: its address waits (in_progress), and the TCP gateway sees a wake under way', async () => {
    const { markCreating, creatingDone, wakeInProgress } = await import('../../services/wake')
    dirs = ['p9m-cr']
    vi.mocked(listManagedContainers).mockResolvedValue([])
    vi.mocked(composeUp).mockReset(); vi.mocked(composeStart).mockReset()
    markCreating('p9m-cr')
    try {
      expect(await wakeByHost('cr-web.lvh.me')).toMatchObject({ result: 'in_progress', name: 'p9m-cr' })
      expect(wakeInProgress('p9m-cr')).toBe(true)
      expect(composeUp).not.toHaveBeenCalled()
      expect(composeStart).not.toHaveBeenCalled()
    } finally { creatingDone('p9m-cr') }
    expect(wakeInProgress('p9m-cr')).toBe(false)
  })
})

describe("p9m's own session probe never wakes a sandbox", () => {
  it('<raw>-p9m-wake.<domain> of a stopped sandbox: in progress, nothing started', async () => {
    const { reserveWake } = await import('../../services/quota')
    vi.mocked(reserveWake).mockClear()
    dirs = ['p9m-pw']
    vi.mocked(listManagedContainers).mockResolvedValue([sandboxMeta({ name: 'p9m-pw', owner: 'u@x', template: 't', status: 'exited', container_id: 'x', created_at: '' })] as never)
    vi.mocked(composeStart).mockReset(); vi.mocked(composeUp).mockReset()
    expect(await wakeByHost('pw-p9m-wake.lvh.me')).toEqual({ result: 'in_progress', name: 'p9m-pw' })
    expect(composeStart).not.toHaveBeenCalled()
    expect(reserveWake).not.toHaveBeenCalled()
  })
})

// After a start p9m opens the sandbox's Sablier session for up to 2.5 min. A request that reaches its router after the
// sandbox was stopped makes Sablier start it again: a stop must end that.
describe('primeSablierSession and a stop', () => {
  const waiting = () => Array.from({ length: 30 }, () => ({ status: 200, body: '<main data-p9m-waiting>' }))

  it('gives up once the sandbox is stopped, and sends nothing after the stop', { timeout: 10000 }, async () => {
    httpCalls.length = 0
    httpAnswers = waiting() // its router is not there yet
    const primed = primeSablierSession('p9m-st1', 30, 50)
    await vi.waitFor(() => expect(httpCalls.length).toBeGreaterThanOrEqual(2))
    await cancelSablierPrime('p9m-st1')
    const sent = httpCalls.length
    expect(await primed).toBe(false)
    await new Promise(r => setTimeout(r, 200))
    expect(httpCalls).toHaveLength(sent)
    httpAnswers = []
  })

  it('waits for the request in flight, so none reaches the router once the stop goes on', { timeout: 10000 }, async () => {
    httpCalls.length = 0
    httpAnswers = waiting()
    httpAnswered = 0
    const primed = primeSablierSession('p9m-st2', 30, 0)
    await vi.waitFor(() => expect(httpCalls.length).toBeGreaterThanOrEqual(1))
    await cancelSablierPrime('p9m-st2')
    expect(httpAnswered).toBe(httpCalls.length) // every request sent has its answer
    expect(await primed).toBe(false)
    httpAnswers = []
  })

  it('a probe that begins while the stop goes on sends nothing', { timeout: 10000 }, async () => {
    await cancelSablierPrime('p9m-st4')
    httpCalls.length = 0
    httpAnswers = [] // its router still there: a request would open a session, and Sablier would start it again
    expect(await primeSablierSession('p9m-st4', 3, 10)).toBe(false)
    expect(httpCalls).toHaveLength(0)
    sablierStopDone('p9m-st4')
  })

  it('a start after the stop opens the session again', { timeout: 10000 }, async () => {
    await cancelSablierPrime('p9m-st3')
    sablierStopDone('p9m-st3')
    httpAnswers = [] // frps answers 404: through the sandbox router
    expect(await primeSablierSession('p9m-st3', 3, 10)).toBe(true)
  })
})
