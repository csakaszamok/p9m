// What the Claude Code scenarios share: a headless Claude Code with the p9m plugin in a new project folder, the
// /p9m:init approval in the browser's place, timed steps, checks, and the clean-up. With a record folder each
// scenario also leaves what video.mjs turns into a demo: every message and tool call with its time, the steps and
// screenshots of the apps. Node 18+, no packages.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { appUrl, sessions } from '../load/first-sign-in.mjs'

export const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../plugins/p9m')
const PLAYWRIGHT = '1.64.1' // the browser for screenshots runs in its image: nothing to install here
const sleep = ms => new Promise(r => setTimeout(r, ms))
const json = { 'content-type': 'application/json' }

/** The settings, from the environment (see run.mjs) */
export function config(env = process.env) {
  const c = {
    p9mUrl: (env.P9M_URL ?? '').replace(/\/$/, ''),
    secret: env.SESSION_SECRET,
    model: env.MODEL || undefined,
    maxBudget: env.MAX_BUDGET ?? '3',
    template: env.TEMPLATE || undefined,
    userDomain: env.USER_DOMAIN ?? 'example.com',
    keep: env.KEEP === '1',
    insecure: env.INSECURE === '1',
    caFile: env.CA_FILE ? path.resolve(env.CA_FILE) : undefined,
    record: env.RECORD ? path.resolve(env.RECORD) : undefined,
  }
  if (!c.p9mUrl || !c.secret) throw new Error('set P9M_URL and SESSION_SECRET')
  return c
}

class StepFailed extends Error {}

/**
 * Runs one scenario: { name, title, files: { path: content }, run: async h => {} }. Returns its steps (name, ok,
 * seconds, why), what Claude Code cost and whether it passed. Never throws for a failed check.
 */
