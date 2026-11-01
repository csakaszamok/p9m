import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

async function run(cmd: string): Promise<void> {
  const { stderr } = await execAsync(cmd)
  if (stderr) process.stderr.write(stderr)
}

export function composeUp(composePath: string, pull: 'always' | 'missing' | 'never' = 'missing'): Promise<void> {
  return run(`docker compose -f "${composePath}" up -d --pull ${pull}`)
}

/**
 * (Re)creates one service after its config changed; `start: false` leaves it stopped. Other services are not touched.
 * Removed first: compose's own recreate makes the new container under a temporary name (<id>_<name>), which Sablier
 * puts into the sandbox's group, and a wake then fails ("No such container") until Sablier reconciles a minute later.
 */
export async function composeUpService(composePath: string, service: string, start: boolean, exec: (cmd: string) => Promise<void> = run): Promise<void> {
  await exec(`docker compose -f "${composePath}" rm -s -f "${service}"`)
  await exec(`docker compose -f "${composePath}" up ${start ? '-d' : '--no-start'} --no-deps "${service}"`)
}

/** (Re)creates the services whose config changed without starting them. */
export function composeCreate(composePath: string): Promise<void> {
  return run(`docker compose -f "${composePath}" up --no-start`)
}

export function composeStop(composePath: string): Promise<void> {
  return run(`docker compose -f "${composePath}" stop`)
}

/**
 * Starts a stopped sandbox. sysbox can refuse to start a container again after a failed start ("already
 * pre-registered" with sysbox-fs) however often it is asked: then its containers are created anew, which sysbox
 * takes. Its data is in volumes and stays.
 */
export async function composeStart(composePath: string, exec: (cmd: string) => Promise<void> = run): Promise<void> {
  try {
    await exec(`docker compose -f "${composePath}" start`)
  } catch (err) {
    if (!/already pre-registered/.test(err instanceof Error ? err.message : String(err))) throw err
    console.warn(`[compose] ${composePath}: sysbox refused to start it again, recreating its containers`)
    await exec(`docker compose -f "${composePath}" up -d --force-recreate --pull never`)
  }
}

export function composeDown(composePath: string): Promise<void> {
  return run(`docker compose -f "${composePath}" down`)
}

/** A command run in a sandbox container (docker exec, no TTY): execRun in services/docker. */
export type SandboxExec = (name: string, cmd: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

/**
 * docker compose on the sandbox's stack runs in the sandbox itself, on its own Docker (the file is its /inner): what a
 * compose text written by a user makes the CLI do (read a file, build, run a provider's program) happens in the
 * sandbox, never in the Purgatorium container, which holds the host's Docker socket. Nothing of the sandbox's
 * environment either: an unknown ${VAR} is empty, as it was.
 */
function innerComposeCmd(project: string, args: string[], seconds?: number): string[] {
  return [...(seconds ? ['timeout', String(seconds)] : []), 'env', '-i', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME=/root',
    'docker', 'compose', '-f', '/inner/docker-compose.yml', '--project-name', project, ...args]
}

type InnerOpts = { exec: SandboxExec; sleep?: (ms: number) => Promise<void> }

/**
 * Runs it, again every half second while the sandbox's dockerd is starting (it answers ~1.5 s after its container
 * starts, and the container may not be running yet); the result and how many tries it took.
 */
async function runInner(name: string, cmd: string[], opts: InnerOpts): Promise<{ code: number; stderr: string; tries: number }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const deadline = Date.now() + 90000
  let tries = 0
  while (Date.now() < deadline) {
    tries++
    let r: { code: number; stderr: string }
    try { r = await opts.exec(name, cmd) } catch (err) {
      // e.g. 409 "container ... is not running" while it starts
      r = { code: -1, stderr: err instanceof Error ? err.message : String(err) }
    }
    const notYet = r.code !== 0 && /Cannot connect to the Docker daemon|Is the docker daemon running|failed to connect to the docker API|container \S+ is (not running|restarting)/i.test(r.stderr)
    if (!notYet) return { ...r, tries }
    await sleep(500)
  }
  throw new Error("Timed out waiting for the sandbox's Docker to accept docker compose")
}

/** compose up of the sandbox's /inner stack, in the sandbox; returns how many tries it took. */
export async function composeUpInner(name: string, project: string, opts: InnerOpts): Promise<number> {
  const { code, stderr, tries } = await runInner(name, innerComposeCmd(project, ['up', '-d', '--pull', 'missing']), opts)
  if (code !== 0) {
    // Its last lines say what went wrong; the pull and build progress before them would only bury it
    const lines = stderr.split('\n').map(l => l.trim()).filter(l => l && !/Pulling|Waiting|Downloading|Extracting|Verifying|Download complete|Pull complete|Already exists/.test(l))
    throw new Error(lines.slice(-5).join('\n') || `docker compose up exited with ${code}`)
  }
  if (stderr) process.stderr.write(stderr)
  return tries
}
