#!/usr/bin/env node
// Burst load test: USERS people sign in for the first time at once and do what /p9m:init does for each, then use
// their sandbox. Each one: starts a device approval (POST /device/code, as Claude Code), approves it in the browser
// (POST /activate: this creates the sandbox), hands in the confirmation code (POST /device/token), downloads the
// project folder (its token and Docker keys), deploys a public and an owner-only app through the sandbox's dockerd
// (as Claude Code's `docker compose up`), uses both, checks that someone else's owner app is closed to them, puts
// the sandbox to sleep and wakes it with a request. Then the admin archives the sandboxes. Prints how long each step
// took (p50, p95, max). Run from one machine, every request comes from one IP: as many people behind one NAT.
//
// Needs the server's SESSION_SECRET to sign the browser sessions (as after single sign-on): run it where that secret
// is at hand (the server, or your machine with it in the environment), never put it in a file in the repository.
// Node 18+, no packages.
//
//   P9M_URL=https://p9m.demo.example.com SESSION_SECRET=… USERS=20 node tests/load/burst.mjs
//
// USERS (20), REQUESTS per app (50), TEMPLATE for the sandboxes (the server's default, as /p9m:init), USER_DOMAIN for
// the users' e-mails (example.com: must pass OIDC_ALLOWED_DOMAINS / _EMAILS), KEEP=1 keeps the sandboxes,
// INSECURE=1 accepts a self-signed certificate (a local lvh.me stack). The server's limits apply: USERS above
// SANDBOX_MAX_TOTAL are refused. Watch the server meanwhile: `docker stats --no-stream`, `free -g`, `df -h`.
import crypto from 'node:crypto'
import { appUrl, deployApps, firstSignIn, sessions } from './first-sign-in.mjs'