export async function runScenario(scenario, c) {
  if (c.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  const run = crypto.randomBytes(3).toString('hex')
  const session = sessions(c.secret, c.p9mUrl)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p9m-${scenario.name}-`))
  const project = path.join(dir, `${scenario.name}-${run}`)
  fs.mkdirSync(project)
  for (const [f, data] of Object.entries(scenario.files?.({ run }) ?? {})) {
    fs.mkdirSync(path.dirname(path.join(project, f)), { recursive: true })
    fs.writeFileSync(path.join(project, f), data)
  }
  const rec = c.record ? path.join(c.record, scenario.name) : null
  if (rec) { fs.rmSync(rec, { recursive: true, force: true }); fs.mkdirSync(rec, { recursive: true }) }

  // Claude Code's own curl must trust the server: a CA file, or (a local mkcert stack) any certificate, through a
  // .curlrc of its own; the skills stay as users run them
  const env = { ...process.env }
  delete env.NODE_TLS_REJECT_UNAUTHORIZED
  if (c.caFile) env.CURL_CA_BUNDLE = env.SSL_CERT_FILE = c.caFile
  if (c.insecure) {
    fs.mkdirSync(path.join(dir, 'curl'))
    fs.writeFileSync(path.join(dir, 'curl', '.curlrc'), 'insecure\n')
    env.CURL_HOME = path.join(dir, 'curl')
  }

  const t0 = Date.now()
  const steps = []
  const events = [] // { t (ms from start), kind: prompt | text | tool | result | note | step | browser, … }
  const transcripts = []
  const shots = []
  let sessionId, cost = 0, sandbox, token

  const h = {
    run, project, config: c, sub: `${scenario.name}${run}@${c.userDomain}`,
    get sandbox() { return sandbox },
    get token() { return token },
    /** A timed step; a failure (a throw) stops the scenario */
    async step(name, fn) {
      const start = Date.now()
      events.push({ t: start - t0, kind: 'step', name })
      try {
        const r = await fn()
        steps.push({ name, ok: true, s: (Date.now() - start) / 1000 })
        events.push({ t: Date.now() - t0, kind: 'step-done', name, ok: true, s: (Date.now() - start) / 1000 })
        return r
      } catch (err) {
        const why = err instanceof StepFailed ? err.message : `${err.message}`
        steps.push({ name, ok: false, s: (Date.now() - start) / 1000, why })
        events.push({ t: Date.now() - t0, kind: 'step-done', name, ok: false, s: (Date.now() - start) / 1000, why })
        throw new StepFailed(why)
      }
    },
    /** A line the test itself says (shown in the demo): a check's result, the browser's part */
    note(text, kind = 'note') { events.push({ t: Date.now() - t0, kind, text }) },
    fail(why) { throw new StepFailed(why) },

    /** One headless Claude Code turn in the project folder; the next ones resume the same conversation */
    claude(prompt, { budget = c.maxBudget } = {}) {
      events.push({ t: Date.now() - t0, kind: 'prompt', text: prompt })
      const args = ['-p', prompt, '--plugin-dir', PLUGIN, '--output-format', 'stream-json', '--verbose',
        '--permission-mode', 'bypassPermissions', '--max-budget-usd', String(budget)]
      if (c.model) args.push('--model', c.model)
      if (sessionId) args.push('--resume', sessionId)
      return new Promise((resolve, reject) => {
        const child = spawn('claude', args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
        let buf = '', out = '', err = '', result
        child.stdout.on('data', d => {
          out += d; buf += d
          let nl
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
            let m; try { m = JSON.parse(line) } catch { continue }
            const t = Date.now() - t0
            if (m.type === 'assistant') for (const part of m.message?.content ?? []) {
              if (part.type === 'text' && part.text.trim()) events.push({ t, kind: 'text', text: part.text })
              if (part.type === 'tool_use') events.push({ t, kind: 'tool', name: part.name, input: part.input })
            }
            if (m.type === 'user') for (const part of m.message?.content ?? []) {
              if (part.type === 'tool_result') {
                const text = typeof part.content === 'string' ? part.content : (part.content ?? []).map(x => x.text ?? '').join('\n')
                events.push({ t, kind: 'tool-result', text, error: !!part.is_error })
              }
            }
            if (m.type === 'result') result = m
          }
        })
        child.stderr.on('data', d => { err += d })
        const timer = setTimeout(() => child.kill('SIGTERM'), 20 * 60_000)
        child.on('error', reject)
        child.on('close', code => {
          clearTimeout(timer)
          transcripts.push(out, err)
          if (!result) return reject(new StepFailed(`claude exited ${code} without a result: ${(err || out).slice(-400)}`))
          sessionId = result.session_id
          cost += result.total_cost_usd ?? 0
          if (result.is_error) return reject(new StepFailed(`claude: ${result.subtype} ${String(result.result ?? '').slice(0, 400)}`))
          resolve(String(result.result ?? ''))
        })
      })
    },

    /** /p9m:init: the approval link, the browser's approval (a signed-in test user), the code pasted back */
    async init() {
      const asked = await h.step('/p9m:init shows the approval link', () => h.claude(`/p9m:init ${c.p9mUrl}${c.template ? ` --template ${c.template}` : ''}`))
      const userCode = asked.match(/[?&]code=([A-Z]{4}-[A-Z]{4})/)?.[1] ?? asked.match(/\b([B-Z]{4}-[B-Z]{4})\b/)?.[1]
      if (!userCode) h.fail(`no user code in its answer: ${asked.slice(0, 300)}`)
      const confirm = await h.step('approve in the browser (sandbox made)', async () => {
        h.note(`opens ${c.p9mUrl}/activate?code=${userCode}, signed in as ${h.sub}, and approves`, 'browser')
        const r = await fetch(`${c.p9mUrl}/activate`, {
          method: 'POST', redirect: 'manual',
          headers: { cookie: session(h.sub), origin: c.p9mUrl, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ code: userCode, decision: 'approve' }),
        })
        const page = await r.text()
        const code = page.match(/data-confirm>([^<]+)</)?.[1]
        if (r.status !== 200 || !code) h.fail(`${r.status} ${r.headers.get('location') ?? page.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)}`)
        h.note(`the page shows the code ${code}: pasted into Claude Code`, 'browser')
        return code
      })
      await h.step('/p9m:init finishes with the code', () => h.claude(confirm))
      return h.step('.p9m holds a token for the sandbox', async () => {
        const e = h.p9mEnv()
        const missing = ['P9M_TOKEN', 'P9M_SANDBOX', 'P9M_DOCKER_HOST'].filter(k => !e[k])
        if (missing.length) h.fail(`p9m.env lacks ${missing.join(', ')}`)
        for (const f of ['ca.pem', 'cert.pem', 'key.pem']) if (!fs.existsSync(path.join(project, '.p9m', 'docker', f))) h.fail(`no .p9m/docker/${f}`)
        sandbox = e.P9M_SANDBOX; token = e.P9M_TOKEN
        h.note(`.p9m: a token for ${sandbox} and its Docker keys`)
        return e
      })
    },

    p9mEnv() {
      return Object.fromEntries(fs.readFileSync(path.join(project, '.p9m', 'p9m.env'), 'utf8').split('\n')
        .filter(l => /^[A-Z0-9_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
    },
    /** Purgatorium's API with the project's token, as the plugin calls it */
    api(p, init = {}) {
      return fetch(`${c.p9mUrl}${p}`, { ...init, headers: { authorization: `Bearer ${token}`, ...json, ...(init.headers ?? {}) } })
    },
    /** The sandbox's apps that answer (their URLs), waiting up to a minute for at least `count` */
    async apps(count = 1) {
      let apps = []
      for (let i = 0; i < 30; i++) {
        const s = await (await h.api(`/sandboxes/${sandbox}`)).json()
        apps = s.apps ?? []
        if (apps.filter(a => a.answers).length >= count) break
        await sleep(2000)
      }
      const urls = apps.filter(a => a.answers).map(a => appUrl(a.url, c.p9mUrl))
      if (urls.length < count) h.fail(`${urls.length} app(s) answer, ${count} expected (${JSON.stringify(apps).slice(0, 300)})`)
      return urls
    },
    /** The first of urls whose page (path) answers 200 and passes test(body) */
    async findApp(urls, test, p = '/') {
      for (const u of urls) {
        const r = await fetch(`${u}${p}`, { redirect: 'manual' }).catch(() => null)
        if (r?.status === 200 && test(await r.text())) return u
      }
      return null
    },
    /** docker against the sandbox, with the context /p9m:init made (named as the sandbox) */
    docker(...args) {
      return execFileSync('docker', ['--context', sandbox, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
    },
    /** A screenshot of a page for the demo (with a record folder only); the browser runs in Playwright's image */
    async screenshot(url, label) {
      if (!rec) return
      const file = `shot-${shots.length + 1}.png`
      try {
        execFileSync('docker', ['run', '--rm', '--network', 'host', '-v', `${rec}:/out`, `mcr.microsoft.com/playwright:v${PLAYWRIGHT}-noble`,
          'npx', '-y', `playwright@${PLAYWRIGHT}`, 'screenshot', '--ignore-https-errors', '--viewport-size=1280,800', '--wait-for-timeout=1500', url, `/out/${file}`],
        { stdio: 'ignore', timeout: 180_000 })
        shots.push({ file, url, label })
        events.push({ t: Date.now() - t0, kind: 'shot', file, url, label })
      } catch (err) { h.note(`(no screenshot of ${url}: ${err.message.split('\n')[0]})`) }
    },
  }

  try { await scenario.run(h) } catch (err) { if (!(err instanceof StepFailed)) steps.push({ name: 'scenario', ok: false, s: 0, why: err.stack }) }

  // The token must never reach the model: not in its answers, nor in what its tools printed
  if (token) {
    const leaked = transcripts.some(t => t.includes(token))
    steps.push({ name: 'the token is in nothing Claude Code saw', ok: !leaked, s: 0, ...(leaked ? { why: 'the token is in the transcript' } : {}) })
    events.push({ t: Date.now() - t0, kind: 'note', text: leaked ? '✘ the token is in the transcript' : 'the token is in nothing Claude Code saw' })
  }

  const ok = steps.every(s => s.ok)
  const result = { name: scenario.name, title: scenario.title, ok, steps, cost, seconds: (Date.now() - t0) / 1000, sandbox, project, url: c.p9mUrl, date: new Date().toISOString() }
  if (rec) fs.writeFileSync(path.join(rec, 'run.json'), JSON.stringify({ ...result, events, shots }, (k, v) => typeof v === 'string' && token ? v.replaceAll(token, '«token»') : v, 2))

  if (!c.keep) {
    if (sandbox) {
      const r = await fetch(`${c.p9mUrl}/sandboxes/${sandbox}`, { method: 'DELETE', headers: { cookie: session('admin', 'admin'), origin: c.p9mUrl } }).catch(err => ({ status: err.message }))
      if (typeof r.status !== 'number' || r.status >= 300) steps.push({ name: `archive ${sandbox}`, ok: false, s: 0, why: String(r.status) })
      try { execFileSync('docker', ['context', 'rm', '-f', sandbox], { stdio: 'ignore' }) } catch { /* none */ }
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return { ...result, ok: steps.every(s => s.ok) }
}
