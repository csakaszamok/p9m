import type { Server } from 'node:http'
import { WebSocketServer } from 'ws'
import { checkTerminalUpgrade, type GateResult } from './terminalGate'
import { runTerminal } from './terminalSession'
import type { TerminalResume } from './terminalResume'

interface Deps {
  check(url: string, headers: Record<string, string | string[] | undefined>): Promise<GateResult>
  run(ws: never, name: string, container?: string, resume?: TerminalResume): Promise<void>
}

/** Browser terminals: /sandboxes/:name/terminal upgraded to a websocket (checked before the upgrade). */
export function attachTerminals(server: Server, deps: Deps = { check: checkTerminalUpgrade, run: (ws, name, container, resume) => runTerminal(ws, name, {}, container, resume) }): void {
  // Terminal input is keystrokes and resizes: a bigger message is not one of ours
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  server.on('upgrade', async (req, socket, head) => {
    // Node takes its own error listener off the socket before 'upgrade': without one, a client
    // resetting the connection would be an unhandled error that takes the whole API down
    socket.on('error', () => socket.destroy())
    const gate = await deps.check(req.url ?? '/', req.headers)
      .catch(() => ({ ok: false as const, status: 404 as const, reason: 'Not found' }))
    if (!gate.ok) {
      console.log(`[terminal] ${req.url}: refused ${gate.status} (${gate.reason}); origin=${req.headers.origin ?? '-'} host=${req.headers.host ?? '-'}`)
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${gate.status} ${gate.reason.replace(/[\r\n]/g, ' ')}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    // The slot the gate reserved: given back whenever this connection ends, upgraded or not
    socket.once('close', gate.release)
    if (socket.destroyed) { gate.release(); return }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('error', () => ws.terminate()) // a malformed frame: drop this connection, not the server
      const where = gate.container ? `${gate.name}/${gate.container}` : gate.name
      console.log(`[terminal] ${where}: opened by ${gate.sub}${gate.resume ? ` (resume ${gate.resume.resume})` : ''}`)
      ws.on('close', () => console.log(`[terminal] ${where}: closed`))
      deps.run(ws as never, gate.name, gate.container, gate.resume).catch(err => {
        console.error(`[terminal] ${where}: ${err instanceof Error ? err.message : err}`)
        try { ws.send(JSON.stringify({ type: 'error', text: err instanceof Error ? err.message : String(err) })); ws.close() } catch { /* gone */ }
      })
    })
  })
}
