#!/usr/bin/env node
// Packs one compose project of a sandbox so that it runs on a plain Docker, without Purgatorium. In the Purgatorium
// container, as the admin (docs: export-app.md):
//   docker compose exec p9m node /app/scripts/export-app.mjs <sandbox> <project> [--stop] [--no-consent --reason "..."]
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import yaml from 'js-yaml'
import { composeFromInspect } from './export-compose.mjs'

const API = process.env.P9M_INTERNAL_API ?? 'http://127.0.0.1:3000'
const EXPORTS = process.env.P9M_EXPORTS_DIR ?? '/app/data/exports'
const ROOT = path.dirname(new URL(import.meta.url).pathname)
const run = promisify(execFile)
const die = (message, code = 1) => { console.error(`export-app: ${message}`); process.exit(code) }

async function api(method, url, body) {
  const res = await fetch(`${API}${url}`, { method, headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

const big = { maxBuffer: 256 * 1024 * 1024 }
/** A command in the sandbox's own Docker. */
const inner = async (sb, ...args) => (await run('docker', ['exec', sb, 'docker', ...args], big)).stdout

/** The output of a command in the sandbox, into a file: its checksum for SHA256SUMS. */
function saveOutput(file, args, gzip = false) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256'), out = fs.createWriteStream(file, { mode: 0o600 })
    const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const zip = gzip ? spawn('gzip', ['-c'], { stdio: ['pipe', 'pipe', 'inherit'] }) : null
    const source = zip ? zip.stdout : proc.stdout
    if (zip) proc.stdout.pipe(zip.stdin)
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d })
    source.on('data', d => hash.update(d))
    source.pipe(out)
    proc.on('error', reject)
    // Whichever comes first: the file closed, or the command's exit code
    const closed = Promise.all([new Promise(r => out.on('close', r)), new Promise(r => proc.on('close', r)), zip ? new Promise(r => zip.on('close', r)) : 0])
    closed.then(([, code, zipped]) => code === 0 && (zipped === 0 || !zip) ? resolve(hash.digest('hex')) : reject(new Error(stderr.trim() || `exit ${code}`)))
  })
}

const README = (project, sandbox, warnings) => `# ${project}

Exported from the sandbox ${sandbox}, to run on a plain Docker with the compose plugin.

    ./restore.sh

That checks the files, loads the images and the data, and starts the app. It stops if the app's volumes exist already;
FORCE=1 ./restore.sh replaces them. With DOCKER_CONTEXT set it goes to that Docker (not with bind-mounted folders).

## Before you run it

- Nothing guards the app here. Its published ports are open to everyone who can reach this machine, without HTTPS or a
  sign-in: put a reverse proxy in front of it.
- An app that used the X-P9m-User header to know its visitor needs a sign-in of its own: on an open port anyone can send
  that header.
- env/*.env hold the app's settings, passwords too. Check them: they may point at the sandbox's database or addresses.
- compose.yaml is made from what the containers ran. It has no build sections: it runs the images in images.tar.gz.
- The images are for the processor they were built on.
${warnings.length ? `\n## Read this\n\n${warnings.map(w => `- ${w}`).join('\n')}\n` : ''}`

