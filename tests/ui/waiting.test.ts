import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import vm from 'vm'

const source = fs.readFileSync(path.join(process.cwd(), 'ui', 'waiting.js'), 'utf8')

/**
 * ui/waiting.js on a fake page: `pages` are what fetching the address answers (true: still the waiting page),
 * `ready` what Purgatorium's /wake/ready says each time it is asked.
 */
function run(opts: { readyUrl?: string; pages: boolean[]; ready?: Array<{ ready: boolean | null; service?: string } | Error>; now?: () => number }) {
  const timers: Array<() => unknown> = []
  const reload = vi.fn()
  const status = { innerHTML: 'waking up' }
  const elapsed = { className: '', textContent: '' }
  const root = {
    getAttribute: (a: string) => a === 'data-refresh' ? '1' : a === 'data-ready' ? opts.readyUrl ?? null : null,
    querySelector: () => null, insertBefore: vi.fn(),
  }
  const page = (waiting: boolean) => ({ querySelector: (s: string) => s === '[data-p9m-waiting]' ? (waiting ? root : null) : s === '[data-status]' ? { innerHTML: 'waking up' } : null, querySelectorAll: () => [] })
  const pages = [...opts.pages], ready = [...(opts.ready ?? [])]
  const asked: string[] = []
  const fetch = vi.fn(async (url: string) => {
    if (url === opts.readyUrl) {
      asked.push(url)
      const r = ready.shift() ?? { ready: true }
      if (r instanceof Error) throw r
      return { json: async () => r }
    }
    return { text: async () => String(pages.shift() ?? false) }
  })
  const document = { querySelector: (s: string) => s === '[data-p9m-waiting]' ? root : s === '[data-status]' ? status : null, querySelectorAll: () => [], createElement: () => elapsed }
  let ticker: (() => unknown) | null = null
  const ctx = {
    document, fetch, location: { href: 'https://shop-redmine.lvh.me/', reload },
    DOMParser: class { parseFromString(text: string) { return page(text === 'true') } },
    setTimeout: (f: () => unknown) => { timers.push(f) },
    setInterval: (f: () => unknown) => { ticker = f; return 1 },
    clearInterval: () => { ticker = null },
    Date: { now: opts.now ?? (() => 0) },
  }
  vm.runInNewContext(source, ctx)
  const tick = async () => { const f = timers.shift(); if (f) await f() }
  return { tick, reload, status, asked, elapsed, root, second: () => ticker?.(), counting: () => ticker !== null }
}

describe('the waiting page (ui/waiting.js)', () => {
  it('opens the address once it is no longer the waiting page and its app answers', async () => {
    const p = run({ readyUrl: 'https://p9m.lvh.me/wake/ready?host=x', pages: [true, false], ready: [{ ready: true }] })
    await p.tick(); expect(p.reload).not.toHaveBeenCalled()
    await p.tick(); await p.tick()
    expect(p.asked.length).toBe(1)
    expect(p.reload).toHaveBeenCalled()
  })
  it('the tunnel is up but the app does not answer yet (frps would show 404): keeps waiting and says so', async () => {
    const p = run({ readyUrl: 'https://p9m.lvh.me/wake/ready?host=x', pages: [false, false], ready: [{ ready: false, service: 'redmine' }, { ready: true }] })
    await p.tick()
    expect(p.reload).not.toHaveBeenCalled()
    expect(p.status.innerHTML).toContain('starting redmine')
    await p.tick(); await p.tick()
    expect(p.reload).toHaveBeenCalled()
  })
  it('Purgatorium cannot be asked, or does not know the address: opens it as before', async () => {
    const a = run({ readyUrl: 'https://p9m.lvh.me/wake/ready?host=x', pages: [false], ready: [new Error('offline')] })
    await a.tick(); await a.tick()
    expect(a.reload).toHaveBeenCalled()
    const b = run({ readyUrl: 'https://p9m.lvh.me/wake/ready?host=x', pages: [false], ready: [{ ready: null }] })
    await b.tick(); await b.tick()
    expect(b.reload).toHaveBeenCalled()
  })
  it('counts the seconds it has waited, and stops at the time it took once the address opens', async () => {
    let t = 0
    const p = run({ pages: [true, false], now: () => t })
    expect(p.elapsed.textContent).toBe('Waiting: 0 s')
    expect(p.root.insertBefore).toHaveBeenCalledWith(p.elapsed, null)
    t = 12_400; p.second()
    expect(p.elapsed.textContent).toBe('Waiting: 12 s')
    await p.tick()
    expect(p.counting()).toBe(true)
    t = 17_000
    await p.tick()
    expect(p.counting()).toBe(false)
    expect(p.elapsed.textContent).toBe('Ready in 17 s')
  })
  it('keeps counting while the tunnel is up but the app does not answer yet', async () => {
    const p = run({ readyUrl: 'https://p9m.lvh.me/wake/ready?host=x', pages: [false], ready: [{ ready: false }] })
    await p.tick()
    expect(p.counting()).toBe(true)
  })
  it('gives up waiting for the app after 5 minutes', async () => {
    let t = 0
    const p = run({ readyUrl: 'https://p9m.lvh.me/wake/ready?host=x', pages: [false, false], ready: [{ ready: false }, { ready: false }], now: () => t })
    await p.tick(); expect(p.reload).not.toHaveBeenCalled()
    t = 5 * 60_000 + 1
    await p.tick(); await p.tick()
    expect(p.reload).toHaveBeenCalled()
  })
  it('a page without data-ready (Sablier\'s theme) opens as soon as it is not the waiting page', async () => {
    const p = run({ pages: [false] })
    await p.tick(); await p.tick()
    expect(p.asked).toEqual([])
    expect(p.reload).toHaveBeenCalled()
  })
})
