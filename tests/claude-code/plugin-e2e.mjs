#!/usr/bin/env node
// End-to-end test of the Claude Code plugin (plugins/p9m): a headless Claude Code with the plugin loaded does what a
// user asks it, in a new project folder holding a small web app.
//
//   1. `/p9m:init <P9M_URL>`: Claude Code asks for a device code and shows the approval link, then waits.
//   2. The test approves that code in the browser's place (POST /activate, signed in as a test user: the sandbox is
//      made) and resumes the same conversation with the confirmation code the page shows.
//   3. Claude Code unpacks the .p9m folder and sets up the docker context.
//   4. "Deploy this app, public": Claude Code writes the compose file, builds and starts the app in the sandbox.
//   5. The test checks it all itself: .p9m holds a token for the sandbox, the app answers at its address with the
//      page's own marker, and the token never shows in anything Claude Code printed or read (it must not reach
//      the model). Then the admin archives the sandbox and the docker context is removed.
//
// Needs the server's SESSION_SECRET to sign the test user's and the admin's sessions (as tests/load/burst.mjs):
// never put it in a file in the repository. Needs `claude` (signed in, or ANTHROPIC_API_KEY), `docker` with compose,
// `curl` and `tar` on this machine: what a user has. Each run costs a few model calls (MAX_BUDGET caps it).
//
//   P9M_URL=https://p9m.demo.example.com SESSION_SECRET=… node tests/claude-code/plugin-e2e.mjs
//
// MODEL for Claude Code (its default), MAX_BUDGET in USD for each step (2), TEMPLATE for the sandbox (the server's
// default), USER_DOMAIN for the test user's e-mail (example.com: must pass OIDC_ALLOWED_DOMAINS / _EMAILS), KEEP=1
// keeps the sandbox, the folder and the transcripts, CA_FILE: the CA of the server's certificate for Claude Code's
// curl, INSECURE=1 accepts any certificate (a local lvh.me stack with a mkcert certificate).
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { appUrl, sessions } from '../load/first-sign-in.mjs'

const P9M_URL = (process.env.P9M_URL ?? '').replace(/\/$/, '')
const SECRET = process.env.SESSION_SECRET
const MODEL = process.env.MODEL || undefined
const MAX_BUDGET = process.env.MAX_BUDGET ?? '2'
const TEMPLATE = process.env.TEMPLATE || undefined
const USER_DOMAIN = process.env.USER_DOMAIN ?? 'example.com'
const KEEP = process.env.KEEP === '1'
if (!P9M_URL || !SECRET) { console.error('set P9M_URL and SESSION_SECRET'); process.exit(2) }
const INSECURE = process.env.INSECURE === '1'
if (INSECURE) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../plugins/p9m')
const RUN = crypto.randomBytes(3).toString('hex')
const SUB = `plugin${RUN}@${USER_DOMAIN}`
const MARKER = `p9m-plugin-e2e-${RUN}`
const session = sessions(SECRET, P9M_URL)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9m-plugin-e2e-'))
const project = path.join(dir, `shop-${RUN}`)
const transcripts = [] // every line Claude Code printed: the token must be in none

// Claude Code's own curl must trust the server: a CA file, or (a local mkcert stack) any certificate, through a
// .curlrc of its own; the skills stay as users run them
const env = { ...process.env }
delete env.NODE_TLS_REJECT_UNAUTHORIZED
if (process.env.CA_FILE) env.CURL_CA_BUNDLE = env.SSL_CERT_FILE = path.resolve(process.env.CA_FILE)
if (INSECURE) {
  const curlHome = path.join(dir, 'curl')
  fs.mkdirSync(curlHome)
  fs.writeFileSync(path.join(curlHome, '.curlrc'), 'insecure\n')
  env.CURL_HOME = curlHome
}

const steps = []
const failures = []
const step = async (name, fn) => {
  const t = performance.now()
  try {
    const r = await fn()
    steps.push({ name, ok: true, s: (performance.now() - t) / 1000 })
    return r
  } catch (err) {
    steps.push({ name, ok: false, s: (performance.now() - t) / 1000 })
    failures.push(`${name}: ${err.message}`)
    throw err
  }
}

/** One headless Claude Code turn in the project folder; the next ones resume the same conversation */
let sessionId
let cost = 0
function claude(prompt) {
  const args = ['-p', prompt, '--plugin-dir', PLUGIN, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'bypassPermissions', '--max-budget-usd', MAX_BUDGET]
  if (MODEL) args.push('--model', MODEL)
  if (sessionId) args.push('--resume', sessionId)
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    const timer = setTimeout(() => child.kill('SIGTERM'), 15 * 60_000)
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      transcripts.push(out, err)
      if (KEEP) fs.appendFileSync(path.join(dir, 'transcript.jsonl'), out)
      const result = out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(m => m?.type === 'result').pop()
      if (!result) return reject(new Error(`claude exited ${code} without a result: ${(err || out).slice(-400)}`))
      sessionId = result.session_id
      cost += result.total_cost_usd ?? 0
      if (result.is_error) return reject(new Error(`claude: ${result.subtype} ${String(result.result ?? '').slice(0, 400)}`))
      resolve(String(result.result ?? ''))
    })
  })
}

