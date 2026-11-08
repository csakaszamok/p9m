import fs from 'fs'
import yaml from 'js-yaml'
import { composeCreate, composeUp } from './compose'
import { getSandboxState } from './docker'
import { FRPS_PORTS } from './frpsApi'
import { entriesIn, listSandboxDirs } from './sandboxPaths'
import { uiHost } from './uiHost'
import { listRuntimes } from './runtimeLoader'

/** Each runtime's sandbox image by its kind (the tag's suffix): { dind: 'ghcr.io/…:0.11.0-dind', sysbox: … } */
function runtimeImages(): Record<string, string> {
  const images: Record<string, string> = {}
  for (const r of listRuntimes()) {
    const image = (r.docker_compose.services as Record<string, { image?: string }> | undefined)?.sandbox?.image
    const kind = image && /-(\w+)$/.exec(image)?.[1]
    if (image && kind) images[kind] = image
  }
  return images
}

type Service = { image?: unknown; environment?: Record<string, unknown>; networks?: unknown; command?: unknown }
type Compose = { services?: Record<string, Service | undefined> }

/** socat's relays (runtimes/*.yaml): frps's vhost and API for Traefik and Purgatorium, Purgatorium's services for the sandbox */
const socatCommand = (name: string) =>
  `-c "trap 'exit 0' TERM; for r in 8080:${name}-frps:${FRPS_PORTS.vhost} 7500:${name}-frps:${FRPS_PORTS.api} 5000:p9m-registry-cache:5000 5001:p9m-registry-cache-ghcr:5000 80:traefik:80 443:traefik:443; do socat TCP-LISTEN:$\${r%%:*},fork,reuseaddr TCP:$\${r#*:} & done; wait"`

const onTraefikNet = (networks: unknown): boolean =>
  Array.isArray(networks) ? networks.includes('traefik-net') : !!networks && typeof networks === 'object' && 'traefik-net' in networks

/**
 * The compose file of a sandbox made before 0.12.23 with the networks the runtimes now have: the sandbox on its own
 * network only, frps on traefik-net under the sandbox's name, socat relaying frps's new ports and, for the sandbox,
 * Purgatorium's services. Null when there is nothing to change (already moved, or not a sandbox with frps).
 */
export function withIsolatedNetwork(text: string, name: string, env: { registryHost: string; uiHost: string; images: Record<string, string> }): string | null {
  const doc = yaml.load(text) as Compose | null
  const s = doc?.services
  if (!s?.sandbox || !s.frps || !s.socat || onTraefikNet(s.frps.networks)) return null
  const nets = s.sandbox.networks
  s.sandbox.networks = Array.isArray(nets) ? nets.filter(n => n !== 'traefik-net')
    : Object.fromEntries(Object.entries((nets ?? {}) as Record<string, unknown>).filter(([k]) => k !== 'traefik-net'))
  if (s.sandbox.environment) s.sandbox.environment.FRP_SERVER_PORT = String(FRPS_PORTS.bind)
  // Its frpc must have the tcp proxies (foxglove 0.11.0): the runtime's image of the same kind (-dind, -sysbox)
  const kind = typeof s.sandbox.image === 'string' ? /-(\w+)$/.exec(s.sandbox.image)?.[1] : undefined
  if (kind && env.images[kind]) s.sandbox.image = env.images[kind]
  s.frps.networks = { default: null, 'traefik-net': { aliases: [name] } }
  s.socat.command = socatCommand(name)
  s.socat.networks = { default: { aliases: ['registry-cache', env.registryHost, env.uiHost] }, 'traefik-net': null }
  return yaml.dump(doc, { lineWidth: -1 })
}

/** frps.toml with frps's own ports out of the apps' way (FRPS_PORTS). */
export function withFrpsPorts(toml: string): string {
  return toml
    .replace(/^bindPort = 7000$/m, `bindPort = ${FRPS_PORTS.bind}`)
    .replace(/^vhostHTTPPort = 8080$/m, `vhostHTTPPort = ${FRPS_PORTS.vhost}`)
    .replace(/^port = 7500$/m, `port = ${FRPS_PORTS.api}`)
}

/**
 * Before 0.12.23 every sandbox container was on traefik-net, so a sandbox reached every other sandbox's published
 * ports directly, past app access. Moves the sandboxes made before to the runtimes' networks (withIsolatedNetwork,
 * frps.toml's ports) and recreates their containers: started if it was running or its last start failed, otherwise
 * left stopped (asleep); a deep-sleeping one only gets its files rewritten. Returns the migrated sandbox names.
 */
export async function migrateIsolatedNetwork(flatDir?: string, env?: { registryHost: string; uiHost: string; images: Record<string, string> }): Promise<string[]> {
  env ??= { registryHost: `registry.${process.env.HOST_DOMAIN ?? 'lvh.me'}`, uiHost: uiHost(), images: runtimeImages() }
  const entries = flatDir === undefined ? listSandboxDirs() : entriesIn(flatDir)
  const migrated: string[] = []
  for (const { name, dir } of entries) {
    const composePath = `${dir}/docker-compose.yml`, tomlPath = `${dir}/frps.toml`
    let original: string, toml: string
    try { original = fs.readFileSync(composePath, 'utf8'); toml = fs.readFileSync(tomlPath, 'utf8') } catch { continue }
    let next: string | null
    try { next = withIsolatedNetwork(original, name, env) } catch { continue }
    if (next === null) continue
    try {
      fs.writeFileSync(tomlPath, withFrpsPorts(toml))
      fs.writeFileSync(composePath, next)
      const state = await getSandboxState(name)
      if (state) {
        if (state.status === 'running' || state.error) await composeUp(composePath)
        else await composeCreate(composePath)
      }
      migrated.push(name)
      console.log(`[network] ${name}: on its own network, reached through frps`)
    } catch (err) {
      fs.writeFileSync(composePath, original) // retried on the next start
      fs.writeFileSync(tomlPath, toml)
      console.error(`[network] ${name} failed:`, err instanceof Error ? err.message : err)
    }
  }
  return migrated
}
