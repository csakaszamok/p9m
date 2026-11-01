#!/usr/bin/env node
// Soak test: USERS people at once, each with SANDBOXES sandboxes, for MINUTES minutes. Each sandbox is made the way
// /p9m:init makes one (tests/load/first-sign-in.mjs: a device code approved in the browser, the project folder with
// its token and Docker keys) and its app deployed through its dockerd, as Claude Code does. Every sandbox runs a small
// public app that gets RATE requests a second the whole time; every user polls their sandbox list like the UI does;
// every SLEEP_EVERY minutes each sandbox is put to sleep and woken by a request; the admin's pages (all sandboxes, the
// Overview, a sandbox opened) are timed every 10 s. Prints a line a minute (and the
// host's load and memory when run on the server itself), then how long each step took and whether it held.
//
// Needs the server's SESSION_SECRET to sign the users' browser sessions (as tests/load/burst.mjs): run it on the
// server, never put the secret in a file in the repository. Node 18+, no packages (first-sign-in.mjs next to it); on
// a server without Node, soak.sh runs it in a container (sh soak.sh USERS SANDBOXES MINUTES, next to Purgatorium's .env).
//
//   P9M_URL=https://p9m.demo.example.com SESSION_SECRET=… USERS=10 SANDBOXES=3 MINUTES=30 node tests/load/soak.mjs
//
// USERS (10), SANDBOXES per user (2), MINUTES (15), RATE requests a second per sandbox (1), SLEEP_EVERY minutes
// (5; 0 = never), CPUS (0.5) and MEMORY (512m) per sandbox, USER_DOMAIN for the users' e-mails (example.com: must
// pass OIDC_ALLOWED_DOMAINS / _EMAILS if set), TEMPLATE for the sandboxes (the server's default, as /p9m:init), MAX_ERRORS share of failed requests still counted as stable (0.001),
// KEEP=1 keeps the sandboxes, INSECURE=1 accepts a self-signed certificate (a local lvh.me stack).
// The server's limits apply: SANDBOXES above SANDBOX_QUOTA (running at once per user) and USERS × SANDBOXES above
// SANDBOX_MAX_TOTAL are refused, and CPUS / MEMORY must fit SANDBOX_MAX_CPUS / SANDBOX_MAX_MEMORY.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { appUrl, deployApps, firstSignIn, sessions } from './first-sign-in.mjs'

const P9M_URL = (process.env.P9M_URL ?? '').replace(/\/$/, '')
const SECRET = process.env.SESSION_SECRET
const USERS = Number(process.env.USERS ?? 10)
const SANDBOXES = Number(process.env.SANDBOXES ?? 2)
const MINUTES = Number(process.env.MINUTES ?? 15)
const RATE = Number(process.env.RATE ?? 1)
const SLEEP_EVERY = Number(process.env.SLEEP_EVERY ?? 5)
const CPUS = Number(process.env.CPUS ?? 0.5)
const MEMORY = process.env.MEMORY ?? '512m'
const USER_DOMAIN = process.env.USER_DOMAIN ?? 'example.com'
const TEMPLATE = process.env.TEMPLATE || undefined
const MAX_ERRORS = Number(process.env.MAX_ERRORS ?? 0.001)
const KEEP = process.env.KEEP === '1'
if (!P9M_URL || !SECRET) { console.error('set P9M_URL and SESSION_SECRET'); process.exit(2) }
if (process.env.INSECURE === '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const RUN = crypto.randomBytes(2).toString('hex')
const TIMEOUT = 15_000

// A fresh one for each request: a session not used for SESSION_IDLE_TIMEOUT (30 min) ends
const session = sessions(SECRET, P9M_URL)

const times = new Map()
const failures = new Map() // "step: why" → count, so a long run does not print the same failure a thousand times
const minute = { ok: 0, failed: 0, ms: [] }
const record = (step, ms) => (times.get(step) ?? times.set(step, []).get(step)).push(ms)
const failed = (step, why) => { const k = `${step}: ${why}`; failures.set(k, (failures.get(k) ?? 0) + 1); minute.failed++ }
const sleep = ms => new Promise(r => setTimeout(r, ms))
// fetch says only "fetch failed": the reason (a certificate, DNS, a refused connection) is in its cause
const why = err => err.name === 'TimeoutError' ? `no answer within ${TIMEOUT / 1000} s` : [err.message, err.cause?.code ?? err.cause?.message].filter(Boolean).join(': ')
const get = (url, init = {}, timeout = TIMEOUT) => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeout), ...init })
let stopping = false
process.on('SIGINT', () => { if (stopping) process.exit(130); stopping = true; console.log('\nstopping early (Ctrl+C again to quit without archiving)') })

