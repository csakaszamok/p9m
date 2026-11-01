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
import https from 'node:https'

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
const COOKIE = `${P9M_URL.startsWith('https:') ? '__Host-' : ''}p9m_session`

// A browser session as Purgatorium signs it (services/session.ts): base64url(JSON) "." HMAC-SHA256 in base64url.
// seen: active now, or SESSION_IDLE_TIMEOUT counts it as long idle
const session = (sub, role) => {
  const t = Math.floor(Date.now() / 1000)
  const data = Buffer.from(JSON.stringify({ sub, role, exp: t + 3600, seen: t })).toString('base64url')
  return `${COOKIE}=${data}.${crypto.createHmac('sha256', SECRET).update(data).digest('base64url')}`
}
const adminCookie = session('admin', 'admin')

const times = new Map()
const failures = []
const time = async (step, fn) => {
  const t = performance.now()
  try { return await fn() } finally { (times.get(step) ?? times.set(step, []).get(step)).push(performance.now() - t) }
}
const fail = (who, step, why) => { failures.push(`${who} · ${step}: ${why}`); throw new Error(why) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const json = { 'content-type': 'application/json' }

/** The files of an uncompressed tar (ustar, as services/tar.ts writes it) */
function untar(buf) {
  const files = {}
  for (let o = 0; o + 512 <= buf.length;) {
    const h = buf.subarray(o, o + 512)
    if (h.every(b => b === 0)) break
    const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '')
    const name = [str(345, 500), str(0, 100)].filter(Boolean).join('/')
    const size = parseInt(str(124, 136).trim() || '0', 8)
    files[name] = buf.subarray(o + 512, o + 512 + size).toString('utf8')
    o += 512 + Math.ceil(size / 512) * 512
  }
  return files
}
const envOf = text => Object.fromEntries(text.split('\n').filter(l => /^[A-Z0-9_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))

/** A Docker Engine API call to the sandbox's dockerd (TLS with the project folder's client keys) */
function docker(d, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: d.host, port: d.port, servername: d.host, method, path, ca: d.ca, cert: d.cert, key: d.key, headers: body ? json : {}, timeout: 180_000 }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
    req.end(body ? JSON.stringify(body) : undefined)
  })
}

/** An app's address as GET /sandboxes/:name lists it (no scheme) as a URL without the trailing / */
const appUrl = u => `${/^https?:\/\//.test(u) ? '' : `${new URL(P9M_URL).protocol}//`}${u}`.replace(/\/$/, '')

async function deployApp(d, who, name, labels, hostPort) {
  const create = await docker(d, 'POST', `/containers/create?name=${name}`, {
    Image: 'traefik/whoami:latest', Labels: labels, ExposedPorts: { '80/tcp': {} },
    HostConfig: { PortBindings: { '80/tcp': [{ HostPort: String(hostPort) }] }, RestartPolicy: { Name: 'unless-stopped' } },
  })
  if (create.status !== 201) fail(who, 'deploy', `create ${name}: ${create.status} ${create.text.slice(0, 200)}`)
  const start = await docker(d, 'POST', `/containers/${name}/start`)
  if (start.status !== 204 && start.status !== 304) fail(who, 'deploy', `start ${name}: ${start.status} ${start.text.slice(0, 200)}`)
}

