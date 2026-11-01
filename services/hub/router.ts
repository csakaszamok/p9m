import fs from 'node:fs'
import path from 'node:path'
import { hubEnabled, hubTitle, hubUrl } from './config'
import { hubViewer, createHubSession, hubCookieHeader, HUB_COOKIE, HUB_OIDC_COOKIE } from './session'
import { hubEntries, type HubEntry } from './list'
import { voteCounts, votedBy, addVote, removeVote } from './votes'
import { rssFeed, jsonFeed } from './feed'
import { feedKeyValid } from './feedKey'
import { rememberName } from './names'
import { refreshImages, imageOf } from './images'
import { hubPage, hubLoginPage } from './page'
import { html, redirect } from '../ui/layout'
import { CUSTOM_LOGO, customLogoFile } from '../ui/brand'
import { aboutPage } from '../ui/aboutPage'
import { sameOrigin } from '../principal'
import { adminLoginEnabled, adminSignIn, CLIENT_IP_HEADER, oidcSignInFailed } from '../loginGuard'
import { beginLogin, finishLogin, oidcEnabled, providerName, LoginError } from '../oidc'
import { hubAllowed, subAllowed } from '../allowlist'
import { getCookie, SESSION_MAX_AGE } from '../session'

const ASSETS: Record<string, [string, string]> = {
  '/assets/hub.js': ['hub.js', 'text/javascript; charset=utf-8'],
  '/assets/hub.css': ['hub.css', 'text/css; charset=utf-8'],
  '/assets/logo.svg': ['logo.svg', 'image/svg+xml'],
  // The About page's (license notices)
  '/assets/style.css': ['style.css', 'text/css; charset=utf-8'],
}
const notFound = () => new Response('Not Found', { status: 404 })
const VOTE = /^\/api\/hub\/apps\/([a-z0-9.-]+)\/vote$/
const IMAGE = /^\/api\/hub\/apps\/([a-z0-9.-]+)\/image$/

interface Deps { entries?: () => Promise<HubEntry[]>; refresh?: (list: HubEntry[]) => void }

