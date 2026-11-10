import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

const compose = yaml.load(fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8')) as {
  services: Record<string, { environment?: Record<string, string>; command?: string[] }>
}

describe('docker-compose.yml', () => {
  // The p9m service lists its environment explicitly: a setting not listed never reaches the container
  it('passes the app access settings to Purgatorium', () => {
    const env = compose.services.p9m.environment ?? {}
    expect(env.APPS_ACCESS_DEFAULT).toBe('${APPS_ACCESS_DEFAULT:-owner}')
    expect(env.APP_ACCESS_SECRET).toBe('${APP_ACCESS_SECRET:-}')
  })
  it('passes the sleep limits to Purgatorium', () => {
    const env = compose.services.p9m.environment ?? {}
    expect(env.SANDBOX_MAX_IDLE_TIMEOUT).toBe('${SANDBOX_MAX_IDLE_TIMEOUT:-}')
    expect(env.SANDBOX_MAX_DEEP_SLEEP_AFTER).toBe('${SANDBOX_MAX_DEEP_SLEEP_AFTER:-}')
  })
  it('the UI is at UI_HOST, p9m.<HOST_DOMAIN> by default, for Traefik and the sandboxes alike', () => {
    const p9m = compose.services.p9m as { environment?: Record<string, string>; labels?: Record<string, string> }
    const ui = '${UI_HOST:-p9m.${HOST_DOMAIN:-lvh.me}}'
    expect(p9m.environment?.UI_HOST).toBe('${UI_HOST:-}')
    expect(p9m.environment?.PUBLIC_URL).toBe(`\${PUBLIC_URL:-http://${ui}}`)
    // USER_HOST (the users' address): sbx.<HOST_DOMAIN> when empty
    const user = '${USER_HOST:-sbx.${HOST_DOMAIN:-lvh.me}}'
    expect(p9m.environment?.USER_HOST).toBe(user)
    expect(p9m.labels?.['traefik.http.routers.p9m.rule']).toBe(`Host(\`${ui}\`) || Host(\`${user}\`)`)
    const traefik = compose.services.traefik as unknown as { networks: Record<string, { aliases?: string[] } | null> }
    expect(traefik.networks['traefik-net']?.aliases).toEqual(expect.arrayContaining([ui, user]))
  })
  it('the TCP and Docker addresses are under APPS_DOMAIN, HOST_DOMAIN when it is empty', () => {
    const p9m = compose.services.p9m as { environment?: Record<string, string>; labels?: Record<string, string> }
    expect(p9m.environment?.APPS_DOMAIN).toBe('${APPS_DOMAIN:-}')
    expect(p9m.labels?.['traefik.tcp.routers.p9m-tcp.rule']).toBe('HostSNIRegexp(`^[a-z0-9-]+-(tcp|docker)[.]${APPS_DOMAIN:-${HOST_DOMAIN:-lvh.me}}$$`)')
  })
  // Not on the published API port: Traefik reaches them on the internal one
  it("Traefik reads the access middlewares from Purgatorium's internal port", () => {
    expect(compose.services.traefik.command).toContain('--providers.http.endpoint=http://p9m-internal:3001/traefik/access')
    const p9m = compose.services.p9m as unknown as { networks: Record<string, { aliases?: string[] } | null> }
    expect(p9m.networks['sablier-net']?.aliases).toEqual(['p9m-internal'])
    expect((compose as unknown as { networks: Record<string, { internal?: boolean }> }).networks['sablier-net'].internal).toBe(true)
  })
  // The catalog's plugin holds back streamed responses (Server-Sent Events, an LLM's answer) until 4 KB have gathered
  it('Traefik loads the Sablier plugin that p9m-init installs, not the catalog\'s', () => {
    const traefik = compose.services.traefik as unknown as { command: string[]; volumes: string[] }
    expect(traefik.command).toContain('--experimental.localPlugins.sablier.moduleName=github.com/sablierapp/sablier-traefik-plugin')
    expect(traefik.command.some(c => c.startsWith('--experimental.plugins.'))).toBe(false)
    expect(traefik.volumes).toContain('sablier_plugin:/plugins-local/src/github.com/sablierapp/sablier-traefik-plugin:ro')
    expect((compose.services['p9m-init'] as unknown as { volumes: string[] }).volumes).toContain('sablier_plugin:/out/sablier-plugin')
  })
  // Its API (every router: every user's sandboxes and apps) was open to the sandboxes on traefik-net
  it("Traefik's API is not served", () => {
    expect((compose.services.traefik.command ?? []).some((c: string) => c.startsWith('--api'))).toBe(false)
  })
})

