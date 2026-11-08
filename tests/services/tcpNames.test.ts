import { describe, it, expect } from 'vitest'
import { frpcName, tcpAllowed, tcpPortsOf, type InnerContainer } from '../../services/tcpNames'

const c = (name: string, labels: Record<string, string>, ports: InnerContainer['Ports']): InnerContainer =>
  ({ Names: [`/${name}`], Labels: labels, Ports: ports })

describe('frpcName (same rules as foxglove frpc.tmpl)', () => {
  it('uses the p9m.subdomain label when set', () => {
    expect(frpcName('shop', { 'p9m.subdomain': 'db' }, 'pg', 5432)).toBe('shop-db')
  })
  it('uses the p9m.subdomain label', () => {
    expect(frpcName('shop', { 'p9m.subdomain': 'db' }, 'pg', 5432)).toBe('shop-db')
    expect(frpcName('shop', { 'p9m.subdomain': 'db' }, 'pg', 5432)).toBe('shop-db')
  })
  it('uses stack and container name for compose containers', () => {
    expect(frpcName('shop', { 'com.docker.compose.project': 'My_App' }, 'My_App-db_1', 5432)).toBe('shop-my-app-my-app-db-1-port5432')
  })
  it('uses the container name alone otherwise', () => {
    expect(frpcName('shop', {}, 'Redis_Main', 6379)).toBe('shop-redis-main-port6379')
  })
})

// The naming rules below, on a server whose apps are public by default
const PUBLIC = { APPS_ACCESS_DEFAULT: 'public' } as NodeJS.ProcessEnv

describe('tcpPortsOf', () => {
  const inner = [
    c('db', { 'com.docker.compose.project': 'inner' }, [
      { IP: '0.0.0.0', PrivatePort: 5432, PublicPort: 5432, Type: 'tcp' },
      { IP: '::', PrivatePort: 5432, PublicPort: 5432, Type: 'tcp' },
    ]),
    c('portainer', { 'com.docker.compose.project': 'inner', 'p9m.subdomain': 'portainer' }, [
      { IP: '127.0.0.1', PrivatePort: 9000, PublicPort: 9000, Type: 'tcp' },
    ]),
    c('dns', {}, [{ IP: '0.0.0.0', PrivatePort: 53, PublicPort: 5353, Type: 'udp' }]),
    c('internal', {}, [{ PrivatePort: 8080, Type: 'tcp' }]),
    c('any', {}, [{ PrivatePort: 7000, PublicPort: 7000, Type: 'tcp' }]),
  ]

  it('gives each port of a p9m.subdomain container with several ports its own name', () => {
    const web = c('web', { 'p9m.subdomain': 'shop' }, [
      { IP: '0.0.0.0', PrivatePort: 8080, PublicPort: 8080, Type: 'tcp' },
      { IP: '0.0.0.0', PrivatePort: 5432, PublicPort: 5432, Type: 'tcp' },
    ])
    expect(tcpPortsOf('sb', [web], 'lvh.me', PUBLIC)).toEqual([
      { host: 'sb-shop-port5432-tcp.lvh.me', port: 5432, privatePort: 5432 },
      { host: 'sb-shop-port8080-tcp.lvh.me', port: 8080, privatePort: 8080 },
    ])
    const one = c('web', { 'p9m.subdomain': 'shop' }, [{ IP: '0.0.0.0', PrivatePort: 5432, PublicPort: 5432, Type: 'tcp' }])
    expect(tcpPortsOf('sb', [one], 'lvh.me', PUBLIC)).toEqual([{ host: 'sb-shop-tcp.lvh.me', port: 5432, privatePort: 5432 }])
  })

  it("never gives an inner container the sandbox's own SSH name (<sandbox>-shell-tcp)", () => {
    const shell = c('shell', { 'p9m.subdomain': 'shell' }, [{ IP: '0.0.0.0', PrivatePort: 22, PublicPort: 2200, Type: 'tcp' }])
    expect(tcpPortsOf('sb', [shell], 'lvh.me', PUBLIC)).toEqual([])
    const p9m = c('shell', { 'p9m.subdomain': 'shell' }, [{ IP: '0.0.0.0', PrivatePort: 22, PublicPort: 2200, Type: 'tcp' }])
    expect(tcpPortsOf('sb', [p9m], 'lvh.me', PUBLIC)).toEqual([])
    // only the label in effect counts
    const both = c('ssh', { 'p9m.subdomain': 'ssh' }, [{ IP: '0.0.0.0', PrivatePort: 22, PublicPort: 2200, Type: 'tcp' }])
    expect(tcpPortsOf('sb', [both], 'lvh.me', PUBLIC)).toEqual([{ host: 'sb-ssh-tcp.lvh.me', port: 2200, privatePort: 22 }])
    const reserved = c('ssh', { 'p9m.subdomain': 'shell' }, [{ IP: '0.0.0.0', PrivatePort: 22, PublicPort: 2200, Type: 'tcp' }])
    expect(tcpPortsOf('sb', [reserved], 'lvh.me', PUBLIC)).toEqual([])
  })

  it('lists only TCP ports published on all interfaces, once each, with the -tcp name', () => {
    expect(tcpPortsOf('shop', inner, 'lvh.me', PUBLIC)).toEqual([
      { host: 'shop-inner-db-port5432-tcp.lvh.me', port: 5432, privatePort: 5432 },
      { host: 'shop-any-port7000-tcp.lvh.me', port: 7000, privatePort: 7000 },
    ])
  })

  it('gives each port of a p9m.subdomain container with several ports its own name', () => {
    const web = c('web', { 'p9m.subdomain': 'shop' }, [
      { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 80, Type: 'tcp' },
      { IP: '0.0.0.0', PrivatePort: 443, PublicPort: 443, Type: 'tcp' },
    ])
    expect(tcpPortsOf('sb', [web], 'lvh.me', PUBLIC).map(p => p.host)).toEqual(['sb-shop-port80-tcp.lvh.me', 'sb-shop-port443-tcp.lvh.me'])
  })

  it("gives the container's own port (what the service is) and the p9m.connect.user label", () => {
    const ssh = c('ssh', { 'p9m.subdomain': 'ssh', 'p9m.connect.user': 'demo' }, [{ IP: '0.0.0.0', PrivatePort: 22, PublicPort: 2022, Type: 'tcp' }])
    expect(tcpPortsOf('sb', [ssh], 'lvh.me', PUBLIC)).toEqual([{ host: 'sb-ssh-tcp.lvh.me', port: 2022, privatePort: 22, user: 'demo' }])
  })
})