const p9mEnv = () => Object.fromEntries(fs.readFileSync(path.join(project, '.p9m', 'p9m.env'), 'utf8').split('\n')
  .filter(l => /^[A-Z0-9_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const sleep = ms => new Promise(r => setTimeout(r, ms))

// A small app as a user has it: a page and a Dockerfile, no compose file (Claude Code writes that)
fs.mkdirSync(project)
fs.writeFileSync(path.join(project, 'index.html'), `<!doctype html>\n<title>Shop</title>\n<h1>Our shop</h1>\n<p id="marker">${MARKER}</p>\n`)
fs.writeFileSync(path.join(project, 'Dockerfile'), 'FROM nginx:alpine\nCOPY index.html /usr/share/nginx/html/index.html\nEXPOSE 80\n')
fs.writeFileSync(path.join(project, 'README.md'), '# Shop\n\nA one-page shop site, served by nginx on port 80.\n')

console.log(`Claude Code with the p9m plugin (${PLUGIN}) against ${P9M_URL}, as ${SUB}, in ${project}`)
let sandbox
try {
  // 1. /p9m:init: Claude Code shows the approval link with the user code and stops
  const asked = await step('/p9m:init shows the approval link', () => claude(`/p9m:init ${P9M_URL}${TEMPLATE ? ` --template ${TEMPLATE}` : ''}`))
  const userCode = asked.match(/[?&]code=([A-Z]{4}-[A-Z]{4})/)?.[1] ?? asked.match(/\b([B-Z]{4}-[B-Z]{4})\b/)?.[1]
  if (!userCode) { failures.push(`/p9m:init: no user code in its answer: ${asked.slice(0, 400)}`); throw new Error('no user code') }

  // 2. The browser's part: signed in, approve; the page shows the confirmation code
  const confirm = await step('approve in the browser (POST /activate)', async () => {
    const r = await fetch(`${P9M_URL}/activate`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: session(SUB), origin: P9M_URL, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: userCode, decision: 'approve' }),
    })
    const page = await r.text()
    const c = page.match(/data-confirm>([^<]+)</)?.[1]
    if (r.status !== 200 || !c) throw new Error(`${r.status} ${r.headers.get('location') ?? page.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)}`)
    return c
  })

  // 3. The code pasted back: Claude Code unpacks .p9m and sets up the docker context
  await step('/p9m:init finishes with the code', () => claude(confirm))
  const p9m = await step('.p9m holds a token for the sandbox', async () => {
    const e = p9mEnv()
    if (!e.P9M_TOKEN || !e.P9M_SANDBOX || !e.P9M_DOCKER_HOST) throw new Error(`p9m.env lacks ${['P9M_TOKEN', 'P9M_SANDBOX', 'P9M_DOCKER_HOST'].filter(k => !e[k]).join(', ')}`)
    for (const f of ['ca.pem', 'cert.pem', 'key.pem']) if (!fs.existsSync(path.join(project, '.p9m', 'docker', f))) throw new Error(`no .p9m/docker/${f}`)
    if (fs.readFileSync(path.join(project, '.p9m', '.gitignore'), 'utf8').trim() !== '*') throw new Error('.p9m/.gitignore is not a single *')
    sandbox = e.P9M_SANDBOX
    return e
  })
  const api = p => fetch(`${P9M_URL}${p}`, { headers: { authorization: `Bearer ${p9m.P9M_TOKEN}` } })

  // 4. The user's request in plain words
  await step('"deploy this app" builds and starts it', () => claude('Deploy this app to my Purgatorium sandbox. Anyone with the link may open it (public).'))

  // 5. Checked by the test itself: listed, answering, the page's own content at its address
  await step('the app answers at its address', async () => {
    let apps = []
    for (let i = 0; i < 30; i++) {
      const s = await (await api(`/sandboxes/${sandbox}`)).json()
      apps = s.apps ?? []
      if (apps.some(a => a.answers)) break
      await sleep(2000)
    }
    const urls = apps.filter(a => a.answers).map(a => appUrl(a.url, P9M_URL))
    if (!urls.length) throw new Error(`no app answers (${JSON.stringify(apps).slice(0, 300)})`)
    for (const u of urls) {
      const r = await fetch(`${u}/`, { redirect: 'manual' })
      if (r.status === 200 && (await r.text()).includes(MARKER)) return u
    }
    throw new Error(`none of ${urls.join(', ')} serves the page (not public, or not this app)`)
  }).then(u => console.log(`  the app: ${u}`))
} catch { /* recorded */ }

// The token must never reach the model: not in its answers, nor in what its tools printed
try {
  const token = p9mEnv().P9M_TOKEN
  await step('the token is in nothing Claude Code saw', async () => {
    if (token && transcripts.some(t => t.includes(token))) throw new Error('the token is in the transcript')
  })
} catch { /* no .p9m, or recorded */ }

if (!KEEP) {
  if (sandbox) {
    const r = await fetch(`${P9M_URL}/sandboxes/${sandbox}`, { method: 'DELETE', headers: { cookie: session('admin', 'admin'), origin: P9M_URL } }).catch(err => ({ status: err.message }))
    if (r.status >= 300 || typeof r.status !== 'number') failures.push(`archive ${sandbox}: ${r.status}`)
    // The context the skill made: named after the sandbox as its user knows it
    try { execFileSync('docker', ['context', 'rm', '-f', sandbox], { stdio: 'ignore' }) } catch { /* none */ }
  }
  fs.rmSync(dir, { recursive: true, force: true })
} else console.log(`kept: ${project}, the sandbox ${sandbox ?? '–'}, transcript ${path.join(dir, 'transcript.jsonl')}`)

console.log()
for (const s of steps) console.log(`${s.ok ? '✔' : '✘'} ${s.name.padEnd(46)} ${s.s.toFixed(0).padStart(5)} s`)
console.log(`\n${failures.length ? 'FAILED' : 'PASSED'}${cost ? ` (Claude Code: $${cost.toFixed(2)})` : ''}`)
for (const f of failures) console.log(`  ✘ ${f}`)
process.exit(failures.length ? 1 : 0)
