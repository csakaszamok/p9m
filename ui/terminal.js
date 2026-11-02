// Browser terminal: xterm.js <-> websocket (/sandboxes/<name>/terminal) <-> docker exec in the sandbox (or in one of its containers)
const name = document.body.dataset.sandbox
const container = document.body.dataset.container
// A teleported conversation to continue (the server checks both again)
const { resume, dir } = document.body.dataset
const query = new URLSearchParams()
if (container) query.set('container', container)
if (container && resume && dir) { query.set('resume', resume); query.set('dir', dir) }
const status = document.querySelector('[data-term-status]')
const again = document.querySelector('[data-term-reconnect]')
const term = new Terminal({ cursorBlink: true, fontSize: 14, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', theme: { background: '#000000' } })
const fit = new FitAddon.FitAddon()
term.loadAddon(fit)
term.open(document.querySelector('[data-term]'))
fit.fit()
let ws = null

function connect() {
  again.hidden = true
  status.textContent = 'connecting…'
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/sandboxes/${encodeURIComponent(name)}/terminal${String(query) ? `?${query}` : ''}`)
  ws.onopen = () => sendResize()
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.type === 'output') term.write(m.data)
    else if (m.type === 'status') { status.textContent = m.text; if (m.text === 'connected') { term.focus(); sendResize() } }
    else if (m.type === 'exit') term.write(`\r\n[the shell ended${m.code != null ? ` with code ${m.code}` : ''}]\r\n`)
    else if (m.type === 'error') term.write(`\r\n[${m.text}]\r\n`)
  }
  ws.onclose = () => { status.textContent = 'disconnected'; again.hidden = false }
}
function sendResize() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })) }
term.onData(data => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data })) })
addEventListener('resize', () => { fit.fit(); sendResize() })
again.addEventListener('click', connect)
connect()