// A -tcp address is raw TCP: no sign-in can stand in front of it, so it must never open an app its owner closed
describe('tcp addresses and app access', () => {
  const port = [{ IP: '0.0.0.0', PrivatePort: 5678, PublicPort: 5678, Type: 'tcp' }]
  const OWNER = {} as NodeJS.ProcessEnv // APPS_ACCESS_DEFAULT unset: owner

  it('gives no -tcp address to an owner or domain app, labelled or by default', () => {
    expect(tcpPortsOf('sb', [c('echo', {}, port)], 'lvh.me', OWNER)).toEqual([])
    expect(tcpPortsOf('sb', [c('echo', { 'p9m.access': 'owner' }, port)], 'lvh.me', PUBLIC)).toEqual([])
    expect(tcpPortsOf('sb', [c('echo', { 'p9m.access': 'domain' }, port)], 'lvh.me', PUBLIC)).toEqual([])
    expect(tcpPortsOf('sb', [c('echo', { 'p9m.access': 'nonsense' }, port)], 'lvh.me', PUBLIC)).toEqual([])
  })

  it('gives one to a public app, and to a container that asks with p9m.tcp: "true"', () => {
    expect(tcpPortsOf('sb', [c('echo', { 'p9m.access': 'public' }, port)], 'lvh.me', OWNER)).toHaveLength(1)
    expect(tcpPortsOf('sb', [c('echo', {}, port)], 'lvh.me', PUBLIC)).toHaveLength(1)
    expect(tcpPortsOf('sb', [c('db', { 'p9m.tcp': 'true', 'p9m.access': 'owner' }, port)], 'lvh.me', OWNER)).toHaveLength(1)
    expect(tcpAllowed({ 'p9m.tcp': ' TRUE ' }, OWNER)).toBe(true)
    expect(tcpAllowed({ 'p9m.tcp': 'yes' }, OWNER)).toBe(false)
  })
})
