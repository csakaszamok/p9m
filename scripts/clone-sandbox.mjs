#!/usr/bin/env node
// Copies a sandbox: its apps, their data and its files, to a new sandbox on this server or on another one.
// In the Purgatorium container, as the admin (docs: copy-sandbox.md):
//   docker compose exec p9m node /app/scripts/clone-sandbox.mjs pack <sandbox> [--no-consent --reason "..."]
//   docker compose exec p9m node /app/scripts/clone-sandbox.mjs unpack <copy> <new name> [--owner <e-mail>]
// A new sandbox is made for the copy and only its volumes are replaced, so its addresses, certificates, keys and paths
// are its own, for its own name and server.
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const API = process.env.P9M_INTERNAL_API ?? 'http://127.0.0.1:3000'
const COPIES = process.env.P9M_COPIES_DIR ?? '/app/data/copies'
const SANDBOXES = process.env.SANDBOXES_DIR ?? '/opt/sandboxes'
const RUNTIMES = process.env.P9M_RUNTIMES_DIR ?? '/app/runtimes'
// GNU tar: the overlay layers of a sandbox's Docker keep "opaque directory" marks in trusted.* attributes, which only
// it (and CAP_SYS_ADMIN) can carry; without them an image's deleted files can come back
const TAR_IMAGE = 'debian:13-slim'
const TAR_FLAGS = ['--xattrs', "--xattrs-include=*", '--numeric-owner']
const TAR_RUN = ['run', '--rm', '-i', '--network', 'none', '--cap-add', 'SYS_ADMIN']
// A project teleported into the sandbox keeps its secrets here: never copied, as they are never archived
const SECRETS_IN_DOCKER_DATA = './volumes/claude_secrets'

const run = promisify(execFile)
const die = (message, code = 1) => { console.error(`clone-sandbox: ${message}`); process.exit(code) }

async function api(method, url, body) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

async function apiOk(method, url, body) {
  const { status, json } = await api(method, url, body)
  if (status >= 300) die(`${method} ${url}: ${json.error ?? status}`)
  return json
}

const imageIn = text => /^\s*image:\s*["']?(\S*foxglove\S*?)["']?\s*$/m.exec(text)?.[1] ?? null
const sandbox = name => `/sandboxes/${encodeURIComponent(name)}`

/** When the sandbox container last started ('' when it has none): it must not change while its volumes are read or written. */
async function startedAt(name) {
  return run('docker', ['inspect', '-f', '{{.State.StartedAt}}', name]).then(r => r.stdout.trim()).catch(() => '')
}

async function isStopped(name) {
  const running = await run('docker', ['inspect', '-f', '{{.State.Running}}', name]).then(r => r.stdout.trim()).catch(() => 'false')
  return running !== 'true'
}

function packVolume(volume, file, exclude) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const out = fs.createWriteStream(file, { mode: 0o600 })
    const proc = spawn('docker', [...TAR_RUN, '-v', `${volume}:/data:ro`, TAR_IMAGE, 'tar', ...TAR_FLAGS, '-czf', '-', ...exclude.map(e => `--exclude=${e}`), '-C', '/data', '.'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d })
    proc.stdout.on('data', d => hash.update(d))
    proc.stdout.pipe(out)
    proc.on('error', reject)
    proc.on('close', code => out.close(() => code === 0 ? resolve(hash.digest('hex')) : reject(new Error(`volume ${volume}: ${stderr.trim()}`))))
  })
}

/**
 * The script that loads a copied volume: the copy is the source sandbox's, so untrusted. After the extract, character
 * and block devices are dropped except 0:0, the overlay whiteout a Docker's data needs (a real device would reach the
 * host's disks wherever the volume is opened as host root, as under Kata). A failed extract still fails the script.
 */
export function unpackScript() {
  return `set -e; find /data -mindepth 1 -delete; tar ${TAR_FLAGS.map(f => `'${f}'`).join(' ')} -xzf - -C /data; ` +
    `find /data \\( -type b -o -type c \\) -exec sh -c 'for f; do [ "$(stat -c %t:%T "$f")" = 0:0 ] || rm -f "$f"; done' _ {} +`
}

function unpackVolume(volume, file) {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', [...TAR_RUN, '-v', `${volume}:/data`, TAR_IMAGE, 'sh', '-c', unpackScript()], { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d })
    fs.createReadStream(file).pipe(proc.stdin)
    proc.on('error', reject)
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`volume ${volume}: ${stderr.trim()}`)))
  })
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    fs.createReadStream(file).on('data', d => hash.update(d)).on('error', reject).on('end', () => resolve(hash.digest('hex')))
  })
}

function sourceImage(name) {
  for (const owner of fs.readdirSync(SANDBOXES)) {
    const file = path.join(SANDBOXES, owner, name, 'docker-compose.yml')
    if (fs.existsSync(file)) return imageIn(fs.readFileSync(file, 'utf8'))
  }
  return null
}

