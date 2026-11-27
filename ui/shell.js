// The console shell on every signed-in page: the rail (collapsed or not, remembered per browser; a slide-in menu on
// narrow screens), the account menu, and the app bar search away from the sandbox lists. P9mShell in the browser,
// module.exports in Node for the tests (searchTarget only).
;(function (root) {
  /** Where Enter in the app bar search goes: the sandbox lists filter in place (null); elsewhere My sandboxes, ?q=. */
  function searchTarget(text, view) {
    const q = String(text || '').trim()
    if (!q || view === 'mine' || view === 'all') return null
    return `/?q=${encodeURIComponent(q)}`
  }

  const api = { searchTarget }
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return }
  root.P9mShell = api

  const doc = root.document, body = doc.body
  const narrow = () => root.matchMedia('(max-width: 800px)').matches
  const toggle = doc.querySelector('[data-rail-toggle]')
  const store = {
    get() { try { return root.localStorage.getItem('p9m.rail') } catch { return null } },
    set(v) { try { root.localStorage.setItem('p9m.rail', v) } catch { /* private window: not remembered */ } },
  }
  const syncToggle = () => toggle?.setAttribute('aria-expanded', String(narrow() ? body.classList.contains('rail-open') : !body.classList.contains('rail-collapsed')))
  if (store.get() === 'collapsed') body.classList.add('rail-collapsed')
  syncToggle()
  const closeRail = () => { body.classList.remove('rail-open'); syncToggle() }
  toggle?.addEventListener('click', () => {
    if (narrow()) body.classList.toggle('rail-open')
    else store.set(body.classList.toggle('rail-collapsed') ? 'collapsed' : 'expanded')
    syncToggle()
  })
  doc.querySelector('[data-rail-backdrop]')?.addEventListener('click', closeRail)
  doc.querySelector('[data-rail]')?.addEventListener('click', e => { if (e.target.closest('a')) closeRail() })
  root.addEventListener('resize', syncToggle)

  const accountBtn = doc.querySelector('[data-account-toggle]'), menu = doc.querySelector('[data-account-menu]')
  const setMenu = open => { if (!menu) return; menu.hidden = !open; accountBtn.setAttribute('aria-expanded', String(open)) }
  accountBtn?.addEventListener('click', e => { e.stopPropagation(); setMenu(menu.hidden) })
  doc.addEventListener('click', e => { if (menu && !menu.hidden && !e.target.closest('.account')) setMenu(false) })
  doc.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return
    // Handled here: preventDefault tells app.js (the drawer) that this Esc is used
    if (menu && !menu.hidden) { e.preventDefault(); setMenu(false); accountBtn.focus() } else if (body.classList.contains('rail-open')) { e.preventDefault(); closeRail() }
  })

  doc.querySelector('[data-filter-text]')?.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return
    const to = searchTarget(e.target.value, body.dataset.view)
    if (to) root.location.href = to
  })
})(typeof window !== 'undefined' ? window : globalThis)
