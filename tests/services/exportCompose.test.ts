import { describe, it, expect } from 'vitest'
// @ts-expect-error a plain .mjs script
import { composeFromInspect, envLine } from '../../scripts/export-compose.mjs'

const ct = (service: string, over: Record<string, unknown> = {}, hc: Record<string, unknown> = {}) => ({
  Name: `/shop-${service}-1`,
  Config: { Image: 'img', Env: ['PATH=/bin', 'SECRET=p$w'], Cmd: ['run'], Entrypoint: null, Labels: { 'com.docker.compose.service': service, 'com.docker.compose.project': 'shop', 'p9m.access': 'owner', 'p9m.tcp': 'true', mine: 'kept' }, ...over },
  HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '', HostPort: '80' }] }, RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: 'shop_default', ...hc },
  NetworkSettings: { Networks: { shop_default: {} } }, Mounts: [],
})
const images = { img: { Config: { Env: ['PATH=/bin'], Cmd: ['run'], Entrypoint: null, Labels: {} } } }
const make = (containers: unknown[], isDir: Record<string, boolean> = {}) => composeFromInspect({ project: 'shop', containers, images, isDir })

describe('the compose file of an exported project', () => {
  it('has only what differs from the image', () => {
    const { compose } = make([ct('web')])
    expect(compose.name).toBe('shop')
    expect(compose.services.web).toEqual({ image: 'img', env_file: ['env/web.env'], labels: { mine: 'kept' }, ports: ['80:8080'], restart: 'unless-stopped' })
  })
  it('leaves out Purgatorium\'s and compose\'s labels', () => {
    expect(JSON.stringify(make([ct('web')]).compose)).not.toMatch(/p9m\.|com\.docker/)
  })
  it('keeps the settings out of the compose file, in one env file per service', () => {
    const m = make([ct('web')])
    expect(JSON.stringify(m.compose)).not.toContain('p$w')
    expect(m.envFiles.web).toBe('SECRET="p\\$w"\n')
  })
  it('an env value keeps its quotes, backslashes, dollars and line breaks', () => {
    expect(envLine('A', 'a"b\\c$d\ne')).toBe('A="a\\"b\\\\c\\$d\\ne"')
    expect(envLine('A', "it's")).toBe('A="it\'s"')
  })
  it('a port kept on 127.0.0.1 stays there', () => {
    const m = make([ct('web', {}, { PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5432' }] } })])
    expect(m.compose.services.web.ports).toEqual(['127.0.0.1:5432:5432'])
  })
  it('named volumes keep their name, so the data finds them', () => {
    const c = { ...ct('db'), Mounts: [{ Type: 'volume', Name: 'shop_data', Destination: '/var/lib/data', RW: true }] }
    const m = make([c])
    expect(m.volumes).toEqual(['shop_data'])
    expect(m.compose.volumes).toEqual({ data: { name: 'shop_data' } })
    expect(m.compose.services.db.volumes).toEqual([{ type: 'volume', source: 'data', target: '/var/lib/data' }])
  })
  it('a bind-mounted folder or file is saved beside it, never mounted from the same path on the target', () => {
    const c = { ...ct('web'), Mounts: [
      { Type: 'bind', Source: '/root/app', Destination: '/app', RW: true },
      { Type: 'bind', Source: '/etc/passwd', Destination: '/cfg', RW: false },
    ] }
    const m = make([c], { '/root/app': true, '/etc/passwd': false })
    expect(m.binds).toEqual([{ n: 0, source: '/root/app', dir: true }, { n: 1, source: '/etc/passwd', dir: false }])
    expect(m.compose.services.web.volumes).toEqual([
      { type: 'bind', source: './binds/0', target: '/app' },
      { type: 'bind', source: './binds/1/file', target: '/cfg', read_only: true },
    ])
  })
  it('a compose dependency comes back from its label', () => {
    const c = ct('web', { Labels: { 'com.docker.compose.service': 'web', 'com.docker.compose.depends_on': 'db:service_healthy:false' } })
    expect(make([c]).compose.services.web.depends_on).toEqual({ db: { condition: 'service_healthy' } })
  })
  it('says so when the app can reach the machine it runs on', () => {
    const c = { ...ct('web', {}, { Privileged: true, NetworkMode: 'host' }), Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/s', RW: true }] }
    const m = make([c])
    expect(m.warnings.join('\n')).toMatch(/privileged/)
    expect(m.warnings.join('\n')).toMatch(/docker\.sock/)
    expect(m.warnings.join('\n')).toMatch(/own network/)
    expect(m.binds).toEqual([])
  })
  it('several replicas: one, and it says so', () => {
    const m = make([ct('web'), ct('web')])
    expect(Object.keys(m.compose.services)).toEqual(['web'])
    expect(m.warnings[0]).toMatch(/replicas/)
  })
  it('a name made to reach outside the export is refused', () => {
    expect(() => make([ct('../x', { Labels: { 'com.docker.compose.service': '../x' } })])).toThrow(/usable service name/)
    expect(() => make([{ ...ct('web'), Mounts: [{ Type: 'volume', Name: '../../etc', Destination: '/d' }] }])).toThrow(/usable volume name/)
  })
})