const userOf = i => ({ sub: `soak${RUN}${String(i + 1).padStart(2, '0')}@${USER_DOMAIN}`, sandboxes: [] })
// The admin's requests (the pages it watches, archiving at the end)
const asAdmin = (path, init = {}, timeout) => get(`${P9M_URL}${path}`, { ...init, headers: { cookie: session('admin', 'admin'), origin: P9M_URL, ...(init.headers ?? {}) } }, timeout)

// A sandbox as /p9m:init makes one, its limits set, its app deployed through its dockerd (as Claude Code)
async function create(u) {
  const t = performance.now()
  const sb = { user: u, ready: false }
  try {
    // Making a sandbox takes minutes under load: a longer timeout
    const { api, dockerd } = await firstSignIn({ p9mUrl: P9M_URL, cookie: session(u.sub), template: TEMPLATE, onSandbox: full => { sb.full = full; u.sandboxes.push(sb) } })
    sb.api = api
    const patch = await api(`/sandboxes/${sb.full}`, { method: 'PATCH', body: JSON.stringify({ cpus: CPUS, memory: MEMORY, idle_timeout: '2h' }) }, 120_000)
    if (patch.status >= 300) { failed('create', `limits: ${patch.status} ${(await patch.text()).slice(0, 160)}`); return }
    await deployApps(dockerd, [{ name: 'web', port: 8080, access: 'public' }])
    for (let i = 0; i < 90 && !stopping; i++) {
      // A slow answer is not a failed create: ask again
      const s = await api(`/sandboxes/${sb.full}`).then(r => r.json()).catch(() => ({}))
      const web = s.apps?.find(a => a.url.includes('-web.'))
      if (s.status === 'running' && web?.answers) { sb.url = `${appUrl(web.url, P9M_URL)}/`; sb.ready = true; break }
      await sleep(2000)
    }
    if (sb.ready) record('create (/p9m:init), until the app answers', performance.now() - t)
    else failed('create', 'the app did not answer within 3 minutes')
  } catch (err) { failed('create', why(err)) }
}

// One request to the sandbox's app; the waiting page means the sandbox fell asleep on its own
async function hit(sb, step = 'app request') {
  const t = performance.now()
  try {
    const r = await get(sb.url)
    const body = await r.text()
    if (r.status !== 200) return failed(step, `status ${r.status}`)
    if (body.includes('data-p9m-waiting')) return failed(step, 'asleep (the waiting page)')
    const ms = performance.now() - t
    record(step, ms); minute.ok++; minute.ms.push(ms)
  } catch (err) { failed(step, why(err)) }
}

async function sleepAndWake(sb) {
  try {
    // Stopping waits for the containers: give it as long as a person would
    const t0 = performance.now()
    const stop = await sb.api(`/sandboxes/${sb.full}/stop`, { method: 'POST' }, 120_000)
    if (stop.status >= 300) return failed('put to sleep', `status ${stop.status}`)
    record('put to sleep', performance.now() - t0)
    const t = performance.now()
    for (let i = 0; i < 90; i++) {
      const r = await get(sb.url).catch(() => null)
      const body = r ? await r.text() : ''
      if (r?.status === 200 && !body.includes('data-p9m-waiting')) return record('wake by a request (until the app answers)', performance.now() - t)
      await sleep(1000)
    }
    failed('wake', 'not awake within 90 s')
  } catch (err) { failed('sleep and wake', why(err)) }
}

async function traffic(sb, until) {
  // Each sandbox sleeps at its own moment, not all at once
  let nextSleep = SLEEP_EVERY > 0 ? Date.now() + Math.random() * SLEEP_EVERY * 60_000 : Infinity
  while (!stopping && Date.now() < until) {
    if (Date.now() >= nextSleep) { await sleepAndWake(sb); nextSleep = Date.now() + SLEEP_EVERY * 60_000; continue }
    const t = Date.now()
    await hit(sb)
    await sleep(Math.max(0, 1000 / RATE - (Date.now() - t)))
  }
}

// Claude Code asks for its sandbox now and then (a sandbox's token sees only its own sandbox)
async function poll(u, until) {
  const sb = u.sandboxes.find(s => s.ready)
  while (sb && !stopping && Date.now() < until) {
    const t = performance.now()
    try {
      const r = await sb.api('/sandboxes')
      await r.arrayBuffer()
      if (r.status !== 200) failed('sandbox list (token)', `status ${r.status}`)
      else record('sandbox list (token)', performance.now() - t)
    } catch (err) { failed('sandbox list (token)', why(err)) }
    await sleep(5000)
  }
}

// The admin's pages meanwhile, every 10 s, as the UI asks for them: is Purgatorium still usable for the one watching it?
const ADMIN_STEPS = [
  ['admin: All sandboxes list', () => '/sandboxes'],
  ['admin: Overview (summary)', () => '/sandboxes/summary'],
  ['admin: Overview (users)', () => '/users'],
  ['admin: top bar (/me)', () => '/me'],
  ['admin: a sandbox opened', sb => `/sandboxes/${sb.full}`],
]
async function adminPoll(sandboxes, until) {
  let k = 0
  while (!stopping && Date.now() < until) {
    const sb = sandboxes[k++ % sandboxes.length]
    for (const [step, path] of ADMIN_STEPS) {
      const t = performance.now()
      try {
        const r = await asAdmin(path(sb))
        await r.arrayBuffer()
        if (r.status !== 200) failed(step, `status ${r.status}`)
        else record(step, performance.now() - t)
      } catch (err) { failed(step, why(err)) }
    }
    await sleep(10_000)
  }
}

