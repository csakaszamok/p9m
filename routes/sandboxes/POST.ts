import { requirePrincipal } from '../../services/principal'
import { createSandboxRequest } from '../../services/sandboxCreate'

export const openapi = {
  mcp: { name: 'create_sandbox' },
  summary: 'Create sandbox',
  tags: ['sandboxes'],
  requestBody: {
    required: false,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,62}$', example: 'user1', description: 'Omit for a generated one (six letters and digits, k3x9q2): the name in the answer says which. GET /sandbox-name suggests one first.' },
            runtime: { type: 'string', example: 'dind', description: 'How the sandbox runs (GET /runtimes). Omit for DEFAULT_RUNTIME (auto: sysbox where installed, else dind).' },
            template: { type: 'string', example: 'starter', description: 'What runs inside (GET /templates). Omit for DEFAULT_TEMPLATE (starter).' },
            cpus: { type: 'number', example: 2, description: 'CPU limit (cores). Default SANDBOX_CPUS; users up to SANDBOX_MAX_CPUS, the admin up to the host.' },
            memory: { type: 'string', example: '4g', description: 'Memory limit (512m, 4g). Default SANDBOX_MEMORY; users up to SANDBOX_MAX_MEMORY, the admin up to the host.' },
            ssh_keys: { type: 'array', maxItems: 10, items: { type: 'string' }, description: 'Extra SSH public keys for this sandbox only (your keys from /ssh-keys always get in)' },
            create_inner_stack: { type: 'boolean', default: true, description: "Whether to deploy the template's starter stack, as it is (it cannot be changed; deploy your own apps afterwards)" },
            idle_timeout: { type: 'string', pattern: '^([1-9][0-9]*(s|m|h|d)|0|off)$', example: '30m', description: 'Stop the sandbox after this long without HTTP traffic; the next request wakes it. Days are kept as hours (1d = 24h). 0 or off = never. Omit for template idle_timeout (default 30m).' },
            deep_sleep_after: { type: 'string', pattern: '^([1-9][0-9]*(m|h|d)|0|off)$', example: '7d', description: 'Take the sandbox down (containers + network freed, data kept) after it has been stopped this long; the next request rebuilds it. "off" disables. Omit for template deep_sleep_after (default 7d).' }
          }
        }
      }
    }
  },
  responses: {
    201: {
      description: 'Sandbox created — certs returned only once',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              docker_host: { type: 'string', example: '' },
              ca_cert: { type: 'string' },
              client_cert: { type: 'string' },
              client_key: { type: 'string' },
              registry_url: { type: 'string', example: 'registry.my.local' },
              registry_username: { type: 'string' },
              registry_password: { type: 'string' },
              tunnel_urls: { type: 'array', items: { type: 'string' } },
              extras: { type: 'object', additionalProperties: { type: 'string' }, description: 'Template-specific outputs (e.g. portainer_password, portainer_url)' }
            }
          }
        }
      }
    },
    400: { description: 'Invalid name' },
    401: { description: 'Unauthorized' },
    409: { description: 'Name taken/conflicting, or sandbox limit reached' },
    503: { description: 'No free ports available in template range' }
  },
  security: [{ bearerAuth: [] }],
}

export default async (req: Request): Promise<Response> => {
  const p = requirePrincipal(req)
  if (p instanceof Response) return p
  const body = await req.json().catch(() => ({}))
  return createSandboxRequest(p, body && typeof body === 'object' && !Array.isArray(body) ? body : {})
}
