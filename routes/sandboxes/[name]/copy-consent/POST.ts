import { pageSession } from '../../../../services/ui/layout'
import { sameOrigin } from '../../../../services/principal'
import { grantCopyConsent, withdrawCopyConsent } from '../../../../services/copyConsent'
import { copyConsentPage, crossSite, notOwner, ownedBy } from '../../../../services/ui/copyConsentPage'

/** Only from the owner's browser session: a token (a coding agent) cannot give this permission. */
export default async (req: Request): Promise<Response> => {
  const session = pageSession(req)
  if (!session) return new Response(null, { status: 303, headers: { location: '/login' } })
  if (!sameOrigin(req)) return crossSite()
  let name: string
  try { name = decodeURIComponent(new URL(req.url).pathname.split('/')[2]) } catch { return notOwner() }
  if (!await ownedBy(name, session.sub)) return notOwner()
  const decision = String((await req.formData().catch(() => null))?.get('decision') ?? '')
  if (decision === 'allow') { grantCopyConsent(name, session.sub); return copyConsentPage(name, 'Allowed.') }
  if (decision === 'withdraw') { withdrawCopyConsent(name); return copyConsentPage(name, 'Withdrawn.') }
  return copyConsentPage(name)
}
