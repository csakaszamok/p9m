#!/usr/bin/env node
// Load test for a workshop: USERS people at once, each with their own session (as after single sign-on), each
// creating a sandbox with a public and an owner-only app, using both, checking that the others' owner app is closed
// to them, putting it to sleep and waking it, and archiving it. Prints how long each step took (p50, p95, max).
//
// Needs the server's SESSION_SECRET to sign the users' sessions: run it where that secret is at hand (the server,
// or your machine with it in the environment), never put it in a file in the repository. Node 18+, no packages.
//
//   P9M_URL=https://p9m.demo.example.com SESSION_SECRET=… USERS=20 node tests/load/workshop.mjs
//
// USERS (20), REQUESTS per app (50), USER_DOMAIN for the users' e-mails (example.com: must pass
// OIDC_ALLOWED_DOMAINS / _EMAILS if set), KEEP=1 keeps the sandboxes, INSECURE=1 accepts a self-signed certificate
// (a local lvh.me stack). Watch the server meanwhile: `docker stats --no-stream`, `free -g`, `df -h`.
import crypto from 'node:crypto'

const P9M_URL = (process.env.P9M_URL ?? '').replace(/\/$/, '')
const SECRET = process.env.SESSION_SECRET
const USERS = Number(process.env.USERS ?? 20)
const REQUESTS = Number(process.env.REQUESTS ?? 50)
const USER_DOMAIN = process.env.USER_DOMAIN ?? 'example.com'
const KEEP = process.env.KEEP === '1'
if (!P9M_URL || !SECRET) { console.error('set P9M_URL and SESSION_SECRET'); process.exit(2) }
if (process.env.INSECURE === '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const DOMAIN = new URL(P9M_URL).host.replace(/^p9m\./, '')
const RUN = crypto.randomBytes(2).toString('hex')

// A session as Purgatorium signs it (services/session.ts): base64url(JSON) "." HMAC-SHA256 in base64url
const session = sub => {
  const data = Buffer.from(JSON.stringify({ sub, role: 'user', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')
  return `${data}.${crypto.createHmac('sha256', SECRET).update(data).digest('base64url')}`
}

const times = new Map()
const failures = []
const time = async (step, fn) => {
  const t = performance.now()
  try { return await fn() } finally { (times.get(step) ?? times.set(step, []).get(step)).push(performance.now() - t) }
}
const fail = (who, step, why) => { failures.push(`${who} · ${step}: ${why}`); throw new Error(why) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function user(i) {
  const n = String(i + 1).padStart(2, '0')
  const sub = `load${n}@${USER_DOMAIN}`
  const name = `ld${RUN}${n}`
  const cookie = `${P9M_URL.startsWith('https:') ? '__Host-' : ''}p9m_session=${session(sub)}`
  const api = (path, init = {}) => fetch(`${P9M_URL}${path}`, { ...init, redirect: 'manual', headers: { cookie, origin: P9M_URL, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  const pub = `https://${name}-web.${DOMAIN}`, own = `https://${name}-own.${DOMAIN}`
  const state = { name, own, created: false }
  try {
    const me = await time('sign in (GET /me)', () => api('/me'))
    if (me.status !== 200) fail(sub, 'sign in', `GET /me ${me.status} (is ${USER_DOMAIN} allowed to sign in?)`)

    const compose = `services:
  web:
    image: traefik/whoami:latest
    ports: ["8080:80"]
    labels: { p9m.subdomain: web }
    restart: unless-stopped
  own:
    image: traefik/whoami:latest
    ports: ["8081:80"]
    labels: { p9m.subdomain: own, p9m.access: owner }
    restart: unless-stopped
`
    const created = await time('create sandbox', () => api('/sandboxes', { method: 'POST', body: JSON.stringify({ name, template: 'empty', compose, idle_timeout: '2h' }) }))
    if (created.status >= 300) fail(sub, 'create', `${created.status} ${(await created.text()).slice(0, 200)}`)
    state.created = true
    const full = (await created.json()).name

    await time('until both apps answer', async () => {
      for (let k = 0; k < 90; k++) {
        const s = await (await api(`/sandboxes/${full}`)).json()
        if (s.status === 'running' && s.apps?.length === 2 && s.apps.every(a => a.answers)) return
        await sleep(2000)
      }
      fail(sub, 'ready', 'the apps did not answer within 3 minutes')
    })

    for (let k = 0; k < REQUESTS; k++) {
      const r = await time('public app request', () => fetch(`${pub}/`, { redirect: 'manual' }))
      if (r.status !== 200) fail(sub, 'public app', `status ${r.status}`)
      await r.arrayBuffer()
    }

    // The sign-in hop: app → Purgatorium (signed in) → the app's landing with a ticket → the app cookie
    const appCookie = await time('owner app sign-in hop', async () => {
      const toStart = await fetch(`${own}/x`, { redirect: 'manual' })
      const start = toStart.headers.get('location') ?? ''
      if (!start.startsWith(`${P9M_URL}/auth/app/start?`)) fail(sub, 'hop', `not sent to sign-in (${toStart.status} ${start}) ${(await toStart.text()).slice(0, 120).replace(/s+/g, ' ')}`)
      const toLanding = await fetch(start, { redirect: 'manual', headers: { cookie } })
      const landing = toLanding.headers.get('location') ?? ''
      if (!landing.startsWith(`${own}/__p9m/auth?`)) fail(sub, 'hop', `no ticket (${toLanding.status} ${landing})`)
      const back = await fetch(landing, { redirect: 'manual' })
      const set = back.headers.get('set-cookie') ?? ''
      if (!set.startsWith('__p9m_app=')) fail(sub, 'hop', `no app cookie (${back.status})`)
      return set.split(';')[0]
    })
    for (let k = 0; k < REQUESTS; k++) {
      const r = await time('owner app request (forwardAuth)', () => fetch(`${own}/`, { redirect: 'manual', headers: { cookie: appCookie } }))
      const body = await r.text()
      if (r.status !== 200) fail(sub, 'owner app', `status ${r.status}`)
      if (k === 0 && !new RegExp(`^X-P9m-User: ${sub.replace(/[.]/g, '\\.')}`, 'mi').test(body)) fail(sub, 'owner app', 'the app does not see who is viewing')
      if (k === 0 && /__p9m_app/.test(body)) fail(sub, 'owner app', 'the app sees the app cookie')
    }
    return { ...state, full, api, cookie, sub }
  } catch (err) {
    if (!failures.some(f => f.startsWith(sub))) failures.push(`${sub}: ${err.message}`)
    return { ...state, failed: true, api, sub }
  }
}

async function crossCheck(me, other) {
  if (me.failed || other.failed) return
  const r = await time("someone else's owner app (refused)", () => fetch(`${P9M_URL}/auth/app/start?rd=${encodeURIComponent(`${other.own}/`)}`, { redirect: 'manual', headers: { cookie: me.cookie } }))
  if (r.status !== 403) failures.push(`${me.sub} · cross-user: ${other.own} gave ${r.status}, not 403`)
}

async function sleepAndWake(u) {
  if (u.failed) return
  try {
    const stop = await time('put to sleep', () => u.api(`/sandboxes/${u.full}/stop`, { method: 'POST' }))
    if (stop.status >= 300) fail(u.sub, 'sleep', `status ${stop.status}`)
    await time('wake by a request (until the app answers)', async () => {
      for (let k = 0; k < 60; k++) {
        const r = await fetch(`https://${u.name}-web.${DOMAIN}/`, { redirect: 'manual' })
        const body = await r.text()
        if (r.status === 200 && !body.includes('data-p9m-waiting')) return
        await sleep(1000)
      }
      fail(u.sub, 'wake', 'not awake within 60 s')
    })
  } catch { /* recorded */ }
}

const stat = xs => {
  const s = [...xs].sort((a, b) => a - b), q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] }
}

console.log(`${USERS} users at once against ${P9M_URL} (sandboxes ld${RUN}NN), ${REQUESTS} requests per app`)
const t0 = performance.now()
const users = await Promise.all(Array.from({ length: USERS }, (_, i) => user(i)))
await Promise.all(users.map((u, i) => crossCheck(u, users[(i + 1) % users.length])))
await Promise.all(users.map(sleepAndWake))
if (!KEEP) await Promise.all(users.filter(u => u.created).map(u => time('archive', () => u.api(`/sandboxes/${u.full ?? `p9m-${u.name}`}`, { method: 'DELETE' })).catch(() => {})))

console.log(`\n${'step'.padEnd(46)}${'n'.padStart(6)}${'p50'.padStart(9)}${'p95'.padStart(9)}${'max'.padStart(9)}  (ms)`)
for (const [step, xs] of times) {
  const s = stat(xs)
  console.log(`${step.padEnd(46)}${String(s.n).padStart(6)}${s.p50.toFixed(0).padStart(9)}${s.p95.toFixed(0).padStart(9)}${s.max.toFixed(0).padStart(9)}`)
}
const ok = users.filter(u => !u.failed).length
console.log(`\n${ok}/${USERS} users got through, ${failures.length} failure(s), ${((performance.now() - t0) / 1000).toFixed(0)} s in all${KEEP ? '; sandboxes kept (KEEP=1)' : ''}`)
for (const f of failures) console.log(`  ✘ ${f}`)
process.exit(failures.length ? 1 : 0)