const P9M_URL = (process.env.P9M_URL ?? '').replace(/\/$/, '')
const SECRET = process.env.SESSION_SECRET
const USERS = Number(process.env.USERS ?? 20)
const REQUESTS = Number(process.env.REQUESTS ?? 50)
const TEMPLATE = process.env.TEMPLATE || undefined
const USER_DOMAIN = process.env.USER_DOMAIN ?? 'example.com'
const KEEP = process.env.KEEP === '1'
if (!P9M_URL || !SECRET) { console.error('set P9M_URL and SESSION_SECRET'); process.exit(2) }
if (process.env.INSECURE === '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const RUN = crypto.randomBytes(2).toString('hex')
const session = sessions(SECRET, P9M_URL)

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
  const sub = `burst${RUN}${n}@${USER_DOMAIN}`
  const cookie = session(sub)
  const state = { sub, cookie }
  try {
    // /p9m:init: a device code, approved in the browser (signed in by single sign-on: the sandbox is made), the
    // confirmation code pasted back into Claude Code, the project folder with the token and the Docker keys
    const { api, dockerd } = await firstSignIn({ p9mUrl: P9M_URL, cookie, template: TEMPLATE, step: time, onSandbox: full => { state.full = full } })
      .catch(err => fail(sub, 'first sign-in', err.message))
    state.api = api

    const me = await time('token works (GET /me)', () => api('/me'))
    if (me.status !== 200) fail(sub, 'token', `GET /me ${me.status}`)

    // Claude Code deploys: a public app and an owner-only one, through the sandbox's dockerd
    await time('deploy two apps (Docker API)', () => deployApps(dockerd, [{ name: 'web', port: 8080, access: 'public' }, { name: 'own', port: 8081, access: 'owner' }]))
      .catch(err => fail(sub, 'deploy', err.message))

    const apps = await time('until both apps answer', async () => {
      for (let k = 0; k < 90; k++) {
        const s = await (await api(`/sandboxes/${state.full}`)).json()
        const web = s.apps?.find(a => a.url.includes('-web.')), own = s.apps?.find(a => a.url.includes('-own.'))
        if (s.status === 'running' && web?.answers && own?.answers) return { pub: appUrl(web.url, P9M_URL), own: appUrl(own.url, P9M_URL) }
        await sleep(2000)
      }
      fail(sub, 'ready', 'the apps did not answer within 3 minutes')
    })
    Object.assign(state, apps)

    for (let k = 0; k < REQUESTS; k++) {
      const r = await time('public app request', () => fetch(`${apps.pub}/`, { redirect: 'manual' }))
      if (r.status !== 200) fail(sub, 'public app', `status ${r.status}`)
      await r.arrayBuffer()
    }

    // The sign-in hop: app → Purgatorium (signed in) → the app's landing with a ticket → the app cookie
    const appCookie = await time('owner app sign-in hop', async () => {
      const toStart = await fetch(`${apps.own}/x`, { redirect: 'manual' })
      const start = toStart.headers.get('location') ?? ''
      if (!start.includes('/auth/app/start?')) fail(sub, 'hop', `not sent to sign-in (${toStart.status} ${start})`)
      const toLanding = await fetch(new URL(start, apps.own), { redirect: 'manual', headers: { cookie } })
      const landing = toLanding.headers.get('location') ?? ''
      if (!landing.startsWith(`${apps.own}/__p9m/auth?`)) fail(sub, 'hop', `no ticket (${toLanding.status} ${landing})`)
      const back = await fetch(landing, { redirect: 'manual' })
      const set = back.headers.get('set-cookie') ?? ''
      if (!set.startsWith('__p9m_app=')) fail(sub, 'hop', `no app cookie (${back.status})`)
      return set.split(';')[0]
    })
    for (let k = 0; k < REQUESTS; k++) {
      const r = await time('owner app request (forwardAuth)', () => fetch(`${apps.own}/`, { redirect: 'manual', headers: { cookie: appCookie } }))
      const body = await r.text()
      if (r.status !== 200) fail(sub, 'owner app', `status ${r.status}`)
      if (k === 0 && !new RegExp(`^X-P9m-User: ${sub.replace(/[.]/g, '\\.')}`, 'mi').test(body)) fail(sub, 'owner app', 'the app does not see who is viewing')
      if (k === 0 && /__p9m_app/.test(body)) fail(sub, 'owner app', 'the app sees the app cookie')
    }
    return state
  } catch (err) {
    if (!failures.some(f => f.startsWith(sub))) failures.push(`${sub}: ${err.message}`)
    return { ...state, failed: true }
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
        const r = await fetch(`${u.pub}/`, { redirect: 'manual' })
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

console.log(`${USERS} users sign in for the first time at once against ${P9M_URL} (burst${RUN}NN@${USER_DOMAIN}), ${REQUESTS} requests per app`)
const t0 = performance.now()
const users = await Promise.all(Array.from({ length: USERS }, (_, i) => user(i)))
await Promise.all(users.map((u, i) => crossCheck(u, users[(i + 1) % users.length])))
await Promise.all(users.map(sleepAndWake))
// A user's token cannot archive (it is the sandbox's): the admin does
if (!KEEP) await Promise.all(users.filter(u => u.full).map(u => time('archive (admin)', () => fetch(`${P9M_URL}/sandboxes/${u.full}`, { method: 'DELETE', headers: { cookie: session('admin', 'admin'), origin: P9M_URL } })).then(async r => {
  if (r.status >= 300) failures.push(`${u.sub} · archive: ${r.status} ${(await r.text()).slice(0, 120)}`)
}).catch(err => failures.push(`${u.sub} · archive: ${err.message}`))))

console.log(`\n${'step'.padEnd(46)}${'n'.padStart(6)}${'p50'.padStart(9)}${'p95'.padStart(9)}${'max'.padStart(9)}  (ms)`)
for (const [step, xs] of times) {
  const s = stat(xs)
  console.log(`${step.padEnd(46)}${String(s.n).padStart(6)}${s.p50.toFixed(0).padStart(9)}${s.p95.toFixed(0).padStart(9)}${s.max.toFixed(0).padStart(9)}`)
}
const ok = users.filter(u => !u.failed).length
console.log(`\n${ok}/${USERS} users got through, ${failures.length} failure(s), ${((performance.now() - t0) / 1000).toFixed(0)} s in all${KEEP ? '; sandboxes kept (KEEP=1)' : ''}`)
for (const f of failures) console.log(`  ✘ ${f}`)
process.exit(failures.length ? 1 : 0)
