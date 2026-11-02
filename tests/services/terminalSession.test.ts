import { describe, it, expect, vi } from 'vitest'
import { PassThrough } from 'node:stream'

vi.mock('../../services/docker', () => ({ getSandboxState: vi.fn(), openShell: vi.fn() }))
vi.mock('../../services/sandbox', () => ({ sandboxService: { startSandbox: vi.fn() } }))
vi.mock('../../services/wake', () => ({ primeSablierSession: vi.fn() }))
const { runTerminal } = await import('../../services/terminalSession')
type WsLike = Parameters<typeof runTerminal>[0]

function fakeWs() {
  const sent: Array<Record<string, unknown>> = []
  const handlers: Record<string, Array<(d?: unknown) => void>> = { message: [], close: [] }
  const ws = {
    sent, closed: false,
    send: (d: string) => { sent.push(JSON.parse(d)) },
    close: () => { if (ws.closed) return; ws.closed = true; handlers.close.forEach(f => f()) },
    on: (ev: string, f: (d?: unknown) => void) => { handlers[ev].push(f) },
    emit: (ev: string, d?: unknown) => handlers[ev].forEach(f => f(d)),
  }
  return ws as typeof ws & WsLike
}

function fakeShell() {
  const out = new PassThrough()
  const written: string[] = []
  const stream = Object.assign(out, { write: (d: string) => { written.push(d); return true } })
  const resize = vi.fn(async () => {})
  return { shell: { stream: stream as never, resize, exitCode: async () => 0, kill: async () => {} }, written, resize, out }
}

