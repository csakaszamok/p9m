import fs from 'fs'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Named volumes created by a compose project (the project name is the sandbox dir name). */
export async function listProjectVolumes(project: string): Promise<string[]> {
  const { stdout } = await execFileAsync('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`])
  return stdout.split('\n').map(l => l.trim()).filter(Boolean)
}

/** Stream a volume's contents as tar.gz into destFile via a throwaway alpine container. */
/** A volume as a .tar.gz; `exclude`: paths in it (./…) left out. */
export function exportVolume(volume: string, destFile: string, exclude: string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destFile)
    const proc = spawn('docker', ['run', '--rm', '-v', `${volume}:/data:ro`, 'alpine', 'tar', 'czf', '-', ...exclude.map(e => `--exclude=${e}`), '-C', '/data', '.'])
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d })
    proc.stdout.pipe(out)
    proc.on('error', reject)
    proc.on('close', code => {
      out.close(() => code === 0 ? resolve() : reject(new Error(`export of volume ${volume} failed (${code}): ${stderr.trim()}`)))
    })
  })
}

export async function removeVolume(volume: string): Promise<void> {
  await execFileAsync('docker', ['volume', 'rm', volume])
}

async function projectContainerIds(project: string): Promise<string[]> {
  const { stdout } = await execFileAsync('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])
  return stdout.split('\n').map(l => l.trim()).filter(Boolean)
}

/** Stop every container of a compose project, found by label (works without a compose file). */
export async function stopProjectContainers(project: string): Promise<void> {
  const ids = await projectContainerIds(project)
  if (ids.length) await execFileAsync('docker', ['stop', ...ids])
}

/** Remove every container of a compose project, including ones compose no longer knows about. */
export async function removeProjectContainers(project: string): Promise<void> {
  const ids = await projectContainerIds(project)
  if (ids.length) await execFileAsync('docker', ['rm', '-f', ...ids])
}

/**
 * Workaround for Traefik (v3.6) + traefik.docker.allownonrunning: removing an
 * already-stopped container emits only a "destroy" event, which Traefik does not
 * act on, so the removed sandbox's router lingers (404) until some other container
 * event. A throwaway container emits start/die and makes Traefik re-read.
 */
export async function nudgeTraefik(): Promise<void> {
  await execFileAsync('docker', ['run', '--rm', '--network', 'none', 'alpine', 'true'])
}
