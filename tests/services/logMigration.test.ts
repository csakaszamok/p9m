import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import yaml from 'js-yaml'

vi.mock('../../services/compose', () => ({
  composeUp: vi.fn().mockResolvedValue(undefined),
  composeCreate: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../services/docker', () => ({ getSandboxState: vi.fn() }))

import { COMPOSE_LOGGING, withLogLimits, withLogLimitsText, migrateLogLimits } from '../../services/logMigration'
import { loadRuntime } from '../../services/runtimeLoader'
import { composeUp, composeCreate } from '../../services/compose'
import { getSandboxState } from '../../services/docker'

const LIMITS = { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } }
type Doc = { services: Record<string, { logging?: unknown; image?: string }> }

// What a runtime generated before log limits: no logging on any service
const before = `services:
  sandbox:
    image: ghcr.io/csakaszamok/foxglove:0.13.0-kata
    container_name: p9m-a
  dns:
    image: coredns/coredns:1.12.0
  frps:
    image: snowdreamtech/frps:0.61.1
  socat:
    image: alpine/socat:1.8.0.1
volumes:
  docker_data: null
`
const state = (status: string, error = '') =>
  ({ name: 'x', status, finishedAt: '', deepSleepAfter: '7d', staleNetwork: false, error })

describe('withLogLimits', () => {
  it("is the rotation the sandbox's own dockerd has", () => {
    expect(COMPOSE_LOGGING).toEqual(LIMITS)
  })

  it('gives every service of every runtime rotated logs, without changing the runtime', () => {
    for (const name of ['dind', 'kata', 'sysbox']) {
      const runtime = loadRuntime(name, path.join(__dirname, '../../runtimes')).docker_compose
      const out = withLogLimits(runtime) as Doc
      expect(Object.keys(out.services).length, name).toBeGreaterThanOrEqual(3)
      for (const s of Object.values(out.services)) expect(s.logging, name).toEqual(LIMITS)
      expect(JSON.stringify(runtime), name).not.toContain('max-size')
    }
  })

  it("keeps a service's own logging", () => {
    const own = { driver: 'local' }
    const out = withLogLimits({ services: { a: { logging: own }, b: {} } }) as Doc
    expect(out.services.a.logging).toEqual(own)
    expect(out.services.b.logging).toEqual(LIMITS)
  })
})

describe('withLogLimitsText', () => {
  it('adds the limits to a compose file without them, once', () => {
    const out = withLogLimitsText(before)!
    const doc = yaml.load(out) as Doc
    for (const s of Object.values(doc.services)) expect(s.logging).toEqual(LIMITS)
    expect(doc.services.sandbox.image).toBe('ghcr.io/csakaszamok/foxglove:0.13.0-kata')
    expect(withLogLimitsText(out)).toBeNull()
  })

  it('leaves a file with no services alone', () => {
    expect(withLogLimitsText('volumes: {}\n')).toBeNull()
  })
})

describe('migrateLogLimits', () => {
  beforeEach(() => { vi.mocked(composeUp).mockClear(); vi.mocked(composeCreate).mockClear() })

  it('recreates a running sandbox, leaves an asleep one stopped, only rewrites a deep-sleeping one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9m-logs-'))
    for (const n of ['p9m-run', 'p9m-zzz', 'p9m-deep', 'p9m-new']) {
      fs.mkdirSync(`${dir}/${n}`)
      fs.writeFileSync(`${dir}/${n}/docker-compose.yml`, n === 'p9m-new' ? withLogLimitsText(before)! : before)
    }
    vi.mocked(getSandboxState).mockImplementation(async (n: string) => n === 'p9m-run' ? state('running') : n === 'p9m-zzz' ? state('exited') : null)
    expect((await migrateLogLimits(dir)).sort()).toEqual(['p9m-deep', 'p9m-run', 'p9m-zzz'])
    expect(vi.mocked(composeUp).mock.calls.map(c => path.basename(path.dirname(c[0])))).toEqual(['p9m-run'])
    expect(vi.mocked(composeCreate).mock.calls.map(c => path.basename(path.dirname(c[0])))).toEqual(['p9m-zzz'])
    expect(fs.readFileSync(`${dir}/p9m-deep/docker-compose.yml`, 'utf8')).toContain('max-size')
  })

  it('puts the file back when recreating fails, so the next start tries again', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9m-logs-'))
    fs.mkdirSync(`${dir}/p9m-bad`)
    fs.writeFileSync(`${dir}/p9m-bad/docker-compose.yml`, before)
    vi.mocked(getSandboxState).mockResolvedValue(state('running'))
    vi.mocked(composeUp).mockRejectedValueOnce(new Error('boom'))
    expect(await migrateLogLimits(dir)).toEqual([])
    expect(fs.readFileSync(`${dir}/p9m-bad/docker-compose.yml`, 'utf8')).toBe(before)
  })
})
