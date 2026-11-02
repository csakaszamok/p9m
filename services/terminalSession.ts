import { StringDecoder } from 'node:string_decoder'
import { getSandboxState, openShell } from './docker'
import { sandboxService } from './sandbox'
import { primeSablierSession } from './wake'
import { openContainerShell } from './sandboxContainers'
import type { TerminalResume } from './terminalResume'

export interface WsLike {
  send(data: string): void
  close(): void
  on(ev: 'message', f: (d: Buffer | string) => void): void
  on(ev: 'close', f: () => void): void
}
export interface TerminalDeps {
  state(name: string): Promise<{ status: string } | null>
  wake(name: string): Promise<void>
  openShell: typeof openShell
  openContainerShell: typeof openContainerShell
  keepAlive(name: string): Promise<void>
  keepAliveMs: number
  wakeTimeoutMs: number
  pollMs: number
}
/** Shorter than any sensible idle timeout (they go down to seconds): one cheap request through the sandbox router */
export const TERMINAL_KEEPALIVE_MS = 20_000
/** Output waiting to reach the browser above which the shell is paused */
const MAX_BUFFERED = 1024 * 1024
const defaults: TerminalDeps = {
  state: getSandboxState, wake: async n => { await sandboxService.startSandbox(n) }, openShell, openContainerShell, keepAlive: async n => { await primeSablierSession(n) },
  keepAliveMs: TERMINAL_KEEPALIVE_MS, wakeTimeoutMs: 90_000, pollMs: 1000,
}

/** One browser terminal: wake the sandbox if needed, then a shell (in the sandbox, or in one of its containers) piped as JSON messages. */
export async function runTerminal(ws: WsLike, name: string, overrides: Partial<TerminalDeps> = {}, container?: string, resume?: TerminalResume): Promise<void> {
  const d = { ...defaults, ...overrides }
  const send = (m: Record<string, unknown>) => { try { ws.send(JSON.stringify(m)) } catch { /* gone */ } }
  let closed = false
  let keepAlive: NodeJS.Timeout | undefined
  let shell: Awaited<ReturnType<typeof openShell>> | undefined
  // destroy, not end: end only closes the shell's input, the connection (and the exec) would stay open
  const stream = () => shell?.stream as unknown as (NodeJS.ReadWriteStream & { destroy?(): void; destroyed?: boolean; writableEnded?: boolean }) | undefined
  const end = () => { (shell as { kill?: () => Promise<void> } | undefined)?.kill?.().catch(() => {}); stream()?.destroy?.() }
  ws.on('close', () => { closed = true; clearInterval(keepAlive); end() })

  if ((await d.state(name))?.status !== 'running') {
    send({ type: 'status', text: 'waking…' })
    try { await d.wake(name) } catch (err) {
      if ((err as { code?: string }).code === 'LIMIT') {
        send({ type: 'error', text: `${(err as Error).message} Choose one to put to sleep with Wake in its panel.` })
        ws.close()
        return
      }
      // anything else: the wait below reports a sandbox that does not come up
    }
    const deadline = Date.now() + d.wakeTimeoutMs
    while ((await d.state(name))?.status !== 'running') {
      if (closed) return
      if (Date.now() > deadline) { send({ type: 'error', text: 'The sandbox did not wake up in time: try again' }); ws.close(); return }
      await new Promise(r => setTimeout(r, d.pollMs))
    }
  }
  if (closed) return
  shell = container ? await d.openContainerShell(name, container, 80, 24, resume) : await d.openShell(name, 80, 24)
  if (closed) { end(); return } // the tab went while the shell was opening
  const out = stream()!
  // The exec stream is a hijacked socket: it errors when the sandbox goes away under it
  out.on('error', () => {
    if (closed) return
    send({ type: 'error', text: 'The connection to the sandbox was lost' })
    ws.close()
  })
  send({ type: 'status', text: 'connected' })
  // Only HTTP traffic keeps a sandbox awake: while the terminal is open, keep its Sablier session alive
  const ping = () => { d.keepAlive(name).catch(() => {}) }
  ping() // at once: the session may be about to run out
  keepAlive = setInterval(ping, d.keepAliveMs)
  const decoder = new StringDecoder('utf8') // a character split across two chunks stays whole
  // A tab that does not keep up (or a `yes`) must not pile output up in Purgatorium's memory
  const behind = () => ((ws as { bufferedAmount?: number }).bufferedAmount ?? 0) > MAX_BUFFERED
  const resumeWhenDrained = () => {
    if (closed) return
    if (behind()) { setTimeout(resumeWhenDrained, 50); return }
    out.resume()
  }
  out.on('data', (chunk: Buffer) => {
    const text = decoder.write(chunk)
    if (text) send({ type: 'output', data: text })
    if (behind() && !out.isPaused()) { out.pause(); setTimeout(resumeWhenDrained, 50) }
  })
  out.on('end', async () => {
    clearInterval(keepAlive)
    if (closed) return
    send({ type: 'exit', code: await shell!.exitCode().catch(() => null) })
    ws.close()
  })
  ws.on('message', raw => {
    let m: { type?: string; data?: unknown; cols?: unknown; rows?: unknown }
    try { m = JSON.parse(raw.toString()) } catch { return }
    if (m.type === 'input' && typeof m.data === 'string' && !out.destroyed && !out.writableEnded) out.write(m.data)
    if (m.type === 'resize' && Number.isInteger(m.cols) && Number.isInteger(m.rows)) shell!.resize(m.cols as number, m.rows as number)
  })
}
