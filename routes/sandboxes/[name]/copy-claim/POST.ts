import { requirePrincipal } from '../../../../services/principal'
import { getOwnedSandbox } from '../../../../services/access'
import { isAdminOwner } from '../../../../services/allowlist'
import { recordCopy, takeCopyConsent, type CopyRecord } from '../../../../services/copyConsent'
import { userUrl } from '../../../../services/userHost'

export const openapi = {
  mcp: false,
  summary: 'Record a copy of the sandbox and use up its owner\'s permission (admin; scripts/clone-sandbox.mjs)',
  tags: ['sandboxes'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: '{ name, owner, via }: consent, own (an admin\'s sandbox), or no_consent' },
    400: { description: 'no_consent without a reason' },
    401: { description: 'Unauthorized' },
    403: { description: 'Not the admin; or { error: "consent_required", url }: the page the owner has to open' },
    404: { description: 'Sandbox not found' },
  },
}

export default async (req: Request): Promise<Response> => {
  const p = requirePrincipal(req)
  if (p instanceof Response) return p
  if (p.role !== 'admin') return Response.json({ error: 'Only the admin copies a sandbox' }, { status: 403 })
  const name = new URL(req.url).pathname.split('/')[2]
  let sandbox
  try { sandbox = await getOwnedSandbox(p, name) } catch { return Response.json({ error: `Sandbox not found: ${name}` }, { status: 404 }) }
  const body = await req.json().catch(() => ({})) as { no_consent?: unknown; reason?: unknown; what?: unknown }
  const what = typeof body.what === 'string' && body.what.trim() ? { what: body.what.trim().slice(0, 100) } : {}
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  let record: CopyRecord
  if (body.no_consent === true) {
    if (!reason) return Response.json({ error: 'no_consent needs a reason' }, { status: 400 })
    record = { at: new Date().toISOString(), by: p.sub, via: 'no_consent', reason, ...what }
  } else if (isAdminOwner(sandbox.owner)) {
    record = { at: new Date().toISOString(), by: p.sub, via: 'own', ...what }
  } else if (takeCopyConsent(name)) {
    record = { at: new Date().toISOString(), by: p.sub, via: 'consent', ...what }
  } else {
    return Response.json({ error: 'consent_required', url: `${userUrl()}/sandboxes/${encodeURIComponent(name)}/copy-consent` }, { status: 403 })
  }
  recordCopy(name, record)
  return Response.json({ name, owner: sandbox.owner, via: record.via })
}
