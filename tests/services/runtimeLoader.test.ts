import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadRuntime, listRuntimes } from '../../services/runtimeLoader'

const DIR = path.join(process.cwd(), 'runtimes')
type Service = { privileged?: boolean; runtime?: string; labels?: Record<string, string> }
const servicesOf = (name: string) => loadRuntime(name, DIR).docker_compose.services as Record<string, Service>

function expectSshMounts(name: string) {
  const sb = (loadRuntime(name, DIR).docker_compose.services as Record<string, { image: string; volumes: string[] }>).sandbox
  expect(sb.image).toBe(`ghcr.io/csakaszamok/foxglove:0.11.0-${name}`)
  expect(sb.volumes).toEqual(expect.arrayContaining(['${sandbox_dir}/authorized_keys:/etc/instance/authorized_keys:ro', '${sandbox_dir}/ssh-host-keys:/etc/ssh/host-keys']))
  expect(sb).toMatchObject({ cpus: '${cpus}', mem_limit: '${memory}', memswap_limit: '${memory}' })
}

// On traefik-net a sandbox reached every other sandbox's ports: it is on its own network, frps there under its name
describe('the runtimes keep a sandbox off the network the sandboxes share', () => {
  for (const name of ['dind', 'sysbox']) {
    it(name, () => {
      const s = loadRuntime(name, DIR).docker_compose.services as Record<string, { networks?: unknown; environment?: Record<string, string>; command?: string }>
      expect(s.sandbox.networks).toEqual(['default'])
      expect(s.sandbox.environment?.FRP_SERVER_PORT).toBe('65000')
      expect(s.frps.networks).toEqual({ default: null, 'traefik-net': { aliases: ['${name}'] } })
      expect(s.socat.networks).toEqual({ default: { aliases: ['registry-cache', '${registry_host}', '${ui_host}', '${user_host}'] }, 'traefik-net': null })
      expect(s.socat.command).toContain('8080:${name}-frps:65080 7500:${name}-frps:65075')
      // Purgatorium's Docker Hub and ghcr.io caches, for the sandbox's dockerd
      expect(s.socat.command).toContain('5000:p9m-registry-cache:5000 5001:p9m-registry-cache-ghcr:5000')
    })
  }
})

describe('loadRuntime', () => {
  it('loads dind: privileged sandbox with frps and socat, labelled with runtime and template', () => {
    const r = loadRuntime('dind', DIR)
    expect(r.name).toBe('dind')
    expect(r.description).toMatch(/privileged/i)
    const s = servicesOf('dind')
    expect(Object.keys(s)).toEqual(['sandbox', 'frps', 'socat'])
    expect(s.sandbox.privileged).toBe(true)
    expect(s.sandbox.labels?.['p9m.runtime']).toBe('${runtime_name}')
    expect(s.sandbox.labels?.['p9m.template']).toBe('${template_name}')
    expect(s.sandbox.labels?.['p9m.compose']).toBe('${compose_source}')
    expect(s.sandbox.labels?.['p9m.ssh']).toBe('true')
    expect(r.daemon_json).toBeUndefined()
    expectSshMounts('dind')
  })

  it('loads sysbox: sysbox-runc instead of privileged, TLS through daemon_json', () => {
    const r = loadRuntime('sysbox', DIR)
    const s = servicesOf('sysbox')
    expect(s.sandbox.runtime).toBe('sysbox-runc')
    expect(s.sandbox.privileged).toBeUndefined()
    expect(s.sandbox.labels?.['p9m.runtime']).toBe('${runtime_name}')
    expect(s.sandbox.labels?.['p9m.compose']).toBe('${compose_source}')
    expect(s.sandbox.labels?.['p9m.ssh']).toBe('true')
    expect(r.daemon_json?.tlsverify).toBe(true)
    expectSshMounts('sysbox')
  })

  it('refuses unknown names and anything that is not a plain name', () => {
    for (const n of ['nope', '../templates/starter/compose', 'dind/../dind', '..\\dind', '', 'Dind']) {
      expect(() => loadRuntime(n, DIR), n).toThrow(`Runtime not found: ${n}`)
    }
  })
})

describe('listRuntimes', () => {
  it('lists dind and sysbox, sorted, each with a description', () => {
    const list = listRuntimes(DIR)
    expect(list.map(r => r.name)).toEqual(['dind', 'sysbox'])
    for (const r of list) expect(r.description).toBeTruthy()
  })

  it('returns [] for a missing directory', () => {
    expect(listRuntimes(path.join(DIR, 'missing'))).toEqual([])
  })

  it('skips a runtime whose YAML does not parse', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9m-runtimes-'))
    try {
      fs.writeFileSync(path.join(dir, 'good.yaml'), 'description: ok\ndocker_compose: {}\n')
      fs.writeFileSync(path.join(dir, 'bad.yaml'), 'docker_compose: [\n')
      expect(listRuntimes(dir).map(r => r.name)).toEqual(['good'])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('the sandbox router reaches socat by name', () => {
  // Not by the container's address: after a wake Traefik learns that only ~1.5 s after Sablier lets the
  // request through, and meanwhile sent it to the stopped container's empty address (500 Internal Server Error)
  it.each(['dind', 'sysbox'])('%s', name => {
    const labels = servicesOf(name).socat.labels ?? {}
    expect(labels['traefik.http.services.frps-${name}.loadbalancer.server.url']).toBe('http://${name}-socat:8080')
    expect(labels['traefik.http.services.frps-${name}.loadbalancer.server.port']).toBeUndefined()
  })
})

describe('the sandbox router exists only while the sandbox runs', () => {
  // Asleep, its requests fall to p9m's catch-all, which wakes it within the owner's limits
  it.each(['dind', 'sysbox'])('%s', name => {
    expect(servicesOf(name).socat.labels?.['traefik.docker.allownonrunning']).toBeUndefined()
  })
})

describe('the sandbox keeps /opt, /root, /home and /srv in named volumes', () => {
  // Without them, a deep sleep (compose down) or a removed container lost what was written there
  it.each(['dind', 'sysbox'])('%s', name => {
    const r = loadRuntime(name, DIR)
    const sb = (r.docker_compose.services as Record<string, { volumes: string[] }>).sandbox
    expect(sb.volumes).toEqual(expect.arrayContaining(['sandbox_opt:/opt', 'sandbox_root:/root', 'sandbox_home:/home', 'sandbox_srv:/srv']))
    expect(Object.keys((r.docker_compose as { volumes: Record<string, unknown> }).volumes)).toEqual(expect.arrayContaining(['docker_data', 'sandbox_opt', 'sandbox_root', 'sandbox_home', 'sandbox_srv']))
  })
})
