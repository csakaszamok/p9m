// The containers in a sandbox's own Docker, for the Containers tab: a terminal opens a shell in a running one.
import { innerDocker } from './innerDocker'
import { resumeScript, type TerminalResume } from './terminalResume'
import { ttyShell } from './docker'

interface InnerContainer { Id: string; Names: string[]; Image: string; State: string; Status: string; Labels: Record<string, string> | null }

export interface ContainerRow { name: string; project: string | null; service: string | null; image: string; state: string; status: string }

/** A container name (or id) as Docker allows it: nothing else reaches the inner Docker's exec */
export const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/

/** Every container, running ones first, then by compose project and name. */
export function containerRows(containers: InnerContainer[]): ContainerRow[] {
  return containers
    .map(c => ({
      name: c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12),
      project: c.Labels?.['com.docker.compose.project'] ?? null,
      service: c.Labels?.['com.docker.compose.service'] ?? null,
      image: c.Image,
      state: c.State,
      status: c.Status,
    }))
    .sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running')
      || (a.project ?? '').localeCompare(b.project ?? '') || a.name.localeCompare(b.name))
}

/** A running sandbox's containers, asked of its own Docker. */
export async function sandboxContainers(name: string): Promise<ContainerRow[]> {
  return containerRows(await innerDocker(name).listContainers({ all: true }) as unknown as InnerContainer[])
}

/**
 * What runs in the container: its user's login shell from /etc/passwd (zsh in a devcontainer), else bash, else sh.
 * The pid file may not be writable (a read-only file system): the shell still opens, it is only not HUPed on close.
 */
/** The script of a container's shell; `then` runs before the login shell takes over (it ends with exec "$s" -l) */
export const CONTAINER_SHELL = (pidFile: string, then = 'exec "$s" -l') => `{ echo $$ > ${pidFile}; } 2>/dev/null
s=$(awk -F: -v u="$(id -u)" '$3==u{print $7; exit}' /etc/passwd 2>/dev/null)
case "$s" in */nologin|*/false) s= ;; esac
[ -n "$s" ] && [ -x "$s" ] || s=$(command -v bash) || s=sh
${then}`

/** A shell in a container of the sandbox's own Docker, as the container's own user, in its own working dir. */
export async function openContainerShell(name: string, container: string, cols: number, rows: number, resume?: TerminalResume) {
  if (!CONTAINER_NAME.test(container)) throw new Error(`No such container: ${container}`)
  const script = resume ? (pid: string) => CONTAINER_SHELL(pid, resumeScript(resume)) : CONTAINER_SHELL
  // timeout 0: a terminal may stay quiet for hours
  return ttyShell(innerDocker(name, undefined, 0).getContainer(container), cols, rows, script, { Env: ['TERM=xterm-256color'] })
}
