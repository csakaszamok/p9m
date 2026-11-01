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

import { withIsolatedNetwork, withFrpsPorts, migrateIsolatedNetwork } from '../../services/networkMigration'
import { frpsToml } from '../../services/frpsApi'
import { composeUp, composeCreate } from '../../services/compose'
import { getSandboxState } from '../../services/docker'

type Svc = { image?: string; environment?: Record<string, string>; networks?: unknown; command?: string; healthcheck?: unknown }
// A sandbox's compose file as a runtime made it before 0.12.23 (yaml.dump of the runtime)
const before = (name: string, kind = 'sysbox') => yaml.dump({
  services: {
    sandbox: { image: `ghcr.io/csakaszamok/foxglove:0.10.0-${kind}`, container_name: name, environment: { FRP_SERVER_ADDR: `${name}-frps`, FRP_SERVER_PORT: '7000' }, networks: ['default', 'traefik-net'], labels: { 'p9m.managed': 'true' } },
    frps: { image: 'fatedier/frps:v0.62.1', networks: ['default'] },
    socat: { command: `-c "socat TCP-LISTEN:8080 TCP:${name}-frps:8080"`, networks: ['default', 'traefik-net'], healthcheck: { test: ['CMD-SHELL', 'wget -qO- http://$$FRPS_API_AUTH@127.0.0.1:7500/api/proxy/http'] } },
  },
  networks: { 'traefik-net': { external: true } },
}, { lineWidth: -1 })
const env = { registryHost: 'registry.example.com', uiHost: 'p9m.example.com', images: { sysbox: 'ghcr.io/csakaszamok/foxglove:0.11.0-sysbox', dind: 'ghcr.io/csakaszamok/foxglove:0.11.0-dind' } }
const state = (status: string, error = '') => ({ name: 'x', status, finishedAt: '', deepSleepAfter: '7d', staleNetwork: false, error })

describe('withIsolatedNetwork', () => {
  it('takes the sandbox off traefik-net and puts frps there under its name, with the new image and frps ports', () => {
    const out = yaml.load(withIsolatedNetwork(before('p9m-a'), 'p9m-a', env)!) as { services: Record<string, Svc> }
    const { sandbox, frps, socat } = out.services
    expect(sandbox.networks).toEqual(['default'])
    expect(sandbox.image).toBe('ghcr.io/csakaszamok/foxglove:0.11.0-sysbox')
    expect(sandbox.environment?.FRP_SERVER_PORT).toBe('65000')
    expect(frps.networks).toEqual({ default: null, 'traefik-net': { aliases: ['p9m-a'] } })
    expect(socat.networks).toEqual({ default: { aliases: ['registry-cache', 'registry.example.com', 'p9m.example.com'] }, 'traefik-net': null })
    expect(socat.command).toContain('8080:p9m-a-frps:65080 7500:p9m-a-frps:65075 5000:p9m-registry-cache:5000 5001:p9m-registry-cache-ghcr:5000 80:traefik:80 443:traefik:443')
    expect(JSON.stringify(socat.healthcheck)).toContain('$$FRPS_API_AUTH') // the rest as it was
  })

  it('keeps the kind of image (dind) and does nothing to a sandbox moved already', () => {
    const moved = withIsolatedNetwork(before('p9m-b', 'dind'), 'p9m-b', env)!
    expect(moved).toContain('foxglove:0.11.0-dind')
    expect(withIsolatedNetwork(moved, 'p9m-b', env)).toBeNull()
  })

  it("is what a runtime makes now: frps's ports in frps.toml", () => {
    expect(withFrpsPorts(frpsToml('t', 'p').replace('65000', '7000').replace('65080', '8080').replace('65075', '7500'))).toBe(frpsToml('t', 'p'))
    expect(frpsToml('t', 'p')).toMatch(/^bindPort = 65000\nvhostHTTPPort = 65080\n[\s\S]*\nport = 65075\n/)
  })
})

describe('migrateIsolatedNetwork', () => {
  beforeEach(() => { vi.mocked(composeUp).mockClear(); vi.mocked(composeCreate).mockClear() })
  const usersDir = (names: string[]) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9m-net-'))
    for (const n of names) {
      fs.mkdirSync(`${dir}/${n}`)
      fs.writeFileSync(`${dir}/${n}/docker-compose.yml`, before(n))
      fs.writeFileSync(`${dir}/${n}/frps.toml`, frpsToml('t', 'p').replace('65000', '7000').replace('65080', '8080').replace('65075', '7500'))
    }
    return dir
  }

  it('recreates a running sandbox, leaves an asleep one stopped, only rewrites a deep-sleeping one', async () => {
    const dir = usersDir(['p9m-run', 'p9m-zzz', 'p9m-deep'])
    vi.mocked(getSandboxState).mockImplementation(async (n: string) => n === 'p9m-run' ? state('running') : n === 'p9m-zzz' ? state('exited') : null)
    expect((await migrateIsolatedNetwork(dir, env)).sort()).toEqual(['p9m-deep', 'p9m-run', 'p9m-zzz'])
    expect(vi.mocked(composeUp).mock.calls.map(c => path.basename(path.dirname(c[0])))).toEqual(['p9m-run'])
    expect(vi.mocked(composeCreate).mock.calls.map(c => path.basename(path.dirname(c[0])))).toEqual(['p9m-zzz'])
    expect(fs.readFileSync(`${dir}/p9m-deep/frps.toml`, 'utf8')).toBe(frpsToml('t', 'p'))
  })

  it('puts both files back when recreating fails, to try again on the next start', async () => {
    const dir = usersDir(['p9m-a'])
    const compose = fs.readFileSync(`${dir}/p9m-a/docker-compose.yml`, 'utf8'), toml = fs.readFileSync(`${dir}/p9m-a/frps.toml`, 'utf8')
    vi.mocked(getSandboxState).mockResolvedValue(state('running'))
    vi.mocked(composeUp).mockRejectedValueOnce(new Error('boom'))
    expect(await migrateIsolatedNetwork(dir, env)).toEqual([])
    expect(fs.readFileSync(`${dir}/p9m-a/docker-compose.yml`, 'utf8')).toBe(compose)
    expect(fs.readFileSync(`${dir}/p9m-a/frps.toml`, 'utf8')).toBe(toml)
  })
})
