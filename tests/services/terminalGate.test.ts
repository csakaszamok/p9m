import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSION_SECRET', 'test-secret')
vi.stubEnv('ADMIN_TOKEN', 'admin-secret')
const owners: Record<string, string> = { 'p9m-a1': 'alice@example.com', 'p9m-b1': 'bob@example.com' }
vi.mock('../../services/sandbox', () => ({
  sandboxService: {
    getSandbox: vi.fn(async (name: string) => {
      if (!owners[name]) throw new Error(`Sandbox not found: ${name}`)
      return { name, owner: owners[name] }
    }),
  },
}))
vi.mock('../../services/tokens', () => ({ resolveToken: vi.fn(() => ({ owner: 'alice@example.com', sandbox: null })) }))

const { createSession } = await import('../../services/session')
const { checkTerminalUpgrade, terminalOpened, terminalClosed, MAX_TERMINALS_PER_USER } = await import('../../services/terminalGate')
const cookie = (sub: string, role: 'user' | 'admin' = 'user') => `p9m_session=${createSession(sub, role)}`
const admin = cookie('admin', 'admin')
const h = (extra: Record<string, string>) => ({ host: 'p9m.lvh.me', origin: 'https://p9m.lvh.me', ...extra })

describe('checkTerminalUpgrade', () => {
  beforeEach(() => { for (let i = 0; i < 10; i++) terminalClosed('admin') })

  it("lets the admin in, and a user into their own sandbox only (/p9m:teleport's link); a missing one is 404", async () => {
    const r = await checkTerminalUpgrade('/sandboxes/p9m-a1/terminal', h({ cookie: admin }))
    expect(r).toMatchObject({ ok: true, name: 'p9m-a1', sub: 'admin' })
    if (r.ok) r.release()
    const own = await checkTerminalUpgrade('/sandboxes/p9m-a1/terminal?container=claude', h({ cookie: cookie('alice@example.com') }))
    expect(own).toMatchObject({ ok: true, name: 'p9m-a1', container: 'claude', sub: 'alice@example.com' })
    if (own.ok) own.release()
    expect(await checkTerminalUpgrade('/sandboxes/p9m-b1/terminal', h({ cookie: cookie('alice@example.com') }))).toMatchObject({ ok: false, status: 404 })
    expect(await checkTerminalUpgrade('/sandboxes/p9m-zz/terminal', h({ cookie: admin }))).toMatchObject({ ok: false, status: 404 })
  })

  it('refuses without a session, with a token instead of a session, and from another site', async () => {
    expect(await checkTerminalUpgrade('/sandboxes/p9m-a1/terminal', h({}))).toMatchObject({ ok: false, status: 401 })
    expect(await checkTerminalUpgrade('/sandboxes/p9m-a1/terminal', h({ authorization: 'Bearer p9m_x' }))).toMatchObject({ ok: false, status: 401 })
    expect(await checkTerminalUpgrade('/sandboxes/p9m-a1/terminal', h({ cookie: admin, origin: 'https://evil.example' }))).toMatchObject({ ok: false, status: 403 })
    expect(await checkTerminalUpgrade('/sandboxes/p9m-a1/terminal', { host: 'p9m.lvh.me', cookie: admin })).toMatchObject({ ok: false, status: 403 })
  })

  // A link someone else sends can at most open a conversation in your own container: a UUID and a teleport folder
  it('passes on a conversation to continue (resume and dir, with a container); anything else is not found', async () => {
    const id = '0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b'
    const ok = await checkTerminalUpgrade(`/sandboxes/p9m-a1/terminal?container=claude&resume=${id}&dir=/home/agent/workspace/shop`, h({ cookie: cookie('alice@example.com') }))
    expect(ok).toMatchObject({ ok: true, container: 'claude', resume: { resume: id, dir: '/home/agent/workspace/shop' } })
    if (ok.ok) ok.release()
    for (const q of [
      `resume=${id}&dir=/home/agent/workspace/shop`, // no container
      `container=claude&resume=${id}`, // half
      `container=claude&resume=x;rm%20-rf&dir=/home/agent/workspace/shop`,
      `container=claude&resume=${id}&dir=/etc`,
      `container=claude&resume=${id}&dir=/home/agent/workspace/../../etc`,
      `container=claude&resume=${id}&dir=/home/agent/workspace/a%20b`,
      `container=claude&resume=${id}&dir=/home/agent/workspace/a$(id)`,
    ]) expect(await checkTerminalUpgrade(`/sandboxes/p9m-a1/terminal?${q}`, h({ cookie: cookie('alice@example.com') })), q).toMatchObject({ ok: false, status: 404 })
  })

  it("passes on a container of the sandbox's own Docker; refuses an odd name", async () => {
    const r = await checkTerminalUpgrade('/sandboxes/p9m-a1/terminal?container=claude-dev', h({ cookie: admin }))
    expect(r).toMatchObject({ ok: true, name: 'p9m-a1', container: 'claude-dev' })
    if (r.ok) r.release()
    const plain = await checkTerminalUpgrade('/sandboxes/p9m-a1/terminal', h({ cookie: admin }))
    expect(plain.ok && 'container' in plain).toBe(false)
    if (plain.ok) plain.release()
    for (const bad of ['-x', 'a;b', 'a%20b', '..%2Fetc']) {
      expect(await checkTerminalUpgrade(`/sandboxes/p9m-a1/terminal?container=${bad}`, h({ cookie: admin }))).toMatchObject({ ok: false, status: 404 })
    }
  })

  it('takes the slot itself, so many upgrades at once still get at most 5 terminals', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => checkTerminalUpgrade('/sandboxes/p9m-a1/terminal', h({ cookie: admin }))))
    expect(results.filter(r => r.ok)).toHaveLength(MAX_TERMINALS_PER_USER)
    expect(results.filter(r => !r.ok && r.status === 429)).toHaveLength(10 - MAX_TERMINALS_PER_USER)
    for (const r of results) if (r.ok) { r.release(); r.release() } // releasing twice gives back one slot
    expect(await checkTerminalUpgrade('/sandboxes/p9m-a1/terminal', h({ cookie: admin }))).toMatchObject({ ok: true })
  })

  it('ignores other paths and allows at most 5 open terminals per user', async () => {
    expect(await checkTerminalUpgrade('/sandboxes/p9m-a1/other', h({ cookie: admin }))).toMatchObject({ ok: false, status: 404 })
    for (let i = 0; i < MAX_TERMINALS_PER_USER; i++) terminalOpened('admin')
    expect(await checkTerminalUpgrade('/sandboxes/p9m-a1/terminal', h({ cookie: admin }))).toMatchObject({ ok: false, status: 429 })
    terminalClosed('admin')
    expect(await checkTerminalUpgrade('/sandboxes/p9m-a1/terminal', h({ cookie: admin }))).toMatchObject({ ok: true })
  })
})