// The host's load and memory when run on the server (Linux /proc), else nothing
function host() {
  try {
    const load = fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]
    const mem = Object.fromEntries(fs.readFileSync('/proc/meminfo', 'utf8').split('\n').map(l => l.split(/:\s+/)).map(([k, v]) => [k, parseInt(v)]))
    return `  load ${load}, memory ${((mem.MemTotal - mem.MemAvailable) / 1048576).toFixed(1)}/${(mem.MemTotal / 1048576).toFixed(1)} GiB`
  } catch { return '' }
}

const stat = xs => {
  const s = [...xs].sort((a, b) => a - b), q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] }
}

console.log(`${USERS} users × ${SANDBOXES} sandboxes for ${MINUTES} min against ${P9M_URL} (soak${RUN}NN@${USER_DOMAIN}), ${RATE} req/s each, sleep every ${SLEEP_EVERY || '–'} min${host()}`)
const users = Array.from({ length: USERS }, (_, i) => userOf(i))
const me = await asAdmin('/me').catch(err => err)
if (me instanceof Error) { console.error(`cannot reach ${P9M_URL}: ${why(me)}${/CERT|SIGNATURE|ISSUER/.test(why(me)) ? ' (a certificate this container does not trust: INSECURE=1)' : ''}`); process.exit(2) }
if (me.status !== 200) { console.error(`sign in as the admin: ${me.status} (is SESSION_SECRET right?)`); process.exit(2) }

// Users at once, each user's sandboxes one after another (as people run /p9m:init)
const t0 = performance.now()
await Promise.all(users.map(async u => { for (let k = 0; k < SANDBOXES && !stopping; k++) await create(u) }))
const ready = users.flatMap(u => u.sandboxes.filter(s => s.ready))
console.log(`${ready.length}/${USERS * SANDBOXES} sandboxes ready in ${((performance.now() - t0) / 1000).toFixed(0)} s${host()}`)

const start = Date.now(), until = start + MINUTES * 60_000
const ticker = setInterval(() => {
  const s = minute.ms.length ? stat(minute.ms) : null
  const min = ((Date.now() - start) / 60_000).toFixed(0).padStart(3)
  console.log(`${min} min  ${String(minute.ok).padStart(6)} ok  ${String(minute.failed).padStart(4)} failed  p95 ${s ? s.p95.toFixed(0) : '–'} ms${host()}`)
  minute.ok = 0; minute.failed = 0; minute.ms = []
}, 60_000)
if (ready.length) await Promise.all([...ready.map(sb => traffic(sb, until)), ...users.map(u => poll(u, until)), adminPoll(ready, until)])
clearInterval(ticker)

if (!KEEP) {
  console.log('archiving the sandboxes…')
  // A sandbox's token cannot archive it: the admin does
  await Promise.all(users.flatMap(u => u.sandboxes.map(sb =>
    asAdmin(`/sandboxes/${sb.full}`, { method: 'DELETE' }, 600_000).catch(() => {}))))
}

console.log(`\n${'step'.padEnd(46)}${'n'.padStart(8)}${'p50'.padStart(9)}${'p95'.padStart(9)}${'max'.padStart(9)}  (ms)`)
for (const [step, xs] of times) {
  const s = stat(xs)
  console.log(`${step.padEnd(46)}${String(s.n).padStart(8)}${s.p50.toFixed(0).padStart(9)}${s.p95.toFixed(0).padStart(9)}${s.max.toFixed(0).padStart(9)}`)
}
const requests = (times.get('app request') ?? []).length
const requestErrors = [...failures].filter(([k]) => k.startsWith('app request')).reduce((a, [, n]) => a + n, 0)
const otherErrors = [...failures].filter(([k]) => !k.startsWith('app request')).reduce((a, [, n]) => a + n, 0)
const share = requests + requestErrors ? requestErrors / (requests + requestErrors) : 1
const stable = ready.length === USERS * SANDBOXES && share <= MAX_ERRORS && otherErrors === 0
console.log(`\n${ready.length}/${USERS * SANDBOXES} sandboxes ran, ${requestErrors} of ${requests + requestErrors} app requests failed (${(share * 100).toFixed(2)} %), ${otherErrors} other failure(s)`)
for (const [k, n] of failures) console.log(`  ✘ ${k}${n > 1 ? ` (×${n})` : ''}`)
console.log(stable ? '\nSTABLE' : '\nNOT STABLE')
process.exit(stable ? 0 : 1)