/** Everything on the Hub host. Purgatorium's own routes never answer here. */
export async function handleHub(req: Request, deps: Deps = {}): Promise<Response> {
  if (!hubEnabled()) return notFound()
  const url = new URL(req.url)
  const p = url.pathname
  const entries = deps.entries ?? (() => hubEntries())

  if (req.method === 'GET' && ASSETS[p]) {
    const [file, type] = ASSETS[p]
    return new Response(fs.readFileSync(path.join(process.cwd(), 'ui', file)), { headers: { 'Content-Type': type, 'Cache-Control': 'no-cache' } })
  }
  if (req.method === 'GET' && p === '/about') return html(aboutPage())
  if (req.method === 'GET' && p === CUSTOM_LOGO) {
    const logo = customLogoFile()
    return logo ? new Response(logo.body, { headers: { 'Content-Type': logo.type, 'Cache-Control': 'no-cache' } }) : notFound()
  }
  if (req.method === 'GET' && (p === '/feed.xml' || p === '/feed.json')) {
    if (!feedKeyValid(url.searchParams.get('key'))) return notFound()
    const hub = { url: hubUrl(), title: hubTitle() }
    const list = await entries()
    return p === '/feed.xml'
      ? new Response(rssFeed(list, hub), { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'max-age=300' } })
      : new Response(jsonFeed(list, hub), { headers: { 'Content-Type': 'application/feed+json; charset=utf-8', 'Cache-Control': 'max-age=300' } })
  }
  if (req.method === 'GET' && p === '/login') {
    return html(hubLoginPage({ title: hubTitle(), error: url.searchParams.get('error'), sso: oidcEnabled() ? providerName() : null, admin: adminLoginEnabled() }))
  }
  if (req.method === 'POST' && p === '/login') {
    if (!sameOrigin(req)) return new Response('Cross-site request rejected', { status: 403 })
    const form = new URLSearchParams(await req.text())
    const refused = await adminSignIn(req.headers.get(CLIENT_IP_HEADER) ?? 'unknown', form.get('username') ?? '', form.get('password') ?? '')
    if (refused) return redirect(`/login?error=${encodeURIComponent(refused)}`)
    return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': hubCookieHeader(HUB_COOKIE, createHubSession('admin', null), SESSION_MAX_AGE) } })
  }
  if (req.method === 'POST' && p === '/logout') {
    if (!sameOrigin(req)) return new Response('Cross-site request rejected', { status: 403 })
    return new Response(null, { status: 303, headers: { location: '/login', 'set-cookie': hubCookieHeader(HUB_COOKIE, '', 0) } })
  }
  if (req.method === 'GET' && p === '/auth/oidc') {
    if (!oidcEnabled()) return redirect('/login')
    try {
      const { url: to, flow } = await beginLogin(`${hubUrl()}/auth/callback`)
      return new Response(null, { status: 302, headers: { location: to, 'set-cookie': hubCookieHeader(HUB_OIDC_COOKIE, flow, 600) } })
    } catch (err) {
      console.error('[hub] oidc discovery failed:', err instanceof Error ? err.message : err)
      return redirect(`/login?error=${encodeURIComponent('Sign-in provider unavailable')}`)
    }
  }
  if (req.method === 'GET' && p === '/auth/callback') {
    const headers = new Headers({ 'set-cookie': hubCookieHeader(HUB_OIDC_COOKIE, '', 0) })
    const address = req.headers.get(CLIENT_IP_HEADER) ?? 'unknown'
    try {
      const { email, name } = await finishLogin(new URL(`${hubUrl()}/auth/callback${url.search}`), getCookie(req, HUB_OIDC_COOKIE),
        e => (hubAllowed(e) ? null : 'Your account is not allowed to use the Hub.'))
      rememberName(email, name)
      headers.append('set-cookie', hubCookieHeader(HUB_COOKIE, createHubSession(email, name), SESSION_MAX_AGE))
      headers.set('location', '/')
    } catch (err) {
      oidcSignInFailed(address, err)
      headers.set('location', `/login?error=${encodeURIComponent(err instanceof LoginError ? err.message : 'Sign-in failed, please try again')}`)
    }
    return new Response(null, { status: 303, headers })
  }

  const viewer = hubViewer(req)
  if (req.method === 'GET' && p === '/') return viewer ? html(hubPage({ title: hubTitle(), viewer })) : redirect('/login')
  if (req.method === 'GET' && p === '/api/hub') {
    if (!viewer) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    const counts = voteCounts()
    const mine = votedBy(viewer.sub)
    const list = (await entries()).filter(e => visibleTo(e, viewer.sub))
    // The cards' images: fetched in the background, never in the way of the list
    ;(deps.refresh ?? (l => { refreshImages(l).catch(err => console.error('[hub] images:', err)) }))(list)
    const apps = list.map(({ sandbox: _s, service: _v, port: _p, image: _i, ...e }) => {
      const img = imageOf(e.id)
      return { ...e, image: img ? `/api/hub/apps/${e.id}/image?v=${img.version}` : null, votes: counts[e.id] ?? 0, voted: mine.has(e.id), mine: e.owner === viewer.sub }
    })
    return Response.json({ title: hubTitle(), apps }, { headers: { 'Cache-Control': 'no-store' } })
  }
  const image = req.method === 'GET' ? p.match(IMAGE) : null
  if (image) {
    if (!viewer) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    const img = imageOf(image[1])
    if (!img) return notFound()
    // The address carries the version (?v=): a new image gets a new address, so it can be kept long
    return new Response(fs.readFileSync(img.file), { headers: { 'Content-Type': img.type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' } })
  }
  const vote = p.match(VOTE)
  if (vote && (req.method === 'PUT' || req.method === 'DELETE')) {
    if (!viewer) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    if (!sameOrigin(req)) return Response.json({ error: 'Cross-site request rejected' }, { status: 403 })
    const app = (await entries()).find(e => e.id === vote[1] && visibleTo(e, viewer.sub))
    if (!app) return Response.json({ error: 'No such app on the Hub' }, { status: 404 })
    if (req.method === 'PUT') addVote(app.id, viewer.sub); else removeVote(app.id, viewer.sub)
    return Response.json({ votes: voteCounts()[app.id] ?? 0, voted: req.method === 'PUT' })
  }
  return notFound()
}

/** A domain app shows to viewers who can sign in to Purgatorium itself; Hub-only viewers see public apps only. */
export function visibleTo(app: { access?: 'public' | 'domain' }, viewerSub: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return app.access !== 'domain' || subAllowed(viewerSub, viewerSub === 'admin' ? 'admin' : 'user', env)
}
