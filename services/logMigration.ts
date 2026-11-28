import fs from 'fs'
import yaml from 'js-yaml'
import { composeCreate, composeUp } from './compose'
import { getSandboxState } from './docker'
import { entriesIn, listSandboxDirs } from './sandboxPaths'

/** How a sandbox's logs are rotated: its containers' on the host (COMPOSE_LOGGING) and its own dockerd's (DOCKER_LOGS). */
export const LOG_ROTATION = { 'max-size': '10m', 'max-file': '3' }

/** A compose service's logging, rotated. */
export const COMPOSE_LOGGING = { driver: 'json-file', options: LOG_ROTATION }

type Compose = { services?: Record<string, Record<string, unknown> | null | undefined> }

/**
 * A copy of the sandbox's compose file with every service's log rotated on the host (one with its own logging keeps
 * it). Docker keeps a container's log without end unless its daemon is told otherwise, and every start of a sandbox
 * adds its dockerd's lines to it.
 */
export function withLogLimits(compose: Record<string, unknown>): Record<string, unknown> {
  const services = (compose as Compose).services
  if (!services) return compose
  return {
    ...compose,
    services: Object.fromEntries(Object.entries(services).map(([k, s]) =>
      [k, s && typeof s === 'object' && !('logging' in s) ? { ...s, logging: structuredClone(COMPOSE_LOGGING) } : s])),
  }
}

/** The compose file's text with withLogLimits; null when there is nothing to change. */
export function withLogLimitsText(text: string): string | null {
  const doc = yaml.load(text) as Compose | null
  const services = doc?.services
  if (!services || Object.values(services).every(s => !s || typeof s !== 'object' || 'logging' in s)) return null
  return yaml.dump(withLogLimits(doc as Record<string, unknown>), { lineWidth: -1 })
}

/**
 * Before 0.21.2 a sandbox's containers kept their logs on the host without limit. Gives the sandboxes made before the
 * rotation new ones get and recreates their containers (a log setting takes effect only on a new container): started
 * if it was running or its last start failed, otherwise left stopped (asleep); a deep-sleeping one only gets the file
 * rewritten. Returns the migrated sandbox names.
 */
export async function migrateLogLimits(flatDir?: string): Promise<string[]> {
  const entries = flatDir === undefined ? listSandboxDirs() : entriesIn(flatDir)
  const migrated: string[] = []
  for (const { name, dir } of entries) {
    const composePath = `${dir}/docker-compose.yml`
    let original: string
    try { original = fs.readFileSync(composePath, 'utf8') } catch { continue }
    let next: string | null
    try { next = withLogLimitsText(original) } catch { continue }
    if (next === null) continue
    try {
      fs.writeFileSync(composePath, next)
      const state = await getSandboxState(name)
      if (state) {
        if (state.status === 'running' || state.error) await composeUp(composePath)
        else await composeCreate(composePath)
      }
      migrated.push(name)
      console.log(`[logs] ${name}: its containers' logs rotated`)
    } catch (err) {
      fs.writeFileSync(composePath, original) // retried on the next start
      console.error(`[logs] ${name} failed:`, err instanceof Error ? err.message : err)
    }
  }
  return migrated
}
