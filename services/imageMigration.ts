import fs from 'fs'
import yaml from 'js-yaml'
import { composeCreate, composeUp } from './compose'
import { getSandboxState } from './docker'
import { entriesIn, listSandboxDirs } from './sandboxPaths'
import { runtimeImages } from './networkMigration'
import { DOCKER_LOGS } from './sandbox'

type Compose = { services?: Record<string, { image?: unknown } | undefined> }

/** foxglove's version from an image tag (`…/foxglove:0.11.0-sysbox` → [0, 11, 0]); null for any other image. */
function foxgloveVersion(image: unknown): number[] | null {
  const m = typeof image === 'string' ? /\/foxglove:(\d+)\.(\d+)\.(\d+)-\w+$/.exec(image) : null
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
const older = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/**
 * A sandbox's compose file with the runtime's sandbox image of the same kind (-dind, -sysbox) when its own foxglove is
 * older; null when there is nothing to change (current, newer, or not a foxglove image: left as it is).
 */
export function withCurrentImage(text: string, images: Record<string, string>): string | null {
  const doc = yaml.load(text) as Compose | null
  const sandbox = doc?.services?.sandbox
  const have = foxgloveVersion(sandbox?.image)
  const kind = typeof sandbox?.image === 'string' ? /-(\w+)$/.exec(sandbox.image)?.[1] : undefined
  const want = kind ? images[kind] : undefined
  const wantVersion = foxgloveVersion(want)
  if (!sandbox || !have || !want || !wantVersion || older(have, wantVersion) >= 0) return null
  sandbox.image = want
  return yaml.dump(doc, { lineWidth: -1 })
}

/** daemon.json with log rotation for the sandbox's containers, when it has no log settings of its own; null otherwise. */
export function withLogRotation(text: string): string | null {
  let cfg: Record<string, unknown>
  try { cfg = JSON.parse(text) as Record<string, unknown> } catch { return null }
  if (cfg['log-driver'] !== undefined || cfg['log-opts'] !== undefined) return null
  return JSON.stringify({ ...cfg, ...DOCKER_LOGS }, null, 2)
}

/**
 * Sandboxes made before 0.18.11 ran foxglove 0.11.0 (runc 1.2.2: CVE-2025-31133, -52565, -52881, a container in the
 * sandbox could break out into it; Docker 27 and containerd 2.0.0), and their dockerd kept every container's log
 * without limit. Moves them to the runtimes' image and adds log rotation to their daemon.json, then recreates the
 * containers: started if it was running or its last start failed, otherwise left stopped (asleep); a deep-sleeping one
 * only gets its files rewritten. Returns the migrated sandbox names.
 */
export async function migrateSandboxImage(flatDir?: string, images: Record<string, string> = runtimeImages()): Promise<string[]> {
  const entries = flatDir === undefined ? listSandboxDirs() : entriesIn(flatDir)
  const migrated: string[] = []
  for (const { name, dir } of entries) {
    const composePath = `${dir}/docker-compose.yml`, daemonPath = `${dir}/daemon.json`
    let original: string
    try { original = fs.readFileSync(composePath, 'utf8') } catch { continue }
    let next: string | null
    try { next = withCurrentImage(original, images) } catch { continue }
    let daemon: string | null = null
    try { daemon = fs.readFileSync(daemonPath, 'utf8') } catch { /* none */ }
    const rotated = daemon === null ? null : withLogRotation(daemon)
    // dockerd reads daemon.json when it starts: alone, log rotation waits for the sandbox's next recreate
    if (next === null) {
      if (rotated !== null) fs.writeFileSync(daemonPath, rotated)
      continue
    }
    try {
      if (rotated !== null) fs.writeFileSync(daemonPath, rotated)
      fs.writeFileSync(composePath, next)
      const state = await getSandboxState(name)
      if (state) {
        if (state.status === 'running' || state.error) await composeUp(composePath)
        else await composeCreate(composePath)
      }
      migrated.push(name)
      console.log(`[image] ${name}: on ${String((yaml.load(next) as Compose).services?.sandbox?.image)}`)
    } catch (err) {
      fs.writeFileSync(composePath, original) // retried on the next start
      if (daemon !== null) fs.writeFileSync(daemonPath, daemon)
      console.error(`[image] ${name} failed:`, err instanceof Error ? err.message : err)
    }
  }
  return migrated
}
