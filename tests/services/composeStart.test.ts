import { describe, it, expect, vi } from 'vitest'
import { composeStart } from '../../services/compose'

const SYSBOX = 'Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: failed to pre-register with sysbox-fs: failed to pre-register container with sysbox-fs: rpc error: code = AlreadyExists desc = Container 2bdf already pre-registered: unknown'
// Kata runtime-rs: its shim panicked on a shim-monitor.sock an earlier VM of the container left (Kata #14014), or its
// own socket under /run/containerd/s is still there from a failed start (Kata #14103)
const KATA_MONITOR = 'Error response from daemon: failed to create task for container: failed to create shim task: ttrpc: closed: unknown'
const KATA_SHIM_SOCKET = [
  'Error response from daemon: failed to create task for container: failed to start shim: start failed: failed to create TTRPC connection: dial unix Kata Containers containerd shim (Rust): id: io.containerd.kata.v2, version: 4.3.0',
  'ERROR: containerd-shim-kata-v2 failed: shim start', '', 'Caused by:', '    0: do start', '    1: bind address',
  '    2: Address in use (os error 98): connect: invalid argument: unknown',
].join(String.fromCharCode(10))

describe('composeStart', () => {
  it('starts the stopped containers', async () => {
    const exec = vi.fn(async () => {})
    await composeStart('/s/p9m-a/docker-compose.yml', exec)
    expect(exec.mock.calls).toEqual([['docker compose -f "/s/p9m-a/docker-compose.yml" start']])
  })

  // sysbox refuses that container for good after one failed start: a wake would fail every time
  it('recreates the containers when sysbox refuses to start them again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const exec = vi.fn(async (cmd: string) => { if (cmd.endsWith(' start')) throw new Error(`Command failed: ${cmd}\n${SYSBOX}`) })
    await composeStart('/s/p9m-a/docker-compose.yml', exec)
    expect(exec.mock.calls.map(c => c[0])).toEqual([
      'docker compose -f "/s/p9m-a/docker-compose.yml" start',
      'docker compose -f "/s/p9m-a/docker-compose.yml" up -d --force-recreate --pull never',
    ])
    warn.mockRestore()
  })

  // Both stay with that container ID, so every later wake would fail too; a recreated container gets a new one
  for (const [what, msg] of [['a stale shim-monitor.sock', KATA_MONITOR], ['a stale shim socket', KATA_SHIM_SOCKET]]) {
    it(`recreates the containers when Kata's shim fails on ${what}`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const exec = vi.fn(async (cmd: string) => { if (cmd.endsWith(' start')) throw new Error(`Command failed: ${cmd}
${msg}`) })
      await composeStart('/s/p9m-a/docker-compose.yml', exec)
      expect(exec.mock.calls.map(c => c[0])).toEqual([
        'docker compose -f "/s/p9m-a/docker-compose.yml" start',
        'docker compose -f "/s/p9m-a/docker-compose.yml" up -d --force-recreate --pull never',
      ])
      warn.mockRestore()
    })
  }

  it('passes on a shim failure that a new container would have too', async () => {
    const msg = 'Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: exec: "/entrypoint.sh": no such file or directory: unknown'
    const exec = vi.fn(async () => { throw new Error(msg) })
    await expect(composeStart('/s/p9m-a/docker-compose.yml', exec)).rejects.toThrow('no such file')
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('passes any other failure on', async () => {
    const exec = vi.fn(async () => { throw new Error('no such service') })
    await expect(composeStart('/s/p9m-a/docker-compose.yml', exec)).rejects.toThrow('no such service')
    expect(exec).toHaveBeenCalledTimes(1)
  })
})
