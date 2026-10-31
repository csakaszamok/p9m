// Purgatorium UI: one script for the sandbox views ("mine", "all") and the tokens view.
const view = document.body.dataset.view
const isAdmin = document.body.dataset.role === 'admin'
const me = document.body.dataset.sub
// Simple or Advanced (body data-mode): Simple only hides things, the API is the same
const simpleView = () => document.body.dataset.mode === 'simple'
const $ = sel => document.querySelector(sel)
// Shared with the details panel (ui/panel.js, loaded first)
const { esc, remaining, countdown, statusLabel, statusClass, fmtBytes, meter } = window.P9mPanel

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'same-origin'
  })
  if (res.status === 401) { location.href = '/login'; throw new Error('signed out') }
  const body = await res.json().catch(() => ({}))
  // The body travels with the error: a refused wake names the running sandboxes to choose from
  if (!res.ok) { const err = new Error(body.error || `HTTP ${res.status}`); err.body = body; throw err }
  return body
}

// Sandboxes are <prefix>-<name> (p9m by default).
const prefix = document.body.dataset.prefix || 'p9m'
const shortName = n => n.startsWith(`${prefix}-`) ? n.slice(prefix.length + 1) : n
const age = iso => {
  const t = Date.parse(iso); if (isNaN(t)) return ''
  // The browser's clock can be a little behind the server's: never show a negative age
  const m = Math.max(0, Math.floor((Date.now() - t) / 60000))
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`
}

// ---------- sleep countdown ----------
// The server says how much time is left (stops_in, deep_sleep_in: seconds by its own clock). Count down
// from when that answer arrived, so a browser clock that is ahead or behind does not shift the countdown.
function onLocalClock(s) {
  const at = secs => secs == null ? null : new Date(Date.now() + secs * 1000).toISOString()
  const { stops_in, deep_sleep_in, ...rest } = s
  return {
    ...rest,
    stops_at: stops_in !== undefined ? at(stops_in) : s.stops_at,
    deep_sleep_at: deep_sleep_in !== undefined ? at(deep_sleep_in) : s.deep_sleep_at,
  }
}

// Compact variants for the table.
function sleepCell(s) {
  if (s.idle_timeout === 'off') return '<span class="muted">never</span>'
  if (s.status !== 'running') return '<span class="muted">—</span>'
  // going_to_sleep: its session has run out, Sablier stops it within a few minutes
  return s.stops_at ? countdown(s.stops_at) : s.going_to_sleep ? '<span class="muted">going to sleep…</span>' : '<span class="muted">not counting yet</span>'
}

function deepSleepCell(s) {
  if (s.deep_sleep_after === 'off') return '<span class="muted">never</span>'
  if (s.status === 'exited' && s.deep_sleep_at) return countdown(s.deep_sleep_at)
  if (s.status === 'running' && s.deep_sleep_after) return `<span class="muted">${esc(s.deep_sleep_after)} after sleep</span>`
  return '<span class="muted">—</span>'
}

// Update countdown text in place every second (no panel re-render).
setInterval(() => {
  for (const el of document.querySelectorAll('[data-until]')) el.textContent = remaining(el.dataset.until)
}, 1000)

// ---------- sandboxes ----------
let sandboxes = []
let selected = null
const pending = new Set()
let renderedName = null, renderedJSON = null

function filtered() {
  // An admin's /sandboxes response includes everyone's sandboxes; "My
  // sandboxes" must only ever show the admin's own, or they could act on
  // someone else's sandbox believing it is theirs.
  const list = view === 'mine' && isAdmin ? sandboxes.filter(s => s.owner === document.body.dataset.sub) : sandboxes
  if (view !== 'mine' && view !== 'all') return list
  const text = $('[data-filter-text]').value
  const status = $('[data-filter-status]').value
  return list.filter(s => P9mPanel.matchesFilter(s, text) && (!status || (s.status === 'created' ? 'exited' : s.status) === status))
}

function renderRows() {
  const cols = view === 'all'
    ? ['Name', 'Owner', 'Status', 'Sleeps in', 'Deep sleep in', 'CPU · Mem', 'Template', 'Created']
    : ['Name', 'Status', 'Sleeps in', 'Deep sleep in', 'CPU · Mem', 'Template', 'Created']
  // Simple view hides these (class adv, see style.css)
  const ADV_COLS = ['Deep sleep in', 'CPU · Mem', 'Template']
  $('[data-head]').innerHTML = `<tr>${cols.map(c => `<th${ADV_COLS.includes(c) ? ' class="adv"' : ''}>${c}</th>`).join('')}</tr>`
  const rows = [...filtered()]
  const filtering = !!($('[data-filter-text]')?.value.trim() || $('[data-filter-status]')?.value)
  for (const name of pending) if (!rows.some(s => s.name === name)) rows.unshift({ name, status: 'starting', runtime: '', template: '', created_at: '' })
  $('[data-rows]').innerHTML = rows.length ? rows.map(s => `
    <tr data-name="${esc(s.name)}" class="${s.name === selected ? 'selected' : ''}">
      <td><strong>${esc(shortName(s.name))}</strong></td>
      ${view === 'all' ? `<td>${esc(s.owner === 'admin' ? 'admin API' : s.owner)}</td>` : ''}
      <td>${busy.has(s.name)
        ? `<span class="status starting">${esc(ACTIONS[busy.get(s.name)].row)}</span>`
        : `<span class="status ${esc(statusClass(s))}">${esc(s.start_error ? 'failed to start' : statusLabel(s.status))}</span>`}${s.apps_stale ? (s.starting ? ` <span class="muted" title="${esc(P9mPanel.STARTING_APPS)}">⏳</span><span class="sr-only">${esc(P9mPanel.STARTING_APPS)}</span>`
          : ` <span class="warn" title="${esc(P9mPanel.STALE_APPS)}">⚠</span><span class="sr-only">${esc(P9mPanel.STALE_APPS)}</span>`) : ''}</td>
      <td>${sleepCell(s)}</td>
      <td class="adv">${deepSleepCell(s)}</td>
      <td class="adv">${usageCell(s)}</td>
      <td class="adv">${esc([s.runtime, s.template].filter(Boolean).join(' · '))}${s.compose === 'edited' ? ' <span class="muted">(edited)</span>' : ''}</td>
      <td>${esc(age(s.created_at))}</td>
    </tr>`).join('') : `<tr><td class="muted" colspan="${cols.length}">${filtering ? 'No sandbox matches the filter.' : 'No sandboxes yet — create one.'}</td></tr>`
}

async function loadQuota() {
  if (view !== 'mine') return
  try {
    const me = await api('/me')
    meInfo = me
    showResourceHint()
    const el = $('[data-quota]')
    if (me.quota === null) { el.textContent = ''; $('[data-new]').disabled = false; return }
    // Running and asleep sandboxes hold a slot; deep sleep frees it
    // The quota counts running sandboxes; asleep and deep-sleeping ones are free
    const line = P9mPanel.quotaLine(me)
    el.textContent = line.text
    el.title = line.title
    // The server limit (SANDBOX_MAX_TOTAL) can stop a user under their own quota
    if (me.server_full) { $('[data-new]').disabled = true; $('[data-new]').title = 'The server is full: ask the administrator'; return }
    // Above the guarantee the server decides whether there is room; the button stops only at the maximum (SANDBOX_QUOTA_MAX)
    const atMax = me.max_running !== null && me.sandbox_count >= me.max_running
    $('[data-new]').disabled = atMax
    $('[data-new]').title = atMax ? 'Running limit reached: put a sandbox to sleep first' : ''
  } catch (e) { if (e.message !== 'signed out') console.error(e) }
}

// ---------- overview ----------
async function loadOverview() {
  try {
    const [sum, list, users] = await Promise.all([api('/sandboxes/summary'), api('/sandboxes'), isAdmin ? api('/users').then(r => r.users).catch(() => []) : []])
    // The admin's /sandboxes is everyone's: the server view; a user's is their own
    $('[data-ov-scope]').textContent = isAdmin ? 'the whole server' : 'your sandboxes'
    $('[data-overview]').innerHTML = P9mPanel.overviewHtml(sum, list, { isAdmin, shortName }) + P9mPanel.usersTable(users)
  } catch (e) { if (e.message !== 'signed out') $('[data-overview]').innerHTML = `<p class="error">${esc(e.message)}</p>` }
}
function initOverview() {
  loadOverview()
  // Users table: forget a row (asked first; the account and its sandboxes stay)
  $('[data-overview]').addEventListener('click', async e => {
    const b = e.target.closest('[data-user-delete]'); if (!b) return
    if (!await confirmDialog(`Forget the stats of ${b.dataset.userDelete}? The account and its sandboxes stay.`, 'Delete')) return
    try { await api(`/users/${encodeURIComponent(b.dataset.userDelete)}`, { method: 'DELETE' }); loadOverview() } catch (err) { if (err.message !== 'signed out') console.error(err) }
  })
  setInterval(() => { if (!document.hidden) loadOverview() }, 10_000)
  initHubFeed()
}

// The admin's Hub feed link: a new one each time (only its hash is kept), the old one stops working
function initHubFeed() {
  const feed = document.getElementById('hub-feed')
  if (!feed || document.body.dataset.role !== 'admin') return
  feed.hidden = false
  const out = document.getElementById('hub-feed-url')
  document.getElementById('hub-feed-new').onclick = async () => {
    const res = await fetch('/hub/feed-key', { method: 'POST' })
    if (res.status === 404) { out.textContent = 'The Hub is off (HUB_ENABLED=true turns it on).'; return }
    if (!res.ok) { out.textContent = `Could not create it (${res.status})`; return }
    out.textContent = (await res.json()).url
  }
}

async function loadList() {
  try {
    sandboxes = (await api('/sandboxes')).map(onLocalClock)
    for (const s of sandboxes) pending.delete(s.name)
    renderRows()
    loadQuota()
  } catch (e) { if (e.message !== 'signed out') console.error(e) }
}

// ---------- panel tabs ----------
// ---------- light / dark (topbar, every page): the account's choice; until it makes one, the device's ----------
for (const b of document.querySelectorAll('[data-theme-toggle]')) b.addEventListener('click', () => {
  const root = document.documentElement
  const now = root.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
  const theme = now === 'light' ? 'dark' : 'light'
  root.dataset.theme = theme
  api('/me/theme', { method: 'PUT', body: JSON.stringify({ theme }) }).catch(() => {})
})

// ---------- the Simple | Advanced switch (topbar, every page) ----------
for (const b of document.querySelectorAll('[data-mode-set]')) b.addEventListener('click', async () => {
  const mode = b.dataset.modeSet
  if (mode === document.body.dataset.mode) return
  try { await api('/me/view', { method: 'PUT', body: JSON.stringify({ view: mode }) }) } catch { return }
  document.body.dataset.mode = mode
  for (const o of document.querySelectorAll('[data-mode-set]')) o.setAttribute('aria-pressed', String(o.dataset.modeSet === mode))
  // On a page Simple hides (Overview, Access tokens, SSH keys): to My area's sandboxes
  if (document.querySelector('nav a.active.adv')) { location.href = '/'; return }
  if (selected) { renderedJSON = null; void showPanel(selected) }
})

const TAB_KEY = 'p9m.panelTab'
let panelTab = (() => { try { return localStorage.getItem(TAB_KEY) || 'apps' } catch { return 'apps' } })()
function selectTab(tab, focus = false) {
  if (!P9mPanel.TABS.some(([id]) => id === tab)) tab = 'apps'
  panelTab = tab
  try { localStorage.setItem(TAB_KEY, tab) } catch { /* no storage: remembered for this page only */ }
  const panel = $('[data-panel]')
  for (const t of panel.querySelectorAll('[role="tab"]')) {
    const on = t.dataset.tab === tab
    t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1
    if (on && focus) t.focus()
  }
  for (const p of panel.querySelectorAll('[role="tabpanel"]')) p.hidden = p.dataset.tabpanel !== tab
  if (tab === 'registry' && selected) void loadRegistry(selected)
  if (tab === 'containers' && selected) void loadContainers(selected)
  if (tab === 'files' && selected) void loadFiles(selected)
}

// Just woken, the sandbox's own Docker does not answer for a few seconds: say so and ask again, while the box is shown
const DOCKER_STARTING = '<p class="muted">Docker is starting in the sandbox…</p>'
function whenDockerStarts(e, box, again) {
  if (e.body?.reason !== 'docker_starting') return false
  box.innerHTML = DOCKER_STARTING
  setTimeout(() => { if (box.isConnected) again() }, 2000)
  return true
}

// The Containers tab: the containers in the sandbox's own Docker, each running one with a terminal
async function loadContainers(name) {
  const box = $('[data-panel] [data-containers]')
  if (!box) return
  try {
    const data = await api(`/sandboxes/${encodeURIComponent(name)}/containers`)
    if (selected === name && box.isConnected) box.innerHTML = P9mPanel.containersTable(data)
  } catch (e) {
    if (!box.isConnected || whenDockerStarts(e, box, () => loadContainers(name))) return
    box.innerHTML = `<p class="error">${esc(e.message)}</p>`
  }
}

// The Registry tab: the sandbox's images and their secret-scan results
async function loadRegistry(name) {
  const box = $('[data-panel] [data-registry]')
  if (!box) return
  try {
    const data = await api(`/sandboxes/${encodeURIComponent(name)}/registry`)
    if (selected === name && box.isConnected) box.innerHTML = P9mPanel.registryTable(data)
  } catch (e) { if (box.isConnected) box.innerHTML = `<p class="error">${esc(e.message)}</p>` }
}
async function deleteVersion(b) {
  const name = selected
  const { deleteApp: app, deleteDigest: digest } = b.dataset
  if (!name || !await confirmDialog(`Delete ${app} (${digest.slice(7, 19)}) from the registry?`, 'Delete')) return
  try { await api(`/sandboxes/${encodeURIComponent(name)}/registry/${encodeURIComponent(app)}/${encodeURIComponent(digest)}`, { method: 'DELETE' }); await loadRegistry(name) }
  catch (e) { const err = $('[data-act-error]'); err.textContent = e.message; err.hidden = false }
}

// ---------- the Files tab: the sandbox's own files (/root, /home, /srv, /opt) and its apps' volumes ----------
const filesAt = new Map() // sandbox → the folder open in its Files tab ('volumes': their list), kept over the panel's re-renders
const volumesOf = new Map() // sandbox → its volumes, as last listed (which apps use the one open)
let filesListing = null
const filesBase = name => `/sandboxes/${encodeURIComponent(name)}/files`
const IN_VOLUME = /^\/var\/lib\/docker\/volumes\/[^/]+\/_data(\/|$)/
async function listVolumes(name) {
  const { volumes } = await api(`/sandboxes/${encodeURIComponent(name)}/volumes`)
  volumesOf.set(name, volumes)
  return volumes
}
async function loadFiles(name, path = filesAt.get(name) || '/root') {
  const box = $('[data-panel] [data-files]')
  if (!box) return
  try {
    if (path === 'volumes') {
      const volumes = await listVolumes(name)
      if (selected !== name || !box.isConnected) return
      filesAt.set(name, 'volumes')
      box.innerHTML = P9mPanel.volumesView({ volumes }, { name, now: Date.now(), roots: filesListing?.roots })
      return
    }
    const [d, volumes] = await Promise.all([api(`${filesBase(name)}?path=${encodeURIComponent(path)}`),
      IN_VOLUME.test(path) ? (volumesOf.get(name) ?? listVolumes(name).catch(() => [])) : null])
    if (selected !== name || !box.isConnected) return
    filesAt.set(name, d.path); filesListing = d
    const volume = volumes?.find(v => d.path === v.path || d.path.startsWith(`${v.path}/`))
    box.innerHTML = P9mPanel.filesView(d, { name, now: Date.now(), volume })
  } catch (e) {
    // A folder removed meanwhile (or in a terminal): back to /root
    if (path !== '/root' && /^No such|^Not a folder/.test(e.message)) { filesAt.delete(name); return loadFiles(name, '/root') }
    if (!box.isConnected || whenDockerStarts(e, box, () => loadFiles(name, path))) return
    box.innerHTML = `<p class="error">${esc(e.message)}</p>`
  }
}
function filesStatus(text, error = false) {
  const el = $('[data-panel] [data-files-status]'); if (!el) return
  el.hidden = !text; el.textContent = text || ''; el.className = error ? 'error' : 'muted'
}
/** Files picked (a folder's with their webkitRelativePath) as { file, rel }: rel is the path under the folder open. */
const picked = fileList => [...fileList].map(file => ({ file, rel: file.webkitRelativePath || file.name }))

/**
 * Files and folders dropped: a folder with everything in it, its empty folders too. The entries are taken before the
 * first await: the browser empties the DataTransfer once the drop event is over.
 */
async function dropped(dt) {
  const entries = [...(dt.items || [])].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean)
  if (!entries.length) return { files: picked(dt.files), dirs: [] }
  const files = [], dirs = []
  // readEntries gives a folder's entries a batch at a time, until an empty one
  const readAll = reader => new Promise((resolve, reject) => {
    const out = [], next = () => reader.readEntries(b => { if (!b.length) return resolve(out); out.push(...b); next() }, reject)
    next()
  })
  async function walk(e, rel) {
    if (e.isFile) files.push({ file: await new Promise((resolve, reject) => e.file(resolve, reject)), rel })
    else if (e.isDirectory) { dirs.push(rel); for (const c of await readAll(e.createReader())) await walk(c, `${rel}/${c.name}`) }
  }
  for (const e of entries) await walk(e, e.name)
  return { files, dirs }
}

/** Uploads into the folder open, four at a time; the folders on their paths are made by the server, empty ones here. */
async function uploadFiles({ files, dirs = [] }) {
  const name = selected, dir = filesAt.get(name) || '/root'
  if (!name || (!files.length && !dirs.length)) return
  if (dir === 'volumes') return filesStatus('Open a volume first, then drop the files in it.', true)
  const max = filesListing?.max_upload ?? Infinity, failed = []
  let done = 0, next = 0
  async function one({ file, rel }) {
    if (file.size > max) return failed.push(`${rel}: larger than ${P9mPanel.fmtBytes(max)}`)
    try {
      const res = await fetch(`${filesBase(name)}/content?path=${encodeURIComponent(`${dir}/${rel}`)}`, { method: 'PUT', body: file, headers: { 'Content-Type': 'application/octet-stream' }, credentials: 'same-origin' })
      if (!res.ok) failed.push(`${rel}: ${(await res.json().catch(() => ({}))).error || `HTTP ${res.status}`}`)
    } catch { failed.push(`${rel}: the upload broke off (too large?)`) }
    filesStatus(`Uploading… ${++done} of ${files.length}`)
  }
  filesStatus(`Uploading… 0 of ${files.length}`)
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => { while (next < files.length) await one(files[next++]) }))
  for (const d of dirs.filter(d => !files.some(f => f.rel.startsWith(`${d}/`)))) {
    try { await api(`${filesBase(name)}/mkdir`, { method: 'POST', body: JSON.stringify({ path: `${dir}/${d}` }) }) } catch (e) { failed.push(`${d}/: ${e.message}`) }
  }
  await loadFiles(name, dir)
  const what = files.length === 1 && !dirs.length ? files[0].rel : `${files.length} file${files.length === 1 ? '' : 's'}`
  filesStatus(failed.length ? `Not uploaded: ${failed.join('; ')}` : `Uploaded ${what}.`, failed.length > 0)
}
async function deleteFile(path) {
  const name = selected
  if (!name || !await confirmDialog(`Delete ${path}? A folder goes with everything in it.`, 'Delete')) return
  try { await api(`${filesBase(name)}?path=${encodeURIComponent(path)}`, { method: 'DELETE' }); await loadFiles(name) }
  catch (e) { filesStatus(e.message, true) }
}
async function makeFolder(form) {
  const name = selected, folder = form.folder.value.trim().replace(/^\/+|\/+$/g, '')
  if (!name || !folder) return
  const path = `${filesAt.get(name) || '/root'}/${folder}`
  try { await api(`${filesBase(name)}/mkdir`, { method: 'POST', body: JSON.stringify({ path }) }); await loadFiles(name, path) }
  catch (e) { filesStatus(e.message, true) }
}

// ---------- host folders (admin): mounting one or taking it away recreates the sandbox container ----------
async function changeMount(form, target) {
  const name = selected
  if (!name) return
  const s = sandboxes.find(x => x.name === name)
  const restart = s?.status === 'running' ? 'The sandbox restarts (its apps are unreachable for a few seconds).'
    : s?.status === 'deep_sleep' ? 'It applies when the sandbox wakes.' : 'The sandbox stays asleep.'
  const field = n => form.querySelector(`[name=${n}]`)
  const body = form ? { host: field('host').value.trim(), ...(field('target').value.trim() ? { target: field('target').value.trim() } : {}), readonly: field('readonly').checked } : null
  const q = form ? `Mount ${body.host} into ${shortName(name)}${body.readonly ? ' read-only' : ''}? Its owner gets that host folder as root. ${restart}`
    : `Unmount ${target} from ${shortName(name)}? ${restart}`
  if (!await confirmDialog(q, form ? 'Mount' : 'Unmount')) return
  const section = $('[data-panel] .mounts')
  const controls = section ? [...section.querySelectorAll('button, input')] : []
  for (const el of controls) el.disabled = true
  $('[data-act-error]').hidden = true
  try {
    const url = `/sandboxes/${encodeURIComponent(name)}/mounts`
    if (form) await api(url, { method: 'POST', body: JSON.stringify(body) })
    else await api(`${url}?target=${encodeURIComponent(target)}`, { method: 'DELETE' })
    renderedJSON = null
    if (selected === name) await showPanel(name)
  } catch (e) {
    // The form keeps what was typed, to correct it (Docker's own words for a host folder it cannot mount)
    for (const el of controls) el.disabled = false
    const err = $('[data-act-error]'); if (err && selected === name) { err.textContent = e.message; err.hidden = false }
  }
}

// ---------- export for coding agents ----------
// A new token for the sandbox as p9m.env text, to the clipboard (or shown to copy by hand without one)
async function copyEnv(name, b = $('[data-panel] [data-act="copy-env"]'), opts = {}) {
  // It may wake the sandbox to make its Portainer token: seconds, not instant
  if (b) { b.disabled = true; b.textContent = 'Preparing…' }
  try {
    const res = await fetch(`/sandboxes/${encodeURIComponent(name)}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ format: 'env', name: opts.name || `copied ${new Date().toISOString().slice(0, 10)}`, expires_in: opts.expires_in || '90d' }) })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
    const text = await res.text()
    const skipped = res.headers.get('X-P9m-Portainer')
    try {
      await navigator.clipboard.writeText(text)
      if (b) { b.textContent = skipped ? 'Copied, without Portainer' : 'Copied'; b.title = skipped || ''; setTimeout(() => { b.textContent = 'Copy as .env' }, skipped ? 4000 : 1500) }
    } catch {
      const dlg = $('[data-env-dialog]'), box = $('[data-env-text]')
      box.value = text; dlg.showModal(); box.select()
    }
  } catch (e) { if (b) b.textContent = 'Copy as .env'; const err = (b && b.closest('dialog') ? $('[data-export-error]') : null) || $('[data-act-error]'); err.textContent = e.message; err.hidden = false } finally { if (b) b.disabled = false }
}
// The window's Options (Advanced): the token's name and expiry, for the zip and Copy as .env
function exportOptions() {
  const form = $('[data-export-form]')
  return { name: form.elements.name.value.trim(), expires_in: form.elements.expires_in.value }
}
function openExportDialog(name) {
  const dlg = $('[data-export-dialog]')
  if (!dlg) return void location.reload()
  dlg.dataset.sandbox = name
  // The line to paste into Claude Code in the project's folder
  const initLine = $('[data-init-cmd]')
  try { initLine.textContent = P9mPanel.initCommand(location.origin, shortName(name)) } catch { initLine.textContent = '' }
  let ready = false
  try { ready = JSON.parse(renderedJSON || '{}').docker_access?.state === 'ready' } catch { /* not rendered yet */ }
  $('[data-export-needs-certs]').hidden = ready
  $('[data-export-enable]').hidden = ready
  $('[data-export-plain]').hidden = ready
  $('[data-export-download]').hidden = !ready
  $('[data-export-error]').hidden = true
  $('[data-export-progress]').hidden = true
  dlg.showModal()
}
function initExportDialog() {
  const form = $('[data-export-form]')
  if (!form) return
  form.addEventListener('click', async ev => {
    const env = ev.target.closest('[data-copy-env]')
    if (env) return void copyEnv($('[data-export-dialog]').dataset.sandbox, env, exportOptions())
    const copy = ev.target.closest('[data-copy-from]')
    if (copy) {
      const el = copy.closest('.copy-line')?.querySelector(copy.dataset.copyFrom)
      if (!el?.textContent) return
      try { await navigator.clipboard.writeText(el.textContent); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy' }, 1500) }
      catch { const r = document.createRange(); r.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r) }
      return
    }
  })
  form.addEventListener('submit', async ev => {
    const how = ev.submitter?.value
    if (!['download', 'plain', 'enable'].includes(how)) return
    ev.preventDefault()
    const dlg = $('[data-export-dialog]'), name = dlg.dataset.sandbox, btn = ev.submitter
    const progress = $('[data-export-progress]')
    for (const b of form.querySelectorAll('button')) b.disabled = true
    try {
      if (how === 'enable') {
        progress.textContent = 'Enabling Docker access: the sandbox restarts…'; progress.hidden = false
        await api(`/sandboxes/${encodeURIComponent(name)}/docker-keys`, { method: 'POST' })
        renderedJSON = null; void showPanel(name)
      }
      const { no_docker, ...fields } = Object.fromEntries(new FormData(form))
      const body = { ...fields, docker: how !== 'plain' && !no_docker }
      const res = await fetch(`/sandboxes/${encodeURIComponent(name)}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(await res.blob())
      a.download = `p9m-${shortName(name)}.zip`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 1000)
      dlg.close(); form.reset()
    } catch (e) { const err = $('[data-export-error]'); err.textContent = e.message; err.hidden = false } finally { progress.hidden = true; for (const b of form.querySelectorAll('button')) b.disabled = false; void btn }
  })
}
async function copyText(b) {
  try {
    await navigator.clipboard.writeText(b.dataset.copyText)
    b.dataset.label ??= b.textContent
    b.textContent = 'Copied'; clearTimeout(b._copied); b._copied = setTimeout(() => { b.textContent = b.dataset.label }, 1500)
  } catch {
    // No clipboard (plain HTTP): select the text next to the button for Ctrl+C
    const el = b.parentElement.querySelector('.tcp, [data-secret]:not([hidden])')
    if (el) { const r = document.createRange(); r.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r) }
  }
}

async function showPanel(name) {
  selected = name
  renderRows()
  const panel = $('[data-panel]')
  if (pending.has(name)) { panel.innerHTML = `<h2>${esc(shortName(name))}</h2><p class="muted">Creating… usually 10–30 s.</p>`; renderedName = name; renderedJSON = null; return }
  // Another sandbox than the one shown: its name and status at once, never the previous one's details while its load
  if (renderedName !== name) {
    panel.innerHTML = P9mPanel.loadingPanel(sandboxes.find(s => s.name === name) ?? { name, status: '' }, { shortName })
    renderedName = name
    renderedJSON = null
  }
  let s
  try { s = await api(`/sandboxes/${encodeURIComponent(name)}`) } catch (e) { panel.innerHTML = `<p class="error">${esc(e.message)}</p>`; renderedJSON = null; return }
  if (selected !== name) return
  // Compare without the seconds left and the CPU/memory use, which change on every poll: re-render only when something else changed
  const sJSON = JSON.stringify({ ...s, stops_in: undefined, deep_sleep_in: undefined, usage: undefined })
  s = onLocalClock(s)
  if (renderedName === name && renderedJSON === sJSON) {
    const cell = panel.querySelector('[data-resources]') // only the use changed: update just its meters
    if (cell) cell.innerHTML = P9mPanel.resourcesTable(s)
    return
  }
  renderedName = name
  renderedJSON = sJSON
  panel.innerHTML = P9mPanel.renderPanel(s, { isAdmin, me, shortName, tab: panelTab, protocol: location.protocol, simple: simpleView() })
  if (panelTab === 'registry') void loadRegistry(name)
  if (panelTab === 'containers') void loadContainers(name)
  if (panelTab === 'files') void loadFiles(name)
  if (busy.has(name)) markBusy(panel, busy.get(name))
}

// The lifecycle actions, in the words of the lifecycle: sleep, deep sleep, wake, archive.
// "busy" and "status" are shown while the call runs, which can take a while (archiving: minutes).
const ACTIONS = {
  stop: { label: 'Sleep', busy: 'Going to sleep…', status: 'going to sleep…', row: 'going to sleep…' },
  'deep-sleep': { label: 'Deep sleep', busy: 'Going into deep sleep…', status: 'going into deep sleep…', row: 'going into deep sleep…' },
  start: { label: 'Wake', busy: 'Waking…', status: 'waking… (from deep sleep this takes up to a minute)', row: 'waking…' },
  delete: { label: 'Archive…', busy: 'Archiving…', status: 'archiving… with large volumes this can take a few minutes', row: 'archiving…' },
}
const actButton = a => `<button data-act="${a}">${ACTIONS[a].label}</button>`

function lifecycleButtons(s) {
  if (s.status === 'running') return actButton('stop') + actButton('deep-sleep')
  if (s.status === 'deep_sleep') return actButton('start')
  return actButton('start') + actButton('deep-sleep') // asleep, created, failed
}

// Resolves true for OK, false for Cancel, Esc or a click outside the buttons
function confirmDialog(text, okLabel) {
  const dlg = $('[data-confirm-dialog]')
  dlg.querySelector('[data-confirm-text]').textContent = text
  dlg.querySelector('[data-confirm-ok]').textContent = okLabel
  dlg.returnValue = ''
  return new Promise(resolve => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true })
    dlg.showModal()
  })
}

// Sandboxes with an action running (archiving can take minutes): another sandbox can be acted on
// meanwhile; the 5 s refresh leaves a busy sandbox's panel alone
const busy = new Map() // sandbox name → the action running on it

// The panel while an action runs: buttons off, the pressed one and the status say what is happening
function markBusy(panel, action) {
  // Every action, in every tab (some sit in table cells, not in an .actions row)
  for (const b of panel.querySelectorAll('button[data-act], button[data-connect]')) b.disabled = true
  const pressed = panel.querySelector(`[data-act="${action}"]`)
  if (pressed) { pressed.textContent = ACTIONS[action].busy; pressed.classList.add('busy') }
  const pill = panel.querySelector('.status')
  if (pill) { pill.className = 'status starting'; pill.textContent = ACTIONS[action].status }
}

async function act(action) {
  const name = selected
  if (!name || busy.has(name)) return
  if (action === 'terminal') return void window.open(`/sandboxes/${encodeURIComponent(name)}/terminal`, '_blank')
  if (action === 'logs') return void window.open(`/sandboxes/${encodeURIComponent(name)}/logs`, '_blank')
  if (action === 'ssh-key') {
    try { await api(`/sandboxes/${encodeURIComponent(name)}/ssh-key`, { method: 'POST' }); renderedJSON = null; showPanel(name) }
    catch (e) { const err = $('[data-act-error]'); err.textContent = e.message; err.hidden = false }
    return
  }
  if (action === 'keep-awake') {
    const btn = $('[data-panel] [data-act="keep-awake"]')
    if (btn) { btn.disabled = true; btn.textContent = 'Resetting…' }
    try { await api(`/sandboxes/${encodeURIComponent(name)}/keep-awake`, { method: 'POST' }); renderedJSON = null; await showPanel(name) }
    catch (e) { const err = $('[data-act-error]'); err.textContent = e.message; err.hidden = false; if (btn) { btn.disabled = false; btn.textContent = 'Reset' } }
    return
  }
  if (action === 'export') return openExportDialog(name)
  if (action === 'copy-env') return copyEnv(name)
  if (action === 'enable-docker' || action === 'rotate-docker-keys') {
    const rotate = action === 'rotate-docker-keys'
    const q = rotate
      ? `New Docker keys for ${shortName(name)}? Earlier exports stop working; the sandbox restarts (~30 s).`
      : `Enable Docker access for ${shortName(name)}? The sandbox restarts (~30 s).`
    if (!await confirmDialog(q, rotate ? 'Rotate' : 'Enable')) return
    try { await api(`/sandboxes/${encodeURIComponent(name)}/docker-keys`, { method: 'POST' }); renderedJSON = null; await showPanel(name) }
    catch (e) { const err = $('[data-act-error]'); err.textContent = e.message; err.hidden = false }
    return
  }
  if (action === 'sleep') return openSleepDialog()
  if (action === 'resources') return openResourceDialog()
  if (action === 'token') return $('[data-token-dialog]') ? openTokenDialog(name) : location.reload()
  if (action === 'compose') return $('[data-compose-dialog]') ? openComposeDialog(name) : location.reload()
  if (action === 'delete' && !await confirmDialog(`Archive ${shortName(name)}? It disappears from the list; its configuration and data are kept in the archive.`, 'Archive')) return
  if (busy.has(name)) return // the same action started while the question was open
  const panel = $('[data-panel]')
  busy.set(name, action)
  markBusy(panel, action)
  renderRows()
  $('[data-act-error]').hidden = true
  try {
    if (action === 'delete') await api(`/sandboxes/${encodeURIComponent(name)}`, { method: 'DELETE' })
    else await api(`/sandboxes/${encodeURIComponent(name)}/${action}`, { method: 'POST' })
    busy.delete(name)
    // The user may have moved on to another sandbox meanwhile: its panel is not ours to change
    if (action === 'delete' && selected === name) { selected = null; panel.innerHTML = `<p class="muted">${esc(shortName(name))} is archived.</p>`; renderedName = null; renderedJSON = null }
    await loadList()
    if (selected === name) { renderedJSON = null; await showPanel(name) }
  } catch (e) {
    // At the running limit: let the owner choose which running sandbox sleeps instead
    if (action === 'start' && (e.body?.reason === 'running' || e.body?.reason === 'room')) { busy.delete(name); renderRows(); if (selected === name) { renderedJSON = null; await showPanel(name) } return openSwapDialog(name, e.body.running, e.body.limit) }
    busy.delete(name)
    renderRows()
    if (selected !== name) {
      // shown in the panel the user is on now, saying which sandbox it is about
      await loadList()
      const err = $('[data-act-error]')
      if (err) { err.textContent = `${shortName(name)}: ${e.message}`; err.hidden = false }
      return
    }
    renderedJSON = null
    await showPanel(name)
    const err = $('[data-act-error]')
    if (err) { err.textContent = e.message; err.hidden = false }
  }
}

// ---------- SSH keys ----------
async function loadSshKeys() {
  const rows = $('[data-ssh-key-rows]')
  try {
    const keys = await api('/ssh-keys')
    rows.innerHTML = keys.length ? keys.map(k => `<tr>
      <td>${esc(k.name)}</td><td>${esc(k.type)}</td><td><code>${esc(k.fingerprint)}</code></td><td>${esc(new Date(k.created_at).toLocaleDateString())}</td>
      <td><button class="danger" data-delete-key="${esc(k.id)}" data-key-name="${esc(k.name)}">Delete</button></td></tr>`).join('')
      : '<tr><td class="muted" colspan="5">No keys yet: add one below to SSH into your sandboxes.</td></tr>'
  } catch (e) { rows.innerHTML = `<tr><td class="error" colspan="5">${esc(e.message)}</td></tr>` }
}

function initSshKeys() {
  const form = $('[data-ssh-key-form]')
  form.addEventListener('submit', async ev => {
    ev.preventDefault()
    const err = $('[data-ssh-key-error]')
    err.hidden = true
    const data = Object.fromEntries(new FormData(form))
    try {
      await api('/ssh-keys', { method: 'POST', body: JSON.stringify({ key: data.key, ...(data.name ? { name: data.name } : {}) }) })
      form.reset()
      loadSshKeys()
    } catch (e) { err.textContent = e.message; err.hidden = false }
  })
  $('[data-ssh-key-rows]').addEventListener('click', async e => {
    const b = e.target.closest('button[data-delete-key]'); if (!b) return
    if (!await confirmDialog(`Delete the key ${b.dataset.keyName}? It stops letting you into your sandboxes at once.`, 'Delete')) return
    try { await api(`/ssh-keys/${encodeURIComponent(b.dataset.deleteKey)}`, { method: 'DELETE' }); loadSshKeys() } catch (err) { alert(err.message) }
  })
  loadSshKeys()
}

// ---------- TCP connect dialog ----------
// The container's own port says which service it is; anything else gets only the generic TLS recipe
const CONNECT_KINDS = { 5432: 'postgres', 6379: 'redis', 22: 'ssh', 2222: 'ssh' }
function openConnectDialog(hostPort, { port, user, demoPassword, keyFile } = {}) {
  const host = hostPort.replace(/:443$/, '')
  const kind = CONNECT_KINDS[port]
  $('[data-connect-host]').textContent = hostPort
  for (const el of document.querySelectorAll('[data-connect-kind]')) el.hidden = el.dataset.connectKind !== kind
  const login = $('[data-connect-login]')
  const parts = [user && `User: <code>${esc(user)}</code>`,
    demoPassword && `Password: <code data-secret hidden>${esc(demoPassword)}</code> <button class="link" data-show>show</button>`].filter(Boolean)
  login.innerHTML = parts.join(' · ')
  login.hidden = !parts.length
  $('[data-connect-psql]').textContent = `psql "host=${host} port=443 sslmode=require user=${user || 'postgres'} dbname=postgres"`
  $('[data-connect-redis]').textContent = `redis-cli -h ${host} -p 443 --tls --sni ${host}${user ? ` --user ${user}` : ''} -a <password>`
  // With the sandbox's generated key (Download key saves it as <name>.key)
  const keyPath = keyFile ? `~/Downloads/${keyFile}` : ''
  $('[data-connect-ssh-cmd]').textContent = `${keyPath ? `chmod 600 ${keyPath}\n` : ''}ssh ${keyPath ? `-i ${keyPath} ` : ''}-o ProxyCommand="openssl s_client -quiet -connect %h:443 -servername %h" ${user || '<user>'}@${host}`
  $('[data-connect-ssh]').textContent = `Host ${host.split('.')[0]}
  HostName ${host}
  User ${user || '<user>'}${keyPath ? `\n  IdentityFile ${keyPath}` : ''}
  ProxyCommand openssl s_client -quiet -connect %h:443 -servername %h`
  $('[data-connect-openssl]').textContent = `openssl s_client -quiet -connect ${host}:443 -servername ${host}`
  $('[data-connect-dialog]').showModal()
}

// ---------- starter stack viewer ----------
async function openComposeDialog(name) {
  $('[data-compose-name]').textContent = shortName(name)
  $('[data-compose-text]').textContent = 'Loading…'
  $('[data-compose-dialog]').showModal()
  try {
    const { starter } = await api(`/sandboxes/${encodeURIComponent(name)}/compose`)
    $('[data-compose-text]').textContent = starter ?? 'No starter stack was deployed into this sandbox.'
  } catch (e) { $('[data-compose-text]').textContent = e.message }
}

function initComposeDialog() {
  if (!$('[data-compose-dialog]')) return
  $('[data-compose-copy]').addEventListener('click', async e => {
    await navigator.clipboard.writeText($('[data-compose-text]').textContent)
    e.target.textContent = 'Copied'; setTimeout(() => { e.target.textContent = 'Copy' }, 1500)
  })
}

// ---------- sleep settings ----------
// ---------- CPU and memory ----------
let meInfo = null // GET /me: defaults, ceiling (and the host for the admin) for the forms
const GB = 1024 ** 3
const memInput = b => b % GB === 0 ? `${b / GB}g` : `${Math.round(b / 1024 ** 2)}m`
function usageCell(s) {
  const disk = s.disk?.over ? ` <span class="warn" title="over its disk limit: ${fmtBytes(s.disk.used)} of ${fmtBytes(s.disk.limit)}">⚠ disk</span>` : ''
  if (s.status !== 'running' || !s.usage || !s.limits) return disk ? disk.trim() : '<span class="muted">—</span>'
  return `${Math.round(s.usage.cpu / s.limits.cpus * 100)}% · ${fmtBytes(s.usage.memory)}${disk}`
}
function ceilingText() {
  const r = meInfo?.resources
  if (!r) return ''
  return r.host ? `up to the host: ${r.host.cpus} CPUs, ${fmtBytes(r.host.memory)}` : `up to ${r.ceiling.cpus} CPUs and ${fmtBytes(r.ceiling.memory)}`
}
function showResourceHint() {
  const r = meInfo?.resources
  const hint = $('[data-resource-hint]')
  if (!r || !hint) return
  const form = $('[data-new-form]')
  form.cpus.placeholder = String(r.defaults.cpus)
  form.memory.placeholder = memInput(r.defaults.memory)
  hint.textContent = `default ${r.defaults.cpus} CPUs and ${fmtBytes(r.defaults.memory)}; ${ceilingText()}`
}
function openResourceDialog() {
  const s = renderedJSON && JSON.parse(renderedJSON)
  const l = s?.limits || meInfo?.resources?.defaults
  const form = $('[data-resource-form]')
  form.cpus.value = l ? String(l.cpus) : ''
  form.memory.value = l ? memInput(l.memory) : ''
  // What it opened with: only the fields changed are sent (an untouched one is not checked against the ceiling again)
  form.dataset.cpus = form.cpus.value
  form.dataset.memory = form.memory.value
  // The disk limit only warns, so only the admin sets it
  const admin = !!meInfo?.resources?.host
  $('[data-disk-field]').hidden = !admin
  form.disk.value = admin && s?.disk ? memInput(s.disk.limit) : ''
  form.dataset.disk = form.disk.value
  $('[data-resource-ceiling]').textContent = ceilingText()
  $('[data-resource-error]').hidden = true
  $('[data-resource-dialog]').showModal()
}
async function submitResources(ev) {
  if (ev.submitter?.value !== 'save') return
  ev.preventDefault()
  const name = selected
  const form = ev.target
  const change = {}
  if (form.cpus.value.trim() !== form.dataset.cpus) change.cpus = form.cpus.value.trim()
  if (form.memory.value.trim() !== form.dataset.memory) change.memory = form.memory.value.trim()
  if (!$('[data-disk-field]').hidden && form.disk.value.trim() && form.disk.value.trim() !== form.dataset.disk) change.disk = form.disk.value.trim()
  if (!Object.keys(change).length) { $('[data-resource-dialog]').close(); return }
  const btn = ev.submitter
  btn.disabled = true
  try {
    await api(`/sandboxes/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify(change) })
    $('[data-resource-dialog]').close()
    await loadList()
    if (selected === name) { renderedJSON = null; showPanel(name) }
  } catch (e) {
    const err = $('[data-resource-error]'); err.textContent = e.message; err.hidden = false
  } finally { btn.disabled = false }
}

function openSleepDialog() {
  const s = renderedJSON && JSON.parse(renderedJSON)
  const form = $('[data-sleep-form]')
  form.idle_timeout.value = s?.idle_timeout || ''
  form.deep_sleep_after.value = s?.deep_sleep_after || ''
  $('[data-sleep-error]').hidden = true
  $('[data-sleep-dialog]').showModal()
}

async function submitSleep(ev) {
  if (ev.submitter?.value !== 'save') return
  ev.preventDefault()
  const name = selected
  const data = Object.fromEntries(new FormData(ev.target))
  const btn = ev.submitter
  btn.disabled = true
  try {
    // Only what was changed: a sandbox may keep a value from before the server's limit (SANDBOX_MAX_*), which
    // must not stop a change of the other one
    const was = JSON.parse(renderedJSON || '{}')
    const changes = {}
    if (data.idle_timeout !== (was.idle_timeout || '')) changes.idle_timeout = data.idle_timeout
    if (data.deep_sleep_after !== (was.deep_sleep_after || '')) changes.deep_sleep_after = data.deep_sleep_after
    if (Object.keys(changes).length) await api(`/sandboxes/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify(changes) })
    $('[data-sleep-dialog]').close()
    await loadList()
    if (selected === name) { renderedJSON = null; showPanel(name) }
  } catch (e) {
    const err = $('[data-sleep-error]'); err.textContent = e.message; err.hidden = false
  } finally { btn.disabled = false }
}

// Fills a select from GET /runtimes or /templates once, with the server's default selected
async function fillCatalog(sel, path) {
  if (sel.options.length) return
  try {
    const items = await api(path)
    sel.innerHTML = items.map(t => `<option value="${esc(t.name)}"${t.default ? ' selected' : ''}>${esc(t.name)} — ${esc(t.description)}</option>`).join('')
  } catch { sel.innerHTML = '<option value="">default</option>' }
}

// The selected template's starter stack, to look at: a sandbox starts with it as it is (it cannot be edited)
let shownTemplate = null

async function showTemplateStack(name) {
  const box = $('[data-compose-view]')
  shownTemplate = name
  try {
    const t = await api(`/templates/${encodeURIComponent(name)}`)
    const text = t.compose.replace(/\r\n?/g, '\n')
    box.textContent = /^services:\s*\{\}\s*$/m.test(text) || !/^services:/m.test(text) ? 'No starter stack: deploy your apps with docker, SSH or an agent.' : text
  } catch (e) {
    box.textContent = `Could not load the ${name} template: ${e.message}`
  }
}

// Opens at once; the name (GET /sandbox-name, a directory listing on the server) does not wait for the runtimes,
// templates and the template's stack, which fill in beside it
async function openNewDialog() {
  const dlg = $('[data-new-dialog]')
  $('[data-new-error]').hidden = true
  dlg.showModal()
  // An empty name (not one kept from a failed create) gets a generated one, selected: typing replaces it
  const named = $('[data-new-form]').elements.name.value ? null : suggestName()
  await Promise.all([fillCatalog($('[data-runtimes]'), '/runtimes'), fillCatalog($('[data-templates]'), '/templates')])
  const tpl = $('[data-templates]').value
  if (shownTemplate !== tpl) await showTemplateStack(tpl)
  await named
}

async function suggestName() {
  const input = $('[data-new-form]').elements.name
  try { input.value = (await api('/sandbox-name')).name } catch { return }
  showNameHint()
  input.focus(); input.select()
}

function showNameHint() {
  const v = $('[data-new-form]').elements.name.value
  $('[data-name-hint]').textContent = `lowercase letters, digits, - and _ · URLs look like ${v || 'name'}-….${location.hostname.replace(/^p9m\./, '')}`
}

async function submitNew(ev) {
  if (ev.submitter?.value !== 'create') return
  ev.preventDefault()
  const form = ev.target
  const data = Object.fromEntries(new FormData(form))
  const body = { name: data.name, create_inner_stack: form.create_inner_stack.checked }
  if (data.template) body.template = data.template
  if (data.runtime) body.runtime = data.runtime
  if (data.cpus) body.cpus = data.cpus
  if (data.memory) body.memory = data.memory
  const sshKeys = (data.ssh_keys || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (sshKeys.length) body.ssh_keys = sshKeys
  // Only when changed from the form's default: otherwise the server's default, cut to its limit for users
  if (data.idle_timeout && data.idle_timeout !== form.idle_timeout.defaultValue) body.idle_timeout = data.idle_timeout
  if (data.deep_sleep_after && data.deep_sleep_after !== form.deep_sleep_after.defaultValue) body.deep_sleep_after = data.deep_sleep_after
  const full = `${prefix}-${data.name}`
  // Reset now, not when the create finishes (that can take a minute): a dialog opened meanwhile
  // must not lose what is being typed. A failed create puts the submitted values back.
  const draft = { values: data, inner: form.create_inner_stack.checked }
  form.reset()
  pending.add(full)
  $('[data-new-dialog]').close()
  renderRows()
  showPanel(full)
  try {
    await api('/sandboxes', { method: 'POST', body: JSON.stringify(body) })
  } catch (e) {
    pending.delete(full)
    renderRows()
    selected = null
    $('[data-panel]').innerHTML = '<p class="muted">Select a sandbox to see its details.</p>'
    renderedName = null
    renderedJSON = null
    const dlg = $('[data-new-dialog]')
    const err = $('[data-new-error]')
    // Opened again meanwhile for another sandbox: say what failed, leave what is being typed alone
    if (dlg.open) { err.textContent = `${data.name}: ${e.message}`; err.hidden = false; return }
    for (const [k, v] of Object.entries(draft.values)) { const el = form.elements[k]; if (el && el.type !== 'checkbox') el.value = v }
    form.create_inner_stack.checked = draft.inner
    err.textContent = e.message; err.hidden = false
    dlg.showModal()
    return
  }
  // Its apps answer by now (the create waits for its router): its own details first, then the whole list, which can
  // take a few seconds on a server with many sandboxes
  try {
    const s = onLocalClock(await api(`/sandboxes/${encodeURIComponent(full)}`))
    sandboxes = [...sandboxes.filter(x => x.name !== full), s]
    pending.delete(full)
    renderRows()
    if (selected === full) showPanel(full)
  } catch { /* the list below brings it */ }
  await loadList()
  if (selected === full) showPanel(full)
}

function initSandboxes() {
  // Defaults and ceilings for the resource fields, in every view (loadQuota only runs in "mine")
  api('/me').then(m => { meInfo = m; showResourceHint() }).catch(() => {})
  $('[data-title]').textContent = view === 'all' ? 'All sandboxes' : 'My sandboxes'
  // The filter, in both lists: free text (name, status, template, apps; the owner too in All sandboxes) and status
  $('[data-filters]').hidden = false
  $('[data-filter-text]').placeholder = view === 'all' ? 'Filter by name, owner, app…' : 'Filter by name, status, app…'
  $('[data-filter-text]').addEventListener('input', renderRows)
  $('[data-filter-status]').addEventListener('change', renderRows)
  if (view === 'all') {
    // From the Overview: /admin?status=running, /admin?owner=…
    const q = new URLSearchParams(location.search)
    if (q.get('owner')) $('[data-filter-text]').value = q.get('owner')
    if (q.get('status')) $('[data-filter-status]').value = q.get('status')
  }
  $('[data-rows]').addEventListener('click', e => { const tr = e.target.closest('tr[data-name]'); if (tr) showPanel(tr.dataset.name) })
  $('[data-connect-login]')?.addEventListener('click', e => {
    const b = e.target.closest('button[data-show]'); if (!b) return
    const s = b.parentElement.querySelector('[data-secret]'); s.hidden = !s.hidden; b.textContent = s.hidden ? 'show' : 'hide'
  })
  $('[data-panel]').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return
    if (b.dataset.tab) return selectTab(b.dataset.tab)
    if (b.dataset.copyText !== undefined) return void copyText(b)
    if (b.dataset.deleteDigest) return void deleteVersion(b)
    if (b.dataset.containerTerminal) return void window.open(`/sandboxes/${encodeURIComponent(selected)}/terminal?container=${encodeURIComponent(b.dataset.containerTerminal)}`, '_blank')
    if (b.dataset.filesPath) return void loadFiles(selected, b.dataset.filesPath)
    if ('filesVolumes' in b.dataset) return void loadFiles(selected, 'volumes')
    if (b.dataset.filesDelete) return void deleteFile(b.dataset.filesDelete)
    if (b.dataset.mountRemove) return void changeMount(null, b.dataset.mountRemove)
    if (b.dataset.show !== undefined) {
      const s = b.parentElement.querySelector('[data-secret]'); s.hidden = !s.hidden; b.textContent = s.hidden ? 'show' : 'hide'
      const mask = b.parentElement.querySelector('[data-secret-mask]'); if (mask) mask.hidden = !s.hidden
    }
    if (b.dataset.connect) { if ($('[data-connect-dialog]')) openConnectDialog(b.dataset.connect, { port: Number(b.dataset.port), user: b.dataset.user, demoPassword: b.dataset.demoPassword, keyFile: b.dataset.keyFile }); else location.reload(); return }
    if (b.dataset.act) act(b.dataset.act)
  })
  // The Files tab: a new folder, files picked or dropped
  $('[data-panel]').addEventListener('submit', e => { if (e.target.matches('[data-files-mkdir]')) { e.preventDefault(); void makeFolder(e.target) } })
  // Resources: a host folder to mount; the target's placeholder shows the default (/mnt/<last part of the host path>)
  $('[data-panel]').addEventListener('submit', e => { if (e.target.matches('[data-mount-form]')) { e.preventDefault(); void changeMount(e.target) } })
  $('[data-panel]').addEventListener('input', e => {
    if (!e.target.matches('[data-mount-form] [name=host]')) return
    const last = e.target.value.trim().replace(/\/+$/, '').split('/').pop()
    e.target.form.querySelector('[name=target]').placeholder = `/mnt/${last || '<folder name>'}`
  })
  $('[data-panel]').addEventListener('change', e => { if (e.target.matches('[data-files-input]')) { void uploadFiles({ files: picked(e.target.files) }); e.target.value = '' } })
  $('[data-panel]').addEventListener('dragover', e => { const z = e.target.closest('[data-files]'); if (z && e.dataTransfer?.types.includes('Files')) { e.preventDefault(); z.classList.add('drop') } })
  $('[data-panel]').addEventListener('dragleave', e => { const z = e.target.closest('[data-files]'); if (z && !z.contains(e.relatedTarget)) z.classList.remove('drop') })
  $('[data-panel]').addEventListener('drop', e => { const z = e.target.closest('[data-files]'); if (!z) return; e.preventDefault(); z.classList.remove('drop'); void dropped(e.dataTransfer).then(uploadFiles, err => filesStatus(`Could not read what was dropped: ${err.message}`, true)) })
  $('[data-panel]').addEventListener('keydown', e => {
    const t = e.target.closest('[role="tab"]'); if (!t) return
    const ids = P9mPanel.TABS.map(([id]) => id), i = ids.indexOf(t.dataset.tab)
    const next = { ArrowRight: ids[(i + 1) % ids.length], ArrowLeft: ids[(i - 1 + ids.length) % ids.length], Home: ids[0], End: ids[ids.length - 1] }[e.key]
    if (next) { e.preventDefault(); selectTab(next, true) }
  })
  $('[data-new]').addEventListener('click', openNewDialog)
  $('[data-new-form]').addEventListener('submit', submitNew)
  $('[data-templates]').addEventListener('change', e => showTemplateStack(e.target.value))
  $('[data-sleep-form]').addEventListener('submit', submitSleep)
  $('[data-resource-form]').addEventListener('submit', submitResources)
  initTokenDialog()
  initExportDialog()
  initComposeDialog()
  $('[data-new-form] input[name=name]').addEventListener('input', showNameHint)
  $('[data-new-name]').addEventListener('click', suggestName)
  initSwapDialog()
  loadList().then(() => { if (view === 'mine') wakeFromLink() })
  setInterval(async () => { await loadList(); if (selected && !pending.has(selected) && !busy.has(selected)) showPanel(selected) }, 5000)
}

// ---------- running limit: choose what sleeps ----------
function openSwapDialog(name, running, limit = running.length) {
  const dlg = $('[data-swap-dialog]')
  $('[data-swap-text]').textContent = `You can have ${limit} sandbox${limit === 1 ? '' : 'es'} running. Put one to sleep to wake ${shortName(name)}:`
  $('[data-swap-options]').innerHTML = running.map((r, i) => `<label class="check"><input type="radio" name="sleep" value="${esc(r)}"${i ? '' : ' checked'}> ${esc(shortName(r))}</label>`).join('')
  $('[data-swap-ok]').textContent = `Sleep it and wake ${shortName(name)}`
  $('[data-swap-error]').hidden = true
  dlg.dataset.sandbox = name
  dlg.showModal()
}
function initSwapDialog() {
  const form = $('[data-swap-form]')
  form.addEventListener('submit', async ev => {
    if (ev.submitter?.value !== 'swap') return
    ev.preventDefault()
    const dlg = $('[data-swap-dialog]'), name = dlg.dataset.sandbox, btn = ev.submitter
    btn.disabled = true
    try {
      await api(`/sandboxes/${encodeURIComponent(name)}/start`, { method: 'POST', body: JSON.stringify({ sleep: new FormData(form).get('sleep') }) })
      dlg.close()
      await loadList(); renderedJSON = null; await showPanel(name)
    } catch (e) { const err = $('[data-swap-error]'); err.textContent = e.message; err.hidden = false } finally { btn.disabled = false }
  })
}
// From the limit page of an asleep app: /?wake=<name>
async function wakeFromLink() {
  const name = new URLSearchParams(location.search).get('wake')
  if (!name) return
  history.replaceState(null, '', location.pathname)
  try { await api(`/sandboxes/${encodeURIComponent(name)}/start`, { method: 'POST' }); await loadList(); await showPanel(name) }
  catch (e) { if (e.body?.reason === 'running' || e.body?.reason === 'room') openSwapDialog(name, e.body.running, e.body.limit); else alert(e.message) }
}

// ---------- tokens ----------
// Sandboxes the signed-in user owns (a token can only be limited to one of those)
async function ownSandboxes() {
  try { return (await api('/sandboxes')).filter(s => (s.owner || 'admin') === me) } catch { return [] }
}

async function openTokenDialog(sandbox) {
  const select = $('[data-token-sandbox]')
  const own = await ownSandboxes()
  select.innerHTML = `<option value="">All my sandboxes</option>` +
    own.map(s => `<option value="${esc(s.name)}">${esc(shortName(s.name))}</option>`).join('')
  select.value = sandbox && own.some(s => s.name === sandbox) ? sandbox : ''
  $('[data-token-error]').hidden = true
  $('[data-token-dialog]').showModal()
}

function initTokenDialog(onCreated) {
  // A page from an older server (or an old cached page) has no token dialog: do not take the rest of the page down with it
  if (!$('[data-token-form]')) return
  $('[data-token-form]').addEventListener('submit', async ev => {
    if (ev.submitter?.value !== 'create') return
    ev.preventDefault()
    const data = Object.fromEntries(new FormData(ev.target))
    if (!data.sandbox) delete data.sandbox
    try {
      const created = await api('/tokens', { method: 'POST', body: JSON.stringify(data) })
      $('[data-token-dialog]').close()
      ev.target.reset()
      $('[data-created-token]').textContent = created.token
      $('[data-created-scope]').textContent = created.sandbox ? ` Works only for sandbox ${shortName(created.sandbox)}.` : ''
      $('[data-download-env]').dataset.sandbox = created.sandbox || ''
      $('[data-copy]').textContent = 'Copy'
      $('[data-token-created]').showModal()
      onCreated?.()
    } catch (e) { const err = $('[data-token-error]'); err.textContent = e.message; err.hidden = false }
  })
  $('[data-copy]').addEventListener('click', async e => {
    await navigator.clipboard.writeText($('[data-created-token]').textContent)
    e.target.textContent = 'Copied'
  })
  // Made here, from the token on screen (the only moment it exists in clear): the server keeps no copy
  $('[data-download-env]').addEventListener('click', e => {
    const sandbox = e.target.dataset.sandbox
    const text = agentEnv({ url: location.origin, token: $('[data-created-token]').textContent, sandbox })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }))
    a.download = 'p9m.env' // a leading-dot name is renamed by browsers (Chrome saves .env as env.txt)
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  })
}

function agentEnv({ url, token, sandbox }) {
  return [
    '# Purgatorium sandbox access for a coding agent. A secret: keep this file out of git.',
    `P9M_URL=${url}`,
    `P9M_TOKEN=${token}`,
    ...(sandbox ? [`P9M_SANDBOX=${sandbox}`] : []),
    'P9M_AGENT_GUIDE=https://csakaszamok.github.io/p9m/latest/agent-guide/index.md',
    '',
  ].join('\n')
}

async function loadTokens() {
  const cols = ['Name', 'Token', ...(isAdmin ? ['Owner'] : []), 'Access', 'Created', 'Expires', 'Last used', '']
  $('[data-token-head]').innerHTML = `<tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr>`
  let list, existing
  // Without the sandbox list (e.g. Docker is down) tokens are still listed and revocable; only "(deleted)" is left out
  try { [list, existing] = await Promise.all([api('/tokens'), api('/sandboxes').catch(() => null)]) } catch (e) { $('[data-token-rows]').innerHTML = `<tr><td class="error">${esc(e.message)}</td></tr>`; return }
  const names = existing && new Set(existing.map(s => s.name))
  const access = t => !t.sandbox ? 'all sandboxes'
    : `${esc(shortName(t.sandbox))}${!names || names.has(t.sandbox) ? '' : ' <span class="muted">(deleted)</span>'}`
  const d = iso => iso ? new Date(iso).toLocaleDateString() : '—'
  $('[data-token-rows]').innerHTML = list.length ? list.map(t => `
    <tr>
      <td>${esc(t.name)}</td>
      <td>${t.hint ? `<code>${esc(t.hint)}</code>` : '<span class="muted">—</span>'}</td>
      ${isAdmin ? `<td>${esc(t.owner)}</td>` : ''}
      <td>${access(t)}</td>
      <td>${d(t.created_at)}</td><td>${t.expires_at ? d(t.expires_at) : 'never'}</td><td>${d(t.last_used_at)}</td>
      <td><button class="danger" data-revoke="${esc(t.id)}">Revoke</button></td>
    </tr>`).join('') : `<tr><td class="muted" colspan="${cols.length}">No tokens yet.</td></tr>`
}

function initTokens() {
  $('[data-new-token]').addEventListener('click', () => openTokenDialog())
  initTokenDialog(loadTokens)
  $('[data-token-rows]').addEventListener('click', async e => {
    const id = e.target.closest('button')?.dataset.revoke
    if (!id || !await confirmDialog('Revoke this token? Agents using it stop working.', 'Revoke')) return
    try { await api(`/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }); loadTokens() } catch (err) { alert(err.message) }
  })
  loadTokens()
}

// ---------- topbar: the server's places, on every page ----------
async function loadPlaces() {
  try {
    const b = P9mPanel.placesBadge((await api('/me')).server_places)
    const el = $('[data-places]')
    el.hidden = !b
    if (b) { el.textContent = b.text; el.title = b.title; el.className = `places ${b.state}` }
  } catch (e) { if (e.message !== 'signed out') console.error(e) }
}
loadPlaces()
setInterval(() => { if (!document.hidden) loadPlaces() }, 10_000)

if (view === 'mine' || view === 'all') initSandboxes()
if (view === 'overview') initOverview()
if (view === 'tokens') initTokens()
if (view === 'ssh-keys') initSshKeys()
