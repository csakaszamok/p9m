import { defaultRuntime, runtimeAllowed } from '../../services/defaultRuntime'
import { requirePrincipal } from '../../services/principal'
import { listRuntimes } from '../../services/runtimeLoader'

export const openapi = {
  mcp: { name: 'list_runtimes' },
  summary: 'List the runtimes new sandboxes may use (how a sandbox runs: dind, sysbox, kata; ALLOWED_RUNTIMES)',
  tags: ['templates'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'The runtimes; default is the one used when a create request names none',
      content: {
        'application/json': {
          schema: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, default: { type: 'boolean' } } }
          }
        }
      }
    },
    401: { description: 'Unauthorized' }
  }
}

export default async (req: Request): Promise<Response> => {
  const p = requirePrincipal(req)
  if (p instanceof Response) return p
  const def = await defaultRuntime()
  return Response.json(listRuntimes().filter(r => runtimeAllowed(r.name)).map(r => ({ name: r.name, description: r.description, default: r.name === def })))
}
