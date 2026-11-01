import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadTemplate, listTemplates, loadTemplateText } from '../../services/templateLoader'

const TEMPLATES_DIR = path.join(process.cwd(), 'templates')
type Service = { ports?: string[]; environment?: Record<string, string>; command?: string[]; labels?: Record<string, string> }
const servicesOf = (name: string) => (loadTemplate(name, TEMPLATES_DIR).compose as { services: Record<string, Service> }).services

describe('loadTemplate', () => {
  it('loads starter: compose.yaml as the stack, template.yaml for the rest', () => {
    const t = loadTemplate('starter', TEMPLATES_DIR)
    expect(t.name).toBe('starter')
    expect(t.description).toMatch(/hello app/)
    expect(Object.keys(servicesOf('starter'))).toEqual(['http-echo'])
    expect(t.before_script).toBeUndefined()
  })

  it('loads portainer: the starter with Portainer and its password', () => {
    const t = loadTemplate('portainer', TEMPLATES_DIR)
    expect(t.description).toMatch(/Portainer/)
    expect(Object.keys(servicesOf('portainer'))).toEqual(['portainer', 'http-echo'])
    expect(t.before_script).toContain('portainer_password')
  })

  it('refuses unknown names, the old single-file names, and anything that is not a plain name', () => {
    for (const n of ['nope', 'dind-standard', 'sysbox-sandbox', '../runtimes', 'starter/../starter', '..\\starter', '']) {
      expect(() => loadTemplate(n, TEMPLATES_DIR), n).toThrow(`Template not found: ${n}`)
    }
  })
})

describe('a template directory without or with an empty template.yaml', () => {
  let dir: string
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9m-templates-'))
    fs.mkdirSync(path.join(dir, 'plain'))
    fs.writeFileSync(path.join(dir, 'plain', 'compose.yaml'), 'services:\n  web:\n    image: nginx\n')
    fs.mkdirSync(path.join(dir, 'empty-meta'))
    fs.writeFileSync(path.join(dir, 'empty-meta', 'compose.yaml'), 'services: {}\n')
    fs.writeFileSync(path.join(dir, 'empty-meta', 'template.yaml'), '')
    fs.mkdirSync(path.join(dir, 'notes'))
    fs.writeFileSync(path.join(dir, 'notes', 'README.md'), 'not a template')
    fs.writeFileSync(path.join(dir, 'stray.yaml'), 'services: {}\n')
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('uses the directory name as description and has no before_script', () => {
    for (const name of ['plain', 'empty-meta']) {
      const t = loadTemplate(name, dir)
      expect(t.description).toBe(name)
      expect(t.before_script).toBeUndefined()
      expect(t.idle_timeout).toBeUndefined()
    }
    expect(loadTemplate('plain', dir).compose).toEqual({ services: { web: { image: 'nginx' } } })
  })

  it('lists only directories with a compose.yaml', () => {
    expect(listTemplates(dir).map(t => t.name)).toEqual(['empty-meta', 'plain'])
    expect(() => loadTemplate('notes', dir)).toThrow('Template not found: notes')
  })

  it('returns [] for a missing directory', () => {
    expect(listTemplates(path.join(dir, 'missing'))).toEqual([])
  })

  it('skips a template whose YAML does not parse, so one broken template does not hide the others', () => {
    fs.mkdirSync(path.join(dir, 'broken'))
    fs.writeFileSync(path.join(dir, 'broken', 'compose.yaml'), 'services: {}\n')
    fs.writeFileSync(path.join(dir, 'broken', 'template.yaml'), 'description: [\n')
    try {
      expect(listTemplates(dir).map(t => t.name)).toEqual(['empty-meta', 'plain'])
    } finally { fs.rmSync(path.join(dir, 'broken'), { recursive: true }) }
  })
})

describe('listTemplates', () => {
  it('returns the built-in templates', () => {
    expect(listTemplates(TEMPLATES_DIR).map(t => t.name)).toEqual(['claude-code', 'claude-code-ecc', 'claude-code-minimal', 'empty', 'portainer', 'starter', 'tcp-demo'])
  })
})

describe('empty', () => {
  it('has nothing to start from: an empty compose.yaml, no before_script', () => {
    const t = loadTemplate('empty', TEMPLATES_DIR)
    expect(t.before_script).toBeUndefined()
    expect(t.compose).toEqual({})
    expect(loadTemplateText('empty', TEMPLATES_DIR).trim()).toBe('')
  })
})

describe('loadTemplateText', () => {
  it('gives compose.yaml as written, comments and ${…} included', () => {
    const text = loadTemplateText('tcp-demo', TEMPLATES_DIR)
    expect(text).toMatch(/^# Published on all interfaces/)
    expect(text).toContain('${demo_password}')
  })
  it('refuses unknown names like loadTemplate', () => {
    expect(() => loadTemplateText('../runtimes', TEMPLATES_DIR)).toThrow('Template not found: ../runtimes')
  })
})

describe('starter and portainer stacks', () => {
  // Published on 127.0.0.1 only: the tunnel still serves them (frpc connects to the
  // container's own IP), but other sandboxes cannot reach them on traefik-net.
  // 127.0.0.1 would make them private (no link): spec 2026-10-02-private-ports
  it('publishes its ports on all interfaces, so each gets a link', () => {
    expect(Object.values(servicesOf('starter')).flatMap(s => s.ports ?? [])).toEqual(['5678:5678'])
    expect(Object.values(servicesOf('portainer')).flatMap(s => s.ports ?? [])).toEqual(['9000:9000', '5678:5678'])
  })

  // Without -H the "local" environment only appears after "Get started" in the UI,
  // so an agent using the Portainer API would find no endpoint.
  it("runs Portainer on the sandbox's Docker socket from the start", () => {
    expect(servicesOf('portainer').portainer.command).toEqual(expect.arrayContaining(['-H', 'unix:///var/run/docker.sock']))
  })
})

describe('tcp-demo', () => {
  const services = servicesOf('tcp-demo')

  it('publishes everything on all interfaces (links and TCP addresses), pgweb too', () => {
    expect(services.db.ports).toEqual(['5432:5432'])
    expect(services.redis.ports).toEqual(['6379:6379'])
    expect(services.ssh.ports).toEqual(['2222:2222'])
    expect(services.pgweb.ports).toEqual(['8081:8081'])
    expect(Object.fromEntries(Object.entries(services).map(([k, s]) => [k, s.labels?.['p9m.subdomain']])))
      .toEqual({ db: 'db', redis: 'redis', ssh: 'ssh', pgweb: 'pgweb' })
  })

  it('passes the demo password only through *PASSWORD* variables, so Starter stack… masks it', () => {
    const text = JSON.stringify(services)
    const occurrences = text.split('${demo_password}').length - 1
    const inPasswordVars = Object.values(services).flatMap(s => Object.entries(s.environment ?? {}))
      .filter(([k, v]) => /password/i.test(k) && v === '${demo_password}').length
    expect(occurrences).toBeGreaterThan(0)
    expect(inPasswordVars).toBe(occurrences)
  })

  it('names the login of Postgres and SSH for the Connect… recipes', () => {
    expect(services.db.labels?.['p9m.connect.user']).toBe('postgres')
    expect(services.ssh.labels?.['p9m.connect.user']).toBe('demo')
  })

  it('makes a demo password in before_script', () => {
    expect(loadTemplate('tcp-demo', TEMPLATES_DIR).before_script).toContain('demo_password')
  })
})
