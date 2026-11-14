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
let sysbox: number[] | null = [0, 7, 1]
vi.mock('../../services/sysboxVersion', async importActual => ({ ...await importActual<typeof import('../../services/sysboxVersion')>(), sysboxVersion: vi.fn(async () => sysbox) }))

let kata: number[] | null = [4, 3, 1]
vi.mock('../../services/kataVersion', async importActual => ({ ...await importActual<typeof import('../../services/kataVersion')>(), kataVersion: vi.fn(async () => kata) }))

import { withCurrentImage, withLogRotation, migrateSandboxImage } from '../../services/imageMigration'
import { composeUp, composeCreate } from '../../services/compose'
import { getSandboxState } from '../../services/docker'
import { DOCKER_LOGS } from '../../services/sandbox'
import { withIsolatedNetwork } from '../../services/networkMigration'

const images = { kata: 'ghcr.io/csakaszamok/foxglove:0.12.0-kata', sysbox: 'ghcr.io/csakaszamok/foxglove:0.12.0-sysbox', dind: 'ghcr.io/csakaszamok/foxglove:0.12.0-dind' }
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

// The startup migrations run over every sandbox's compose file: a real rendered kata compose must come through them
// with only its image moved (imageMigration), and untouched by the network migration (its frps is on traefik-net)
describe('a rendered runtimes/kata.yaml through the startup migrations', () => {
  const vars: Record<string, string> = {
    name: 'p9m-k1', raw_name: 'k1', runtime_name: 'kata', template_name: 'starter', compose_source: 'template',
    created_at: '2026-11-14T00:00:00.000Z', sandbox_dir: '/opt/p9m/opt/sandboxes/admin/p9m-k1', host_domain: 'lvh.me',
    frp_token: 'tok', frps_api_auth: 'p9m:pw', registry_host: 'registry.lvh.me', ui_host: 'console.lvh.me',
    user_host: 'console.lvh.me', idle_timeout: '30m', deep_sleep_after: '7d', owner: '"admin"', cpus: '2', memory: '4g',
    subnet: '10.213.0.0/28', ip_range: '10.213.0.8/29', dns_ip: '10.213.0.2',
  }
  // As services/sandbox.ts renders it (applyVarsText): ${key} replaced, a $ in a value doubled
  const rendered = () => {
    const runtime = yaml.load(fs.readFileSync(path.join(__dirname, '../../runtimes/kata.yaml'), 'utf8')) as { docker_compose: unknown }
    let text = yaml.dump(runtime.docker_compose, { lineWidth: -1 })
    for (const [k, v] of Object.entries(vars)) text = text.split(`\${${k}}`).join(v.replace(/\$/g, '$$$$'))
    return text
  }

  it('renders every variable (no ${...} left)', () => {
    expect(rendered()).not.toMatch(/\$\{\w+\}/)
  })

  it('withCurrentImage moves only the image', () => {
    const text = rendered()
    const before = yaml.load(text) as { services: { sandbox: { image: string } } }
    const newer = 'ghcr.io/csakaszamok/foxglove:9.9.9-kata'
    const out = withCurrentImage(text, { ...images, kata: newer })
    expect(out).not.toBeNull()
    before.services.sandbox.image = newer
    expect(yaml.load(out!)).toEqual(before)
  })

  it('withIsolatedNetwork leaves it alone', () => {
    expect(withIsolatedNetwork(rendered(), 'p9m-k1', { registryHost: 'registry.lvh.me', uiHost: 'console.lvh.me', images })).toBeNull()
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
  beforeEach(() => { vi.mocked(composeUp).mockClear(); vi.mocked(composeCreate).mockClear(); sysbox = [0, 7, 1]; kata = [4, 3, 1] })
  const usersDir = (names: string[], image = 'ghcr.io/csakaszamok/foxglove:0.11.0-sysbox') => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9m-img-'))
    for (const n of names) {
      fs.mkdirSync(`${dir}/${n}`)
      fs.writeFileSync(`${dir}/${n}/docker-compose.yml`, compose(image))
      fs.writeFileSync(`${dir}/${n}/daemon.json`, JSON.stringify({ tls: true }))
    }
    return dir
  }

  it.each([[[0, 6, 7]], [null]])('sysbox %j: -sysbox sandboxes keep their image, their logs are rotated from the next recreate', async version => {
    sysbox = version
    const dir = usersDir(['p9m-old'])
    const before = fs.readFileSync(`${dir}/p9m-old/docker-compose.yml`, 'utf8')
    expect(await migrateSandboxImage(dir, images)).toEqual([])
    expect(fs.readFileSync(`${dir}/p9m-old/docker-compose.yml`, 'utf8')).toBe(before)
    expect(composeUp).not.toHaveBeenCalled()
    expect(JSON.parse(fs.readFileSync(`${dir}/p9m-old/daemon.json`, 'utf8'))['log-opts']).toEqual(DOCKER_LOGS['log-opts'])
  })
  it.each([[[4, 2, 0]], [null]])('kata %j: -kata sandboxes keep their image while -dind ones move', async version => {
    kata = version
    vi.mocked(getSandboxState).mockResolvedValue(state('running'))
    const dir = usersDir(['p9m-k'], 'ghcr.io/csakaszamok/foxglove:0.11.0-kata')
    fs.mkdirSync(`${dir}/p9m-d`); fs.writeFileSync(`${dir}/p9m-d/docker-compose.yml`, compose('ghcr.io/csakaszamok/foxglove:0.11.0-dind'))
    expect(await migrateSandboxImage(dir, images)).toEqual(['p9m-d'])
    expect(imageOf(fs.readFileSync(`${dir}/p9m-k/docker-compose.yml`, 'utf8'))).toBe('ghcr.io/csakaszamok/foxglove:0.11.0-kata')
    expect(imageOf(fs.readFileSync(`${dir}/p9m-d/docker-compose.yml`, 'utf8'))).toBe(images.dind)
  })
  it('kata 4.3.1 moves a -kata sandbox to the new image', async () => {
    vi.mocked(getSandboxState).mockResolvedValue(state('running'))
    const dir = usersDir(['p9m-k'], 'ghcr.io/csakaszamok/foxglove:0.11.0-kata')
    expect(await migrateSandboxImage(dir, images)).toEqual(['p9m-k'])
    expect(imageOf(fs.readFileSync(`${dir}/p9m-k/docker-compose.yml`, 'utf8'))).toBe(images.kata)
  })
  it('an old sysbox does not hold back -dind sandboxes', async () => {
    sysbox = [0, 6, 7]
    vi.mocked(getSandboxState).mockResolvedValue(state('running'))
    const dir = usersDir(['p9m-dev'], 'ghcr.io/csakaszamok/foxglove:0.11.0-dind')
    expect(await migrateSandboxImage(dir, images)).toEqual(['p9m-dev'])
    expect(imageOf(fs.readFileSync(`${dir}/p9m-dev/docker-compose.yml`, 'utf8'))).toBe(images.dind)
  })
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
