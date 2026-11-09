// The page where a sandbox's owner allows the admin to copy it (GET and POST /sandboxes/:name/copy-consent)
import { escapeHtml } from './layout'
import { activatePage, messagePage } from './activatePage'
import { copyConsent, copyHistory, CONSENT_HOURS } from '../copyConsent'
import { sandboxService } from '../sandbox'
import { rawNameOf } from '../naming'

const HEADING = 'Copy this sandbox?'

/** The sandbox, when `sub` is its owner: not the admin, who is the one asking. */
export async function ownedBy(name: string, sub: string) {
  try {
    const sandbox = await sandboxService.getSandbox(name)
    return sandbox.owner === sub ? sandbox : null
  } catch { return null }
}

// Not 404: Traefik puts its own not-found page in place of every 404, and this text would be lost
export const notOwner = () => activatePage('<p class="error">Only the owner of this sandbox can decide this.</p>', 403, HEADING)

export function copyConsentPage(name: string, note = ''): Response {
  const short = escapeHtml(rawNameOf(name) ?? name)
  const consent = copyConsent(name)
  const last = copyHistory(name)[0]
  const button = (decision: string, label: string) => `<form method="post"><button name="decision" value="${decision}">${label}</button></form>`
  const decision = consent
    ? `<p>You have allowed one copy, until ${escapeHtml(consent.expires)}.</p>${button('withdraw', 'Withdraw permission')}`
    : `<p>The administrator wants to copy <code>${short}</code> to another sandbox, on this server or another one.</p>
  <p class="muted">A copy holds everything in the sandbox: its apps, their data and settings (passwords in them too), and its files. The sandbox stops for the time of the copy, then starts again. Allowing it holds for one copy, for ${CONSENT_HOURS} hours.</p>
  ${button('allow', 'Allow one copy')}`
  const history = last ? `<p class="muted">Last copied ${escapeHtml(last.at)} by ${escapeHtml(last.by)}${last.reason ? `: ${escapeHtml(last.reason)}` : ''}.</p>` : ''
  return activatePage(`${note ? `<p>${escapeHtml(note)}</p>` : ''}${decision}${history}`, 200, HEADING)
}

export const crossSite = () => messagePage('Cross-site request rejected.', 403, 'error')
