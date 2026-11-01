// What the load tests share: a first sign-in the way /p9m:init does it, and deploying apps through a sandbox's
// dockerd the way Claude Code does. Node 18+, no packages.
import crypto from 'node:crypto'
import https from 'node:https'

const json = { 'content-type': 'application/json' }

/**
 * Browser sessions as Purgatorium signs them (services/session.ts): base64url(JSON) "." HMAC-SHA256 in base64url,
 * as the cookie header's part. seen is now: a session not used for SESSION_IDLE_TIMEOUT (30 min) ends, so sign a
 * fresh one for each request of a long run.
 */
export function sessions(secret, p9mUrl) {
  const name = `${p9mUrl.startsWith('https:') ? '__Host-' : ''}p9m_session`
  return (sub, role = 'user') => {
    const t = Math.floor(Date.now() / 1000)
    const data = Buffer.from(JSON.stringify({ sub, role, exp: t + 3600, seen: t })).toString('base64url')
    return `${name}=${data}.${crypto.createHmac('sha256', secret).update(data).digest('base64url')}`
  }
}

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

/** An app's address as GET /sandboxes/:name lists it (no scheme) as a URL without the trailing / */
export const appUrl = (u, p9mUrl) => `${/^https?:\/\//.test(u) ? '' : `${new URL(p9mUrl).protocol}//`}${u}`.replace(/\/$/, '')

const short = async r => `${r.status} ${(await r.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)}`

/**
 * One person's first sign-in for a new sandbox, as /p9m:init: a device code (Claude Code), approving it in the browser
 * signed in with cookie (the sandbox is made), the confirmation code handed in, the project folder downloaded.
 * step(name, fn) times each part; onSandbox(name) learns the sandbox as soon as it is known (to archive it after a failure). Returns the sandbox's full name, its token, an API caller with that token and
 * the sandbox's dockerd (address and client keys); throws why it failed.
 */
export async function firstSignIn({ p9mUrl, cookie, template, step = (_, fn) => fn(), onSandbox = () => {}, timeout = 300_000 }) {
  const code = await step('device code (POST /device/code)', () => fetch(`${p9mUrl}/device/code`, { method: 'POST', headers: json, body: JSON.stringify(template ? { template } : {}), signal: AbortSignal.timeout(timeout) }))
  if (code.status !== 200) throw new Error(`device code: ${await short(code)}`)
  const device = await code.json()

  const approve = await step('approve, sandbox made (POST /activate)', () => fetch(`${p9mUrl}/activate`, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeout),
    headers: { cookie, origin: p9mUrl, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: device.user_code, decision: 'approve' }),
  }))
  const page = await approve.text()
  const confirm = page.match(/data-confirm>([^<]+)</)?.[1]
  if (approve.status !== 200 || !confirm) throw new Error(`approve: ${approve.status} ${approve.headers.get('location') ?? page.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)}`)

  const token = await step('confirmation code (POST /device/token)', () => fetch(`${p9mUrl}/device/token`, { method: 'POST', headers: json, body: JSON.stringify({ device_code: device.device_code, code: confirm }), signal: AbortSignal.timeout(timeout) }))
  if (token.status !== 200) throw new Error(`device token: ${await short(token)}`)
  const granted = await token.json()
  onSandbox(granted.sandbox)
  const tar = await step('project folder (GET /project-dir)', () => fetch(granted.url, { signal: AbortSignal.timeout(timeout) }))
  if (tar.status !== 200) throw new Error(`project folder: ${await short(tar)}`)
  const files = untar(Buffer.from(await tar.arrayBuffer()))
  const file = end => files[Object.keys(files).find(k => k.endsWith(end))]
  const env = envOf(file('p9m.env') ?? '')
  if (!env.P9M_TOKEN || !env.P9M_DOCKER_HOST || !file('docker/key.pem')) throw new Error(`project folder: no token or Docker keys in it (${Object.keys(files).join(', ')})`)

  const api = (path, init = {}, ms = 15_000) => fetch(`${p9mUrl}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(ms), ...init, headers: { authorization: `Bearer ${env.P9M_TOKEN}`, ...json, ...(init.headers ?? {}) } })
  const dh = new URL(env.P9M_DOCKER_HOST.replace(/^tcp:/, 'https:'))
  const dockerd = { host: dh.hostname, port: Number(dh.port || 443), ca: file('docker/ca.pem'), cert: file('docker/cert.pem'), key: file('docker/key.pem') }
  return { full: granted.sandbox, token: env.P9M_TOKEN, api, dockerd }
}

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

/**
 * traefik/whoami apps in the sandbox, as Claude Code's `docker compose up` would start them: each { name, port,
 * access }, published on port, named <sandbox>-<name> (p9m.subdomain). Apps are owner-only unless labelled otherwise.
 */
export async function deployApps(d, apps) {
  const pull = await docker(d, 'POST', '/images/create?fromImage=traefik%2Fwhoami&tag=latest')
  if (pull.status !== 200 || /"error"/.test(pull.text)) throw new Error(`pull: ${pull.status} ${pull.text.slice(-200)}`)
  for (const { name, port, access } of apps) {
    const create = await docker(d, 'POST', `/containers/create?name=${name}`, {
      Image: 'traefik/whoami:latest', Labels: { 'p9m.subdomain': name, 'p9m.access': access }, ExposedPorts: { '80/tcp': {} },
      HostConfig: { PortBindings: { '80/tcp': [{ HostPort: String(port) }] }, RestartPolicy: { Name: 'unless-stopped' } },
    })
    if (create.status !== 201) throw new Error(`create ${name}: ${create.status} ${create.text.slice(0, 200)}`)
    const start = await docker(d, 'POST', `/containers/${name}/start`)
    if (start.status !== 204 && start.status !== 304) throw new Error(`start ${name}: ${start.status} ${start.text.slice(0, 200)}`)
  }
}
