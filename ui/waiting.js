// Waiting page: instead of reloading the whole page (which would restart the ember
// animation), fetch it in the background every few seconds. While it is still a
// waiting page, update the container list in place; once it is something else
// (the app answers, or an error page), reload to show it. Without JavaScript the
// page's <noscript> meta refresh does the same, more plainly.
;(() => {
  const root = document.querySelector('[data-p9m-waiting]')
  if (!root) return
  const every = Math.max(1, Number(root.getAttribute('data-refresh')) || 3) * 1000
  const coal = document.querySelector('[data-coal]')
  // Purgatorium's /wake/ready: the sandbox's router comes up with its first tunnel, but the app asked for may not
  // answer yet (frps shows 404 meanwhile), so this is asked before opening it; for at most 5 minutes
  const readyUrl = root.getAttribute('data-ready')
  const started = Date.now()
  const until = started + 5 * 60 * 1000

  // How long this page has waited (nobody can say how long a wake will take): it shows the page is alive.
  // The poller replaces only the container list and the status, so it keeps counting
  const seconds = () => Math.floor((Date.now() - started) / 1000)
  const elapsed = document.createElement('div')
  elapsed.className = 'elapsed'
  elapsed.textContent = 'Waiting: 0 s'
  root.insertBefore(elapsed, root.querySelector('.hint'))
  const ticker = setInterval(() => { elapsed.textContent = `Waiting: ${seconds()} s` }, 1000)

  async function appStarting() {
    if (!readyUrl || Date.now() > until) return false
    try {
      const r = await (await fetch(readyUrl, { cache: 'no-store' })).json()
      if (r.ready !== false) return false
      const el = document.querySelector('[data-status]')
      if (el) el.innerHTML = `<span class="dot starting"></span>starting ${String(r.service || 'the app').replace(/[&<>"']/g, '')}…`
      return true
    } catch {
      return false // Purgatorium not reachable: open it as it is
    }
  }

  function allReady(doc) {
    const states = [...doc.querySelectorAll('[data-state]')].map(el => el.getAttribute('data-state'))
    return states.length > 0 && states.every(s => s === 'ready')
  }

  async function poll() {
    try {
      const res = await fetch(location.href, { cache: 'no-store', credentials: 'same-origin' })
      const text = await res.text()
      const doc = new DOMParser().parseFromString(text, 'text/html')
      const next = doc.querySelector('[data-p9m-waiting]')
      // The app answers: everything is ready. Let the ember become a flame for a moment, then open it
      if (!next) {
        if (await appStarting()) return void setTimeout(poll, every)
        clearInterval(ticker)
        elapsed.textContent = `Ready in ${seconds()} s`
        for (const el of document.querySelectorAll('[data-state]')) {
          el.setAttribute('data-state', 'ready'); el.className = ''; el.innerHTML = '<span class="dot ready"></span>ready'
        }
        if (coal) coal.classList.add('ready')
        setTimeout(() => location.reload(), coal ? 900 : 0)
        return
      }
      for (const sel of ['[data-states]', '[data-status]']) {
        const from = doc.querySelector(sel), to = document.querySelector(sel)
        if (from && to && from.innerHTML !== to.innerHTML) to.innerHTML = from.innerHTML
      }
      if (coal) coal.classList.toggle('ready', allReady(doc))
    } catch {
      // network blip: try again on the next round
    }
    setTimeout(poll, every)
  }

  if (coal) coal.classList.toggle('ready', allReady(document))
  setTimeout(poll, every)
})()