async function user(i) {
  const n = String(i + 1).padStart(2, '0')
  const sub = `burst${RUN}${n}@${USER_DOMAIN}`
  const cookie = session(sub, 'user')
  const state = { sub, cookie }
  try {
    // /p9m:init in Claude Code: no account yet, only a device code
    const code = await time('device code (POST /device/code)', () => fetch(`${P9M_URL}/device/code`, { method: 'POST', headers: json, body: JSON.stringify(TEMPLATE ? { template: TEMPLATE } : {}) }))
    if (code.status !== 200) fail(sub, 'device code', `${code.status} ${(await code.text()).slice(0, 200)}`)
    const device = await code.json()

    // The browser: signed in (single sign-on), approves the code; a new sandbox is made for it
    const approve = await time('approve, sandbox made (POST /activate)', () => fetch(`${P9M_URL}/activate`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, origin: P9M_URL, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: device.user_code, decision: 'approve' }),
    }))
    const page = await approve.text()
    const confirm = page.match(/data-confirm>([^<]+)</)?.[1]
    if (approve.status !== 200 || !confirm) fail(sub, 'approve', `${approve.status} ${approve.headers.get('location') ?? page.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)}`)

    // Claude Code: the confirmation code pasted back, then the project folder
    const token = await time('confirmation code (POST /device/token)', () => fetch(`${P9M_URL}/device/token`, { method: 'POST', headers: json, body: JSON.stringify({ device_code: device.device_code, code: confirm }) }))
    if (token.status !== 200) fail(sub, 'device token', `${token.status} ${(await token.text()).slice(0, 200)}`)
    const granted = await token.json()
    state.full = granted.sandbox
    const tar = await time('project folder (GET /project-dir)', () => fetch(granted.url))
    if (tar.status !== 200) fail(sub, 'project folder', `${tar.status} ${(await tar.text()).slice(0, 200)}`)
    const files = untar(Buffer.from(await tar.arrayBuffer()))
    const envFile = Object.keys(files).find(f => f.endsWith('p9m.env'))
    const env = envOf(files[envFile] ?? '')
    const keys = f => files[Object.keys(files).find(k => k.endsWith(`docker/${f}`))]
    if (!env.P9M_TOKEN || !env.P9M_DOCKER_HOST || !keys('key.pem')) fail(sub, 'project folder', `no token or Docker keys in it (${Object.keys(files).join(', ')})`)
    const api = (path, init = {}) => fetch(`${P9M_URL}${path}`, { ...init, redirect: 'manual', headers: { authorization: `Bearer ${env.P9M_TOKEN}`, ...json, ...(init.headers ?? {}) } })
    state.api = api

    const me = await time('token works (GET /me)', () => api('/me'))
    if (me.status !== 200) fail(sub, 'token', `GET /me ${me.status}`)

    // Claude Code deploys: a public app and an owner-only one, through the sandbox's dockerd
    const dh = new URL(env.P9M_DOCKER_HOST.replace(/^tcp:/, 'https:'))
    const d = { host: dh.hostname, port: Number(dh.port || 443), ca: keys('ca.pem'), cert: keys('cert.pem'), key: keys('key.pem') }
    await time('deploy two apps (Docker API)', async () => {
      const pull = await docker(d, 'POST', '/images/create?fromImage=traefik%2Fwhoami&tag=latest')
      if (pull.status !== 200 || /"error"/.test(pull.text)) fail(sub, 'deploy', `pull: ${pull.status} ${pull.text.slice(-200)}`)
      await deployApp(d, sub, 'web', { 'p9m.subdomain': 'web', 'p9m.access': 'public' }, 8080)
      await deployApp(d, sub, 'own', { 'p9m.subdomain': 'own', 'p9m.access': 'owner' }, 8081)
    })

    const apps = await time('until both apps answer', async () => {
      for (let k = 0; k < 90; k++) {
        const s = await (await api(`/sandboxes/${state.full}`)).json()
        const web = s.apps?.find(a => a.url.includes('-web.')), own = s.apps?.find(a => a.url.includes('-own.'))
        if (s.status === 'running' && web?.answers && own?.answers) return { pub: appUrl(web.url), own: appUrl(own.url) }
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
if (!KEEP) await Promise.all(users.filter(u => u.full).map(u => time('archive (admin)', () => fetch(`${P9M_URL}/sandboxes/${u.full}`, { method: 'DELETE', headers: { cookie: adminCookie, origin: P9M_URL } })).then(async r => {
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
