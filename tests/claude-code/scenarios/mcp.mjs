// A user asks Claude Code for an MCP server and puts it online; the test speaks MCP to it.

/** One JSON-RPC message to a Streamable HTTP MCP endpoint; the answer from JSON or an event stream */
async function rpc(url, msg, session) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) },
    body: JSON.stringify(msg),
  })
  const text = await r.text()
  let body = null
  if ((r.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean)
    for (const d of data) { try { const m = JSON.parse(d); if (m.id === msg.id) body = m } catch { /* not JSON */ } }
  } else if (text.trim()) { try { body = JSON.parse(text) } catch { /* not JSON */ } }
  return { status: r.status, body, session: r.headers.get('mcp-session-id') ?? session, text }
}

export default {
  name: 'mcp',
  title: 'An MCP server, online',
  files: () => ({ 'README.md': '# Word tools\n\nNothing here yet.\n' }),
  async run(h) {
    await h.init()
    await h.step('"build an MCP server and put it online"', () => h.claude(
      'Build a small MCP server in this folder, with the Streamable HTTP transport at the path /mcp (stateless is ' +
      'fine), and one tool, count_words(text), that returns how many words the text has. Then put it online in my ' +
      'Purgatorium sandbox, so that anyone with the link can reach it.'))
    const endpoint = await h.step('it speaks MCP at its address (initialize)', async () => {
      for (const u of await h.apps()) {
        const r = await rpc(`${u}/mcp`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'p9m-test', version: '1.0' } } }).catch(() => null)
        if (r?.body?.result?.serverInfo) {
          h.note(`initialize ${u}/mcp → ${r.body.result.serverInfo.name} (protocol ${r.body.result.protocolVersion})`)
          await rpc(`${u}/mcp`, { jsonrpc: '2.0', method: 'notifications/initialized' }, r.session).catch(() => null)
          return { url: `${u}/mcp`, session: r.session }
        }
      }
      h.fail('no app answers an MCP initialize at /mcp')
    })
    await h.step('tools/list has count_words', async () => {
      const r = await rpc(endpoint.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, endpoint.session)
      const names = (r.body?.result?.tools ?? []).map(t => t.name)
      if (!names.includes('count_words')) h.fail(`tools/list: ${names.join(', ') || r.text.slice(0, 200)}`)
      h.note(`tools/list → ${names.join(', ')}`)
    })
    await h.step('tools/call count_words counts', async () => {
      const text = 'the quick brown fox jumps'
      const r = await rpc(endpoint.url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'count_words', arguments: { text } } }, endpoint.session)
      const res = r.body?.result
      const said = JSON.stringify(res?.structuredContent ?? '') + (res?.content ?? []).map(c => c.text ?? '').join(' ')
      if (res?.isError || !/\b5\b/.test(said)) h.fail(`tools/call: ${JSON.stringify(r.body ?? r.text).slice(0, 300)}`)
      h.note(`tools/call count_words("${text}") → ${said.trim().slice(0, 80)}`)
    })
  },
}