describe('runTerminal', () => {
  it('keeps the sandbox awake more often than a short idle timeout (e.g. 30s)', async () => {
    const { TERMINAL_KEEPALIVE_MS } = await import('../../services/terminalSession')
    expect(TERMINAL_KEEPALIVE_MS).toBeLessThan(30_000)
  })

  it('wakes an asleep sandbox, then pipes input, output (UTF-8 split across chunks) and resizes', async () => {
    const ws = fakeWs(); const s = fakeShell()
    let running = false
    const wake = vi.fn(async () => { running = true })
    await runTerminal(ws, 'p9m-a1', { state: async () => ({ status: running ? 'running' : 'exited' }), wake, openShell: async () => s.shell, keepAlive: async () => {}, keepAliveMs: 60_000, wakeTimeoutMs: 2000, pollMs: 10 })
    expect(wake).toHaveBeenCalledWith('p9m-a1')
    expect(ws.sent.slice(0, 2)).toEqual([{ type: 'status', text: 'waking…' }, { type: 'status', text: 'connected' }])
    ws.emit('message', JSON.stringify({ type: 'input', data: 'ls\r' }))
    expect(s.written).toContain('ls\r')
    ws.emit('message', JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
    expect(s.resize).toHaveBeenCalledWith(120, 40)
    const e = Buffer.from('é')
    s.out.push(e.subarray(0, 1)); s.out.push(e.subarray(1)) // what the shell prints (write is the input side)
    await new Promise(r => setTimeout(r, 10))
    expect(ws.sent.filter(m => m.type === 'output').map(m => m.data).join('')).toBe('é')
    ws.close()
  })

  it('opens the shell in the container asked for, not in the sandbox', async () => {
    const ws = fakeWs(); const s = fakeShell()
    const openShell = vi.fn(async () => s.shell)
    const openContainerShell = vi.fn(async () => s.shell)
    await runTerminal(ws, 'p9m-a1', { state: async () => ({ status: 'running' }), wake: async () => {}, openShell, openContainerShell, keepAlive: async () => {}, keepAliveMs: 60_000, wakeTimeoutMs: 1000, pollMs: 10 }, 'claude-dev')
    expect(openContainerShell).toHaveBeenCalledWith('p9m-a1', 'claude-dev', 80, 24, undefined)
    expect(openShell).not.toHaveBeenCalled()
    expect(ws.sent).toContainEqual({ type: 'status', text: 'connected' })
    ws.close()
  })

  it('passes a conversation to continue on to the container shell', async () => {
    const ws = fakeWs(); const s = fakeShell()
    const openContainerShell = vi.fn(async () => s.shell)
    const resume = { resume: '0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b', dir: '/home/agent/workspace/shop' }
    await runTerminal(ws, 'p9m-a1', { state: async () => ({ status: 'running' }), wake: async () => {}, openShell: vi.fn(), openContainerShell, keepAlive: async () => {}, keepAliveMs: 60_000, wakeTimeoutMs: 1000, pollMs: 10 }, 'claude', resume)
    expect(openContainerShell).toHaveBeenCalledWith('p9m-a1', 'claude', 80, 24, resume)
    ws.close()
  })

  it('stops the keep-alive when the tab closes', async () => {
    vi.useFakeTimers()
    try {
      const ws = fakeWs(); const s = fakeShell()
      const keepAlive = vi.fn(async () => {})
      await runTerminal(ws, 'p9m-a1', { state: async () => ({ status: 'running' }), wake: async () => {}, openShell: async () => s.shell, keepAlive, keepAliveMs: 1000, wakeTimeoutMs: 1000, pollMs: 10 })
      expect(keepAlive).toHaveBeenCalledTimes(1) // at once: the idle timeout may be shorter than the interval
      vi.advanceTimersByTime(2500)
      expect(keepAlive).toHaveBeenCalledTimes(3)
      ws.close()
      vi.advanceTimersByTime(5000)
      expect(keepAlive).toHaveBeenCalledTimes(3) // stopped with the tab
    } finally { vi.useRealTimers() }
  })

  it('sends exit and closes when the shell ends', async () => {
    const ws = fakeWs(); const s = fakeShell()
    await runTerminal(ws, 'p9m-a1', { state: async () => ({ status: 'running' }), wake: async () => {}, openShell: async () => s.shell, keepAlive: async () => {}, keepAliveMs: 60_000, wakeTimeoutMs: 1000, pollMs: 10 })
    s.out.end()
    s.out.resume()
    await new Promise(r => setTimeout(r, 30))
    expect(ws.sent.at(-1)).toEqual({ type: 'exit', code: 0 })
    expect(ws.closed).toBe(true)
  })

  // The exec stream is a hijacked socket: it errors when the sandbox goes away under it
  it('reports a broken shell connection and closes, instead of an unhandled error', async () => {
    const ws = fakeWs(); const s = fakeShell()
    await runTerminal(ws, 'p9m-a1', { state: async () => ({ status: 'running' }), wake: async () => {}, openShell: async () => s.shell, keepAlive: async () => {}, keepAliveMs: 60_000, wakeTimeoutMs: 1000, pollMs: 10 })
    s.out.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
    expect(ws.sent.at(-1)).toEqual({ type: 'error', text: 'The connection to the sandbox was lost' })
    expect(ws.closed).toBe(true)
  })

  // Docker does not end an exec's process when its connection goes: the shell must be told to go
  it('closing the tab ends the shell in the sandbox and destroys its connection', async () => {
    const ws = fakeWs(); const s = fakeShell()
    const kill = vi.fn(async () => {})
    await runTerminal(ws, 'p9m-a1', { state: async () => ({ status: 'running' }), wake: async () => {}, openShell: async () => ({ ...s.shell, kill }), keepAlive: async () => {}, keepAliveMs: 60_000, wakeTimeoutMs: 1000, pollMs: 10 })
    ws.close()
    expect(s.out.destroyed).toBe(true)
    expect(kill).toHaveBeenCalled()
  })

  it('a tab closed while the shell was opening leaves no shell and no keep-alive behind', async () => {
    const ws = fakeWs(); const s = fakeShell()
    const keepAlive = vi.fn(async () => {})
    let done!: () => void
    const opening = new Promise<void>(r => { done = r })
    const p = runTerminal(ws, 'p9m-a1', { state: async () => ({ status: 'running' }), wake: async () => {}, openShell: async () => { await opening; return s.shell }, keepAlive, keepAliveMs: 10, wakeTimeoutMs: 1000, pollMs: 10 })
    await new Promise(r => setTimeout(r, 5))
    ws.close()
    done(); await p
    await new Promise(r => setTimeout(r, 40))
    expect(s.out.destroyed).toBe(true)
    expect(keepAlive).not.toHaveBeenCalled()
  })

  it('pauses the shell while the browser is not keeping up, and resumes when it has', async () => {
    const ws = Object.assign(fakeWs(), { bufferedAmount: 0 })
    const s = fakeShell()
    await runTerminal(ws, 'p9m-a1', { state: async () => ({ status: 'running' }), wake: async () => {}, openShell: async () => s.shell, keepAlive: async () => {}, keepAliveMs: 60_000, wakeTimeoutMs: 1000, pollMs: 10 })
    ws.bufferedAmount = 2 * 1024 * 1024
    s.out.push(Buffer.from('lots'))
    await new Promise(r => setTimeout(r, 10))
    expect(s.out.isPaused()).toBe(true)
    ws.bufferedAmount = 0
    await new Promise(r => setTimeout(r, 150))
    expect(s.out.isPaused()).toBe(false)
    ws.close()
  })

  it('says so when the sandbox does not wake in time', async () => {
    const ws = fakeWs()
    await runTerminal(ws, 'p9m-a1', { state: async () => ({ status: 'exited' }), wake: async () => {}, openShell: vi.fn(), keepAlive: async () => {}, keepAliveMs: 60_000, wakeTimeoutMs: 50, pollMs: 10 })
    expect(ws.sent.at(-1)).toEqual({ type: 'error', text: 'The sandbox did not wake up in time: try again' })
    expect(ws.closed).toBe(true)
  })

  it('at the limit: says why and closes, without waiting', async () => {
    const ws = fakeWs()
    await runTerminal(ws, 'p9m-a1', { state: async () => ({ status: 'exited' }) as never, wake: async () => { throw Object.assign(new Error('Running limit reached: 1 running sandbox allowed, running now: shop. Put one to sleep first.'), { code: 'LIMIT' }) }, wakeTimeoutMs: 60_000, pollMs: 10 })
    expect(ws.sent).toContainEqual({ type: 'error', text: 'Running limit reached: 1 running sandbox allowed, running now: shop. Put one to sleep first. Choose one to put to sleep with Wake in its panel.' })
    expect(ws.closed).toBe(true)
  })
})

