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

import { withCurrentImage, withLogRotation, migrateSandboxImage } from '../../services/imageMigration'
import { composeUp, composeCreate } from '../../services/compose'
import { getSandboxState } from '../../services/docker'
import { DOCKER_LOGS } from '../../services/sandbox'

const images = { sysbox: 'ghcr.io/csakaszamok/foxglove:0.12.0-sysbox', dind: 'ghcr.io/csakaszamok/foxglove:0.12.0-dind' }
const compose = (image: string) => yaml.dump({ services: { sandbox: { image, container_name: 'x', labels: { 'p9m.managed': 'true' } }, frps: { image: 'fatedier/frps:v0.62.1' } } }, { lineWidth: -1 })
const imageOf = (text: string) => (yaml.load(text) as { services: { sandbox: { image: string } } }).services.sandbox.image
const state = (status: string, error = '') => ({ name: 'x', status, finishedAt: '', deepSleepAfter: '7d', staleNetwork: false, error })

describe('withCurrentImage', () => {
  it('moves an older foxglove to the runtime image of the same kind', () => {
    expect(imageOf(withCurrentImage(compose('ghcr.io/csakaszamok/foxglove:0.11.0-sysbox'), images)!)).toBe(images.sysbox)
    expect(imageOf(withCurrentImage(compose('ghcr.io/csakaszamok/foxglove:0.9.0-dind'), images)!)).toBe(images.dind)
  })

  it('leaves a current, newer or other image as it is', () => {
    expect(withCurrentImage(compose(images.sysbox), images)).toBeNull()
    expect(withCurrentImage(compose('ghcr.io/csakaszamok/foxglove:0.13.0-sysbox'), images)).toBeNull()
    expect(withCurrentImage(compose('example.com/mine:1.0.0-sysbox'), images)).toBeNull()
    expect(withCurrentImage(compose('ghcr.io/csakaszamok/foxglove:0.11.0-other'), images)).toBeNull()
  })
})

describe('withLogRotation', () => {
  it('adds rotation and keeps everything else', () => {
    const out = JSON.parse(withLogRotation(JSON.stringify({ tls: true, 'insecure-registries': ['a'] }))!)
    expect(out).toEqual({ tls: true, 'insecure-registries': ['a'], ...DOCKER_LOGS })
  })
  it('never overrides log settings of its own, nor touches a broken file', () => {
    expect(withLogRotation(JSON.stringify({ 'log-driver': 'local' }))).toBeNull()
    expect(withLogRotation('{ not json')).toBeNull()
  })
})

describe('migrateSandboxImage', () => {
  beforeEach(() => { vi.mocked(composeUp).mockClear(); vi.mocked(composeCreate).mockClear() })
  const usersDir = (names: string[], image = 'ghcr.io/csakaszamok/foxglove:0.11.0-sysbox') => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9m-img-'))
    for (const n of names) {
      fs.mkdirSync(`${dir}/${n}`)
      fs.writeFileSync(`${dir}/${n}/docker-compose.yml`, compose(image))
      fs.writeFileSync(`${dir}/${n}/daemon.json`, JSON.stringify({ tls: true }))
    }
    return dir
  }

  it('recreates a running sandbox, leaves an asleep one stopped, only rewrites a deep-sleeping one; with log rotation', async () => {
    const dir = usersDir(['p9m-run', 'p9m-zzz', 'p9m-deep'])
    vi.mocked(getSandboxState).mockImplementation(async (n: string) => n === 'p9m-run' ? state('running') : n === 'p9m-zzz' ? state('exited') : null)
    expect((await migrateSandboxImage(dir, images)).sort()).toEqual(['p9m-deep', 'p9m-run', 'p9m-zzz'])
    expect(vi.mocked(composeUp).mock.calls.map(c => path.basename(path.dirname(c[0])))).toEqual(['p9m-run'])
    expect(vi.mocked(composeCreate).mock.calls.map(c => path.basename(path.dirname(c[0])))).toEqual(['p9m-zzz'])
    for (const n of ['p9m-run', 'p9m-zzz', 'p9m-deep']) {
      expect(imageOf(fs.readFileSync(`${dir}/${n}/docker-compose.yml`, 'utf8'))).toBe(images.sysbox)
      expect(JSON.parse(fs.readFileSync(`${dir}/${n}/daemon.json`, 'utf8'))['log-opts']).toEqual(DOCKER_LOGS['log-opts'])
    }
    // Once done, nothing more
    expect(await migrateSandboxImage(dir, images)).toEqual([])
  })

  it('puts both files back when recreating fails, to try again on the next start', async () => {
    const dir = usersDir(['p9m-a'])
    const before = fs.readFileSync(`${dir}/p9m-a/docker-compose.yml`, 'utf8')
    vi.mocked(getSandboxState).mockResolvedValue(state('running'))
    vi.mocked(composeUp).mockRejectedValueOnce(new Error('boom'))
    expect(await migrateSandboxImage(dir, images)).toEqual([])
    expect(fs.readFileSync(`${dir}/p9m-a/docker-compose.yml`, 'utf8')).toBe(before)
    expect(JSON.parse(fs.readFileSync(`${dir}/p9m-a/daemon.json`, 'utf8'))).toEqual({ tls: true })
  })

  it('on a current image, writes log rotation without restarting the sandbox', async () => {
    const dir = usersDir(['p9m-new'], images.sysbox)
    vi.mocked(getSandboxState).mockResolvedValue(state('running'))
    expect(await migrateSandboxImage(dir, images)).toEqual([])
    expect(composeUp).not.toHaveBeenCalled()
    expect(JSON.parse(fs.readFileSync(`${dir}/p9m-new/daemon.json`, 'utf8'))['log-driver']).toBe('json-file')
  })
})
