/**
 * Paths only Traefik asks, on Purgatorium's internal port (not published like the API port, not routed by Traefik):
 * the forwardAuth decision, the HTTP provider's middlewares and the error-page middleware's 404 page. Elsewhere they
 * are 404, so nobody outside learns the sandboxes' names or their apps' levels from them.
 */
export const INTERNAL_PORT = 3001
const INTERNAL = new Set(['/auth/app', '/traefik/access', '/errors/404'])
export const internalOnly = (path: string): boolean => INTERNAL.has(path.replace(/\/+$/, '') || '/')

/** The network only Traefik and Purgatorium are on (docker-compose.yml: internal, no sandbox), where it is p9m-internal */
export const INTERNAL_NETWORK = 'sablier-net'

type SelfInspect = () => Promise<{ NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> } }>

/**
 * Where the internal port listens: Purgatorium's address on INTERNAL_NETWORK. On every address, a sandbox (it is on
 * traefik-net with Purgatorium) could read every sandbox's name and its apps' levels from it. Null when there is no
 * such address (not in Docker, or a compose file from before without the network): then every address, with a warning.
 */
export async function internalListenAddress(inspect?: SelfInspect): Promise<string | null> {
  try {
    const self = await (inspect ?? (async () => {
      const [{ default: Dockerode }, { selfContainerId }] = await Promise.all([import('dockerode'), import('../selfContainer')])
      return new Dockerode({ socketPath: '/var/run/docker.sock' }).getContainer(selfContainerId()).inspect()
    }))()
    return self.NetworkSettings?.Networks?.[INTERNAL_NETWORK]?.IPAddress || null
  } catch { return null }
}