async function pack(name, opts) {
  const info = await apiOk('GET', sandbox(name))
  const { stdout } = await run('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${name}`])
  const volumes = stdout.split('\n').map(v => v.trim()).filter(Boolean)
  if (!volumes.length) die(`${name} has no volumes`)

  const claim = await api('POST', `${sandbox(name)}/copy-claim`, opts.noConsent ? { no_consent: true, reason: opts.reason } : {})
  if (claim.json.error === 'consent_required') {
    console.error(`The owner (${info.owner}) has to allow this first. Send them this link:\n\n  ${claim.json.url}\n\nThen run this again.`)
    process.exit(3)
  }
  if (claim.status >= 300) die(claim.json.error ?? `copy-claim: ${claim.status}`)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const id = `${name}-${stamp}`
  const dir = path.join(COPIES, id)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

  const wasRunning = info.status === 'running'
  if (wasRunning) { console.log(`Stopping ${name} for the copy...`); await apiOk('POST', `${sandbox(name)}/stop`) }
  if (!await isStopped(name)) die(`${name} is still running`)
  try {
    const before = await startedAt(name)
    const files = []
    for (const volume of volumes) {
      if (!volume.startsWith(`${name}_`)) die(`unexpected volume: ${volume}`)
      const suffix = volume.slice(name.length + 1)
      const file = `${suffix}.tar.gz`
      console.log(`Saving ${suffix}...`)
      const digest = await packVolume(volume, path.join(dir, file), suffix === 'docker_data' ? [SECRETS_IN_DOCKER_DATA] : [])
      files.push({ suffix, file, sha256: digest, size: fs.statSync(path.join(dir, file)).size })
    }
    // A visit to its address wakes it: what was saved may then be half written
    if (!await isStopped(name) || await startedAt(name) !== before) {
      fs.rmSync(dir, { recursive: true, force: true })
      die(`${name} was woken during the copy (a visit to its address does that), so the copy was thrown away. Run this again.`)
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      format: 1, source: name, owner: info.owner, runtime: info.runtime, template: info.template, image: sourceImage(name),
      limits: info.limits ?? null, idle_timeout: info.idle_timeout ?? null, deep_sleep_after: info.deep_sleep_after ?? null,
      copied_at: new Date().toISOString(), via: claim.json.via, secrets_excluded: true, files,
    }, null, 2), { mode: 0o600 })
  } finally {
    if (wasRunning) {
      console.log(`Starting ${name} again...`)
      const { status, json } = await api('POST', `${sandbox(name)}/start`)
      if (status >= 300) console.error(`clone-sandbox: ${name} did not start again: ${json.error ?? status}`)
    }
  }
  console.log(`\nCopy made: ${id}\nOn the host: data/copies/${id} (it holds the sandbox's data and passwords: keep it safe, delete it when done)`)
}

async function unpack(id, newName, opts) {
  if (!/^[a-z0-9][a-z0-9_.:-]*$/i.test(id)) die(`not a copy's name: ${id}`)
  const dir = path.join(COPIES, id)
  const manifestFile = path.join(dir, 'manifest.json')
  if (!fs.existsSync(manifestFile)) die(`no copy at ${dir}`)
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  if (manifest.format !== 1) die(`unknown copy format: ${manifest.format}`)
  for (const f of manifest.files) {
    if (path.basename(f.file) !== f.file || !/^[a-z0-9_-]+$/i.test(f.suffix)) die(`bad file in the copy: ${f.file}`)
    console.log(`Checking ${f.file}...`)
    if (await sha256(path.join(dir, f.file)) !== f.sha256) die(`${f.file} is damaged: copy it over again`)
  }

  // A Docker's data is not portable between the images of a runtime
  const runtimeFile = path.join(RUNTIMES, `${path.basename(manifest.runtime)}.yaml`)
  const image = fs.existsSync(runtimeFile) ? imageIn(fs.readFileSync(runtimeFile, 'utf8')) : null
  if (manifest.image && image && manifest.image !== image) die(`the copy is of image ${manifest.image}, this server makes ${image}: bring both servers to the same Purgatorium version`)

  const m = manifest.limits?.memory
  const created = await apiOk('POST', '/sandboxes', {
    name: newName, owner: opts.owner ?? manifest.owner, runtime: manifest.runtime, template: manifest.template, create_inner_stack: false,
    ...(manifest.limits ? { cpus: manifest.limits.cpus, memory: `${Math.round(m / 1048576)}m` } : {}),
    ...(manifest.idle_timeout ? { idle_timeout: manifest.idle_timeout } : {}),
    ...(manifest.deep_sleep_after ? { deep_sleep_after: manifest.deep_sleep_after } : {}),
  })
  const target = created.name
  console.log(`Made ${target}. Stopping it to load the copy...`)
  await apiOk('POST', `${sandbox(target)}/stop`)
  if (!await isStopped(target)) die(`${target} is still running`)
  const before = await startedAt(target)
  for (const f of manifest.files) {
    console.log(`Loading ${f.suffix}...`)
    await unpackVolume(`${target}_${f.suffix}`, path.join(dir, f.file))
  }
  if (!await isStopped(target) || await startedAt(target) !== before) die(`${target} was woken while the copy was loaded: delete it and run this again`)
  console.log(`\n${target} holds the copy and is stopped. Before it runs, check its apps' settings: they are the source's, and may point at its database or send mail.\nIt starts with the Start button, or when someone opens one of its addresses.`)
}

function parse(argv) {
  const opts = { noConsent: false, reason: '', owner: undefined }, args = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-consent') opts.noConsent = true
    else if (argv[i] === '--reason') opts.reason = argv[++i] ?? ''
    else if (argv[i] === '--owner') opts.owner = argv[++i]
    else if (argv[i].startsWith('--')) die(`unknown option: ${argv[i]}`)
    else args.push(argv[i])
  }
  return { args, opts }
}

const usage = 'usage: clone-sandbox pack <sandbox> [--no-consent --reason "..."] | unpack <copy> <new name> [--owner <e-mail>]'

// Run as a command, not when a test imports it
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const { args: [command, ...rest], opts } = parse(process.argv.slice(2))
  if (!process.env.ADMIN_TOKEN) die('ADMIN_TOKEN is not set: run this in the Purgatorium container')
  if (command === 'pack' && rest.length === 1) {
    if (opts.noConsent && !opts.reason.trim()) die('--no-consent needs --reason "..."')
    await pack(rest[0], opts)
  } else if (command === 'unpack' && rest.length === 2) {
    await unpack(rest[0], rest[1], opts)
  } else die(usage, 2)
}
