import { beginLogin, oidcEnabled, purgatoriumRedirectUri, OIDC_FLOW_COOKIE } from '../../../services/oidc'
import { cookieHeader } from '../../../services/session'
import { errorDetail } from '../../../services/outboundNet'

export default async (req: Request): Promise<Response> => {
  if (!oidcEnabled()) return new Response(null, { status: 303, headers: { location: '/login' } })
  try {
    const { url, flow } = await beginLogin(purgatoriumRedirectUri(req))
    return new Response(null, { status: 302, headers: { location: url, 'set-cookie': cookieHeader(OIDC_FLOW_COOKIE, flow, 600) } })
  } catch (err) {
    console.error('[oidc] discovery failed:', errorDetail(err))
    return new Response(null, { status: 303, headers: { location: `/login?error=${encodeURIComponent('Sign-in provider unavailable')}` } })
  }
}
