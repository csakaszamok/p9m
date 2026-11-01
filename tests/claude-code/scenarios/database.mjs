// A user asks Claude Code for a web app with a PostgreSQL database; its data must outlive a sleeping sandbox.
const sleep = ms => new Promise(r => setTimeout(r, ms))

export default {
  name: 'database',
  title: 'A web app with a PostgreSQL database',
  files: () => ({ 'README.md': '# Guestbook\n\nNothing here yet.\n' }),
  async run(h) {
    await h.init()
    await h.step('"build a guestbook with a database and put it online"', () => h.claude(
      'Build a small guestbook web app in this folder, with a PostgreSQL database whose data is kept in a Docker ' +
      'volume. A page with a form (name, message) and the list of entries, newest first; and a JSON API: ' +
      'POST /api/entries with {"name": …, "message": …} adds one, GET /api/entries lists them as a JSON array. ' +
      'Then put it online in my Purgatorium sandbox, so that anyone with the link can open it.'))
    const message = `Hello from the test ${h.run}`
    const url = await h.step('an entry goes in through the API', async () => {
      const u = await h.findApp(await h.apps(), body => { try { return Array.isArray(JSON.parse(body)) } catch { return false } }, '/api/entries')
      if (!u) h.fail('no app answers GET /api/entries with a JSON array')
      const r = await fetch(`${u}/api/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Tester', message }) })
      if (r.status >= 300) h.fail(`POST /api/entries: ${r.status} ${(await r.text()).slice(0, 200)}`)
      const list = await (await fetch(`${u}/api/entries`)).text()
      if (!list.includes(message)) h.fail('the new entry is not in GET /api/entries')
      h.note(`POST ${u}/api/entries → ${r.status}; GET lists it`)
      return u
    })
    await h.screenshot(url, 'The guestbook, with the test\'s entry')
    await h.step('the entry outlives sleep and wake', async () => {
      const stop = await h.api(`/sandboxes/${h.sandbox}/stop`, { method: 'POST' })
      if (stop.status >= 300) h.fail(`stop: ${stop.status}`)
      h.note(`the sandbox ${h.sandbox} is put to sleep; a request wakes it`)
      for (let i = 0; i < 90; i++) {
        const r = await fetch(`${url}/api/entries`).catch(() => null)
        const body = r ? await r.text() : ''
        if (r?.status === 200 && !body.includes('data-p9m-waiting')) {
          if (!body.includes(message)) h.fail('awake, but the entry is gone (the data is not in a volume)')
          h.note('awake again: the entry is still there')
          return
        }
        await sleep(1000)
      }
      h.fail('not awake within 90 s')
    })
  },
}