async function main() {
  const { args, opts } = parse(process.argv.slice(2))
  if (args.length !== 2) die('usage: export-app <sandbox> <project> [--stop] [--no-consent --reason "..."]', 2)
  const [sandbox, project] = args
  if (!process.env.ADMIN_TOKEN) die('ADMIN_TOKEN is not set: run this in the Purgatorium container')
  if (opts.noConsent && !opts.reason.trim()) die('--no-consent needs --reason "..."')
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) die(`not a compose project's name: ${project}`)

  const url = `/sandboxes/${encodeURIComponent(sandbox)}`
  const info = await api('GET', url)
  if (info.status >= 300) die(info.json.error ?? `${sandbox}: ${info.status}`)
  if (info.json.status !== 'running') die(`${sandbox} is ${info.json.status}: wake it first`)

  const ids = (await inner(sandbox, 'ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`)).split('\n').filter(Boolean)
  if (!ids.length) {
    const all = (await inner(sandbox, 'ps', '-a', '--format', '{{.Label "com.docker.compose.project"}}')).split('\n').filter(Boolean)
    die(`no compose project ${project} in ${sandbox}. Its projects: ${[...new Set(all)].join(', ') || 'none'}`)
  }

  const claim = await api('POST', `${url}/copy-claim`, { what: `export of ${project}`, ...(opts.noConsent ? { no_consent: true, reason: opts.reason } : {}) })
  if (claim.json.error === 'consent_required') {
    console.error(`The owner (${info.json.owner}) has to allow this first. Send them this link:\n\n  ${claim.json.url}\n\nThen run this again.`)
    process.exit(3)
  }
  if (claim.status >= 300) die(claim.json.error ?? `copy-claim: ${claim.status}`)

  const containers = JSON.parse(await inner(sandbox, 'inspect', ...ids))
  const names = [...new Set(containers.map(c => c.Config.Image))]
  const images = {}
  for (const n of names) images[n] = JSON.parse(await inner(sandbox, 'image', 'inspect', n))[0]
  const isDir = {}
  for (const c of containers) for (const m of c.Mounts ?? []) {
    if (m.Type === 'bind') isDir[m.Source] = await run('docker', ['exec', sandbox, 'test', '-d', m.Source]).then(() => true, () => false)
  }
  const model = composeFromInspect({ project, containers, images, isDir })

  const id = `${sandbox}-${project}-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const dir = path.join(EXPORTS, id)
  for (const d of ['', 'env', 'volumes', 'binds']) fs.mkdirSync(path.join(dir, d), { recursive: true, mode: 0o700 })
  const sums = []
  const keepAwake = () => api('POST', `${url}/keep-awake`).catch(() => {})

  fs.writeFileSync(path.join(dir, 'compose.yaml'), yaml.dump(model.compose, { lineWidth: -1, noRefs: true }), { mode: 0o600 })
  for (const [service, text] of Object.entries(model.envFiles)) fs.writeFileSync(path.join(dir, 'env', `${service}.env`), text, { mode: 0o600 })

  const running = (await inner(sandbox, 'ps', '-q', '--filter', `label=com.docker.compose.project=${project}`)).split('\n').filter(Boolean)
  if (!opts.stop && running.length && (model.volumes.length || model.binds.length)) console.warn('The app keeps running: a database\'s files copied now may not be consistent. --stop stops it for the copy.')
  if (opts.stop && running.length) { console.log(`Stopping ${project}...`); await inner(sandbox, 'stop', ...running) }
  try {
    console.log('Saving the images...')
    await keepAwake()
    sums.push([await saveOutput(path.join(dir, 'images.tar.gz'), ['exec', sandbox, 'docker', 'save', ...model.images], true), 'images.tar.gz'])
    for (const volume of model.volumes) {
      console.log(`Saving volume ${volume}...`)
      await keepAwake()
      sums.push([await saveOutput(path.join(dir, 'volumes', `${volume}.tar.gz`), ['exec', sandbox, 'tar', 'czf', '-', '-C', `/var/lib/docker/volumes/${volume}/_data`, '.']), `volumes/${volume}.tar.gz`])
    }
    for (const b of model.binds) {
      console.log(`Saving folder ${b.source}...`)
      await keepAwake()
      if (b.dir) {
        sums.push([await saveOutput(path.join(dir, 'binds', `${b.n}.tar.gz`), ['exec', sandbox, 'tar', 'czf', '-', '-C', b.source, '.']), `binds/${b.n}.tar.gz`])
      } else {
        fs.mkdirSync(path.join(dir, 'binds', String(b.n)), { mode: 0o700 })
        sums.push([await saveOutput(path.join(dir, 'binds', String(b.n), 'file'), ['exec', sandbox, 'cat', b.source]), `binds/${b.n}/file`])
      }
    }
  } finally {
    if (opts.stop && running.length) { console.log(`Starting ${project} again...`); await inner(sandbox, 'start', ...running).catch(err => console.error(`export-app: ${project} did not start again: ${err.message}`)) }
  }

  const arch = (await inner(sandbox, 'version', '--format', '{{.Server.Arch}}')).trim()
  const restore = fs.readFileSync(path.join(ROOT, 'export-restore.sh'), 'utf8').replace(/^PROJECT=.*$/m, `PROJECT=${project}`).replace(/^ARCH=.*$/m, `ARCH=${/^[a-z0-9_]+$/.test(arch) ? arch : ''}`)
  fs.writeFileSync(path.join(dir, 'restore.sh'), restore, { mode: 0o700 })
  fs.writeFileSync(path.join(dir, 'README.md'), README(project, sandbox, model.warnings), { mode: 0o600 })
  fs.writeFileSync(path.join(dir, 'WARNINGS.txt'), model.warnings.map(w => `${w}\n`).join(''), { mode: 0o600 })
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sums.map(([h, f]) => `${h}  ${f}\n`).join(''), { mode: 0o600 })
  for (const w of model.warnings) console.warn(`Note: ${w}`)
  console.log(`\nExported: ${id}\nOn the host: data/exports/${id} (it holds the app's data and passwords: keep it safe, delete it when done)`)
}

function parse(argv) {
  const opts = { stop: false, noConsent: false, reason: '' }, args = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--stop') opts.stop = true
    else if (argv[i] === '--no-consent') opts.noConsent = true
    else if (argv[i] === '--reason') opts.reason = argv[++i] ?? ''
    else if (argv[i].startsWith('--')) die(`unknown option: ${argv[i]}`)
    else args.push(argv[i])
  }
  return { args, opts }
}

await main().catch(err => die(err.message))
