import { describe, it, expect, vi } from 'vitest'
import { promisify } from 'node:util'

const calls: unknown[][] = []
vi.mock('node:child_process', async importOriginal => {
  const execFile = (() => {}) as unknown as Record<symbol, unknown>
  execFile[promisify.custom] = async (...args: unknown[]) => { calls.push(args); return { stdout: 'rw,nosuid,nodev,relatime\n', stderr: '' } }
  return { ...(await importOriginal<object>()), execFile }
})

import { hostMountOptions } from '../../services/hostMounts'

describe('hostMountOptions (default helper)', () => {
  it('reads the options with a read-only --mount bind (no -v: it must not create a missing folder), with a timeout', async () => {
    expect(await hostMountOptions('/srv/shared/a:b')).toEqual(['rw', 'nosuid', 'nodev', 'relatime'])
    expect(calls[0]).toEqual(['docker', ['run', '--rm', '--network', 'none', '--mount', 'type=bind,src=/srv/shared/a:b,dst=/m,readonly', 'alpine', 'findmnt', '-no', 'OPTIONS', '--target', '/m'], { timeout: 60_000 }])
  })
})
