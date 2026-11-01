import { finishLogin, LoginError, OIDC_FLOW_COOKIE, purgatoriumRedirectUri } from '../../../services/oidc'
import { cookieHeader, createSession, getCookie, SESSION_COOKIE, SESSION_MAX_AGE } from '../../../services/session'
import { onAdminHost, userUrl } from '../../../services/userHost'
import { purgatoriumSignInRefusal, oidcAdmin } from '../../../services/allowlist'
import { rememberName } from '../../../services/hub/names'
import { nextAfterSignIn, NEXT_COOKIE } from '../../../services/appAccess/start'
import { recordSignIn } from '../../../services/userStats'
import { CLIENT_IP_HEADER, oidcSignInFailed } from '../../../services/loginGuard'

export default async (req: Request): Promise<Response> => {
  const headers = new Headers()
  headers.append('set-cookie', cookieHeader(OIDC_FLOW_COOKIE, '', 0))
  const address = req.headers.get(CLIENT_IP_HEADER) ?? 'unknown'
  try {
    const callbackUrl = new URL(`${purgatoriumRedirectUri(req)}${new URL(req.url).search}`)
    const { email, name } = await finishLogin(callbackUrl, getCookie(req, OIDC_FLOW_COOKIE), e => purgatoriumSignInRefusal(e))
    // USER_HOST on: this address is the admin's; a user signs in on theirs (the provider knows them already)
    if (!oidcAdmin(email) && onAdminHost(req)) {
      headers.set('location', `${userUrl()}/auth/oidc`)
      return new Response(null, { status: 303, headers })
    }
    rememberName(email, name)
    recordSignIn(email)
    headers.append('set-cookie', cookieHeader(SESSION_COOKIE, createSession(email, oidcAdmin(email) ? 'admin' : 'user'), SESSION_MAX_AGE))
    // Signed in for a sandbox app (p9m.access): back to it
    const next = nextAfterSignIn(req)
    headers.set('location', next ?? '/')
    if (next) headers.append('set-cookie', cookieHeader(NEXT_COOKIE, '', 0))
  } catch (err) {
    oidcSignInFailed(address, err)
    const msg = err instanceof LoginError ? err.message : 'Sign-in failed, please try again'
    headers.set('location', `/login?error=${encodeURIComponent(msg)}`)
  }
  return new Response(null, { status: 303, headers })
}
