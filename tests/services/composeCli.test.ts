import { describe, it, expect } from 'vitest'
import { composeUpInner, type SandboxExec } from '../../services/compose'

const ok = { code: 0, stdout: '', stderr: '' }

// docker compose on a sandbox's stack runs in the sandbox (docker exec), never in the Purgatorium container: a compose
// text written by a user (build, env_file, a provider's program…) reads and runs only what the sandbox has
describe('composeUpInner', () => {
  it('runs docker compose in the sandbox on its /inner file, with none of its environment', async () => {
    const calls: Array<[string, string[]]> = []
    await composeUpInner('p9m-x', 'inner', { exec: async (name, cmd) => { calls.push([name, cmd]); return ok } })
    expect(calls).toHaveLength(1)
    const [name, cmd] = calls[0]
    expect(name).toBe('p9m-x')
    expect(cmd.slice(0, 2)).toEqual(['env', '-i'])
    expect(cmd.slice(cmd.indexOf('docker'))).toEqual(['docker', 'compose', '-f', '/inner/docker-compose.yml', '--project-name', 'inner', 'up', '-d', '--pull', 'missing'])
  })

  // The sandbox's dockerd starts about 1.5 s after its container: the first try right after compose up nearly always
  // meets "Cannot connect", and a 3 s pause after it was most of the inner stack's time
  it('tries again every half second while the sandbox or its dockerd is starting, and says how many tries it took', async () => {
    let calls = 0
    const waits: number[] = []
    const exec: SandboxExec = async () => {
      calls++
      if (calls === 1) throw new Error('(HTTP code 409) container stopped/paused - Container 3f2a is not running')
      if (calls === 2) return { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' }
      // compose v5's words for it, while the socket is not there yet
      if (calls === 3) return { code: 1, stdout: '', stderr: 'failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory' }
      return ok
    }
    expect(await composeUpInner('p9m-x', 'inner', { exec, sleep: async ms => { waits.push(ms) } })).toBe(4)
    expect(waits).toEqual([500, 500, 500])
  })

  it('does not try again after another error, and gives its message', async () => {
    let calls = 0
    await expect(composeUpInner('p9m-x', 'inner', {
      exec: async () => { calls++; return { code: 1, stdout: '', stderr: 'services.web.ports must be a list\n' } }, sleep: async () => {},
    })).rejects.toThrow('services.web.ports must be a list')
    expect(calls).toBe(1)
  })
})

