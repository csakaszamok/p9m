import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls: string[][] = []
let psOutput = ''

vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>()
  const execFile = (cmd: string, args: string[], cb: (err: Error | null, res: { stdout: string; stderr: string }) => void) => {
    calls.push([cmd, ...args])
    cb(null, { stdout: args[0] === 'ps' || args[0] === 'volume' ? psOutput : '', stderr: '' })
  }
  // promisify uses the custom symbol when present; mimic child_process.execFile's { stdout, stderr } result
  ;(execFile as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] =
    (cmd: string, args: string[]) => new Promise(resolve => execFile(cmd, args, (_e, res) => resolve(res)))
  // exportVolume: a docker run whose output is the tarball; here it only records its arguments and ends with 0
  const spawn = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args])
    const { PassThrough } = require('node:stream') as typeof import('node:stream')
    const { EventEmitter } = require('node:events') as typeof import('node:events')
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
    setImmediate(() => { proc.stdout.end(); proc.emit('close', 0) })
    return proc
  }
  return { ...actual, execFile, spawn }
})

import os from 'node:os'
import path from 'node:path'
import { stopProjectContainers, removeProjectContainers, listProjectVolumes, nudgeTraefik, exportVolume } from '../../services/project'

describe('project helpers', () => {
  beforeEach(() => { calls.length = 0; psOutput = '' })

  it('stops all containers carrying the compose project label', async () => {
    psOutput = 'aaa\nbbb\n'
    await stopProjectContainers('p9m-x')
    expect(calls).toEqual([
      ['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=p9m-x'],
      ['docker', 'stop', 'aaa', 'bbb']
    ])
  })

  it('does nothing when the project has no containers', async () => {
    await removeProjectContainers('p9m-x')
    expect(calls).toHaveLength(1)
  })

  it('force-removes leftover containers', async () => {
    psOutput = 'ccc\n'
    await removeProjectContainers('p9m-x')
    expect(calls[1]).toEqual(['docker', 'rm', '-f', 'ccc'])
  })

  it('nudges Traefik with a throwaway container (start/die events)', async () => {
    await nudgeTraefik()
    expect(calls).toEqual([['docker', 'run', '--rm', '--network', 'none', 'alpine', 'true']])
  })

  it('lists project volumes by label', async () => {
    psOutput = 'p9m-x_docker_data\n\n'
    expect(await listProjectVolumes('p9m-x')).toEqual(['p9m-x_docker_data'])
  })

  it('exports a volume with tar, leaving out what it is told to', async () => {
    const dest = path.join(os.tmpdir(), `p9m-export-${process.pid}.tgz`)
    await exportVolume('p9m-a_docker_data', dest, ['./volumes/claude_secrets'])
    expect(calls.at(-1)!.slice(-7)).toEqual(['tar', 'czf', '-', '--exclude=./volumes/claude_secrets', '-C', '/data', '.'])
    await exportVolume('p9m-a_frps', dest)
    expect(calls.at(-1)!.slice(-6)).toEqual(['tar', 'czf', '-', '-C', '/data', '.'])
  })
})
