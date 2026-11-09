import { pageSession } from '../../../../services/ui/layout'
import { cookieHeader } from '../../../../services/session'
import { NEXT_COOKIE } from '../../../../services/appAccess/start'
import { signNext } from '../../../../services/appAccess/sign'
import { onAdminHost, userUrl } from '../../../../services/userHost'
import { copyConsentPage, notOwner, ownedBy } from '../../../../services/ui/copyConsentPage'

const goTo = (location: string, cookie?: string) => new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store', ...(cookie ? { 'set-cookie': cookie } : {}) } })

/** The link scripts/clone-sandbox.mjs prints: a page for the sandbox's owner, who has no other web UI. */
export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url)
  const here = `${url.pathname}${url.search}`
  const session = pageSession(req)
  if (session?.role !== 'admin' && onAdminHost(req)) return goTo(`${userUrl()}${here}`)
  if (!session) return goTo('/login', cookieHeader(NEXT_COOKIE, signNext(here), 600))
  let name: string
  try { name = decodeURIComponent(url.pathname.split('/')[2]) } catch { return notOwner() }
  if (!await ownedBy(name, session.sub)) return notOwner()
  return copyConsentPage(name)
}
