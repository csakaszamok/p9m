import { readSession, getCookie, SESSION_COOKIE, type Session } from '../session'
import { subAllowed, sessionRole } from '../allowlist'
import { sandboxPrefix } from '../naming'
import { repoInfo, type RepoInfo } from '../repoInfo'
import { viewOf, canSwitchView, themeOf } from '../userPrefs'
import { recordSeen } from '../userStats'
import { brandTitle, faviconTag, githubLinkEnabled, logoImg, titleSuffix } from './brand'

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

export function pageSession(req: Request): Session | null {
  const session = readSession(getCookie(req, SESSION_COOKIE))
  if (!session) return null
  // Taken off OIDC_ADMIN_EMAILS: a user again at once; off OIDC_ALLOWED_DOMAINS / OIDC_ALLOWED_EMAILS: signed out
  const role = sessionRole(session.sub, session.role)
  return subAllowed(session.sub, role) ? { ...session, role } : null
}

export function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } })
}

export function html(body: string, status = 200): Response {
  // No framing: a page on another *.<domain> (a sandbox's app) must not wrap ours and steer its clicks or keystrokes
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" } })
}

const STAR_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/></svg>'
const FORK_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z"/></svg>'
const GITHUB_ICON = '<svg class="gh" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>'

const SUN_ICON = '<svg class="sun" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.2"/><path d="M8 .8v2M8 13.2v2M.8 8h2M13.2 8h2M2.9 2.9l1.4 1.4M11.7 11.7l1.4 1.4M2.9 13.1l1.4-1.4M11.7 4.3l1.4-1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
const MOON_ICON = '<svg class="moon" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7Z"/></svg>'

/** `<html>` with the theme the account chose; without one the stylesheet follows the device (prefers-color-scheme). */
export function htmlTag(sub: string | null): string {
  const theme = sub ? themeOf(sub) : null
  return `<html lang="en"${theme ? ` data-theme="${theme}"` : ''}>`
}

/** 1234 → 1.2k, 12345 → 12k */
export function shortCount(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`
}

/** The GitHub repo card at the right of the topbar: repo name, stars, forks (once fetched) and the version. */
export function repoBadge(info: RepoInfo): string {
  const stats = [
    info.stars !== null ? `<span title="${info.stars} stars">${STAR_ICON}${shortCount(info.stars)}</span>` : '',
    info.forks !== null ? `<span title="${info.forks} forks">${FORK_ICON}${shortCount(info.forks)}</span>` : '',
    info.version ? `<span>v${escapeHtml(info.version)}</span>` : '',
  ].join('')
  return `<a class="repo-badge" href="${info.url}" target="_blank" rel="noopener" title="Purgatorium on GitHub">${GITHUB_ICON}<span class="meta"><span class="name">${info.repo}</span>${stats ? `<span class="stats">${stats}</span>` : ''}</span></a>`
}

/** Next to the repo card, for the admin: a newer release of the running series, else of a later series (quieter:
 *  its upgrade notes may ask for more than a pull). Links to the release notes. */
export function updateNotice(info: RepoInfo): string {
  const v = info.updates.patch ?? info.updates.next
  if (!v) return ''
  const later = !info.updates.patch
  const title = later ? `Purgatorium ${v} is out: read its upgrade notes first` : `Purgatorium ${v} is out: see the release notes for the upgrade`
  return `<a class="update-notice${later ? ' later' : ''}" href="${info.url}/releases/tag/v${escapeHtml(v)}" target="_blank" rel="noopener" title="${title}">v${escapeHtml(v)} ${later ? 'out' : 'available'}</a>`
}

export function renderPage(opts: { title: string; view: 'overview' | 'mine' | 'all' | 'tokens' | 'ssh-keys'; session: Session; body: string }): string {
  const { title, view, session, body } = opts
  recordSeen(session.sub)
  // Simple only hides (class adv), it does not restrict: the API and MCP stay the same
  const mode = viewOf(session.sub, session.role)
  const link = (href: string, label: string, v: string | string[], adv = false) => {
    const cls = [adv ? 'adv' : '', [v].flat().includes(view) ? 'active' : ''].filter(Boolean).join(' ')
    return `<a${cls ? ` class="${cls}"` : ''} href="${href}">${label}</a>`
  }
  // My area: one link in the nav; on its pages, its tabs in a row below (Simple hides the row: only Sandboxes would be left)
  const MY_AREA = ['mine', 'tokens', 'ssh-keys']
  const name = brandTitle()
  const brand = name || logoImg(20) ? `<span class="brand">${logoImg(20)}${name ? escapeHtml(name) : ''}</span>` : ''
  const modeButton = (m: 'simple' | 'advanced', label: string) =>
    `<button type="button" data-mode-set="${m}" aria-pressed="${m === mode}">${label}</button>`
  return `<!DOCTYPE html>
${htmlTag(session.sub)}
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}${titleSuffix()}</title>
<link rel="stylesheet" href="/assets/style.css">
${faviconTag()}
</head>
<body data-view="${view}" data-mode="${mode}" data-role="${session.role}" data-sub="${escapeHtml(session.sub)}" data-prefix="${escapeHtml(sandboxPrefix())}">
<header class="topbar">
  ${brand}
  <nav>
    ${link('/overview', 'Overview', 'overview', true)}
    ${link('/', 'My area', MY_AREA)}
    ${session.role === 'admin' ? link('/admin', 'All sandboxes', 'all') : ''}
  </nav>
  <span class="places" data-places hidden></span>
  ${githubLinkEnabled() ? repoBadge(repoInfo()) : ''}
  ${session.role === 'admin' ? updateNotice(repoInfo()) : ''}
  <button type="button" class="theme-switch" data-theme-toggle title="Light or dark" aria-label="Switch between light and dark">${SUN_ICON}${MOON_ICON}</button>
  ${canSwitchView(session.role) ? `<span class="mode-switch" role="group" aria-label="View">${modeButton('simple', 'Simple')}${modeButton('advanced', 'Advanced')}</span>` : ''}
  <form method="post" action="/logout" class="who"><span>${escapeHtml(session.sub)}</span><span class="idle-left" data-idle-left hidden title="Signed out after this long without doing anything"></span><button class="link">Sign out</button></form>
  <a class="about-link" href="/about" title="License and source code">About</a>
</header>
${MY_AREA.includes(view) ? `<nav class="subnav adv">
  ${link('/', 'Sandboxes', 'mine')}
  ${link('/settings/tokens', 'Access tokens', 'tokens', true)}
  ${link('/settings/ssh-keys', 'SSH keys', 'ssh-keys', true)}
</nav>
` : ''}<main>${body}</main>
<script src="/assets/panel.js" defer></script>
<script src="/assets/app.js" defer></script>
<script src="/assets/idle.js" defer></script>
</body>
</html>`
}

const TOKEN_DIALOG = `
<dialog data-token-dialog>
  <form method="dialog" data-token-form>
    <h2>New access token</h2>
    <label>Name<input name="name" required maxlength="80" placeholder="laptop agent"></label>
    <label>Access<select name="sandbox" data-token-sandbox><option value="">All my sandboxes</option></select></label>
    <small class="muted">A token for one sandbox can use and change only that sandbox; it cannot create or delete sandboxes or manage tokens.</small>
    <label>Expires<select name="expires_in"><option value="30d">in 30 days</option><option value="90d" selected>in 90 days</option><option value="never">never</option></select></label>
    <p class="error" data-token-error hidden></p>
    <div class="actions"><button value="cancel" formnovalidate>Cancel</button><button class="primary" value="create">Create</button></div>
  </form>
</dialog>
<dialog data-token-created>
  <h2>Copy this token now</h2>
  <p class="muted">It will not be shown again.<span data-created-scope></span></p>
  <div class="copy"><code data-created-token></code><button data-copy>Copy</button><button data-download-env>Download p9m.env</button></div>
  <p class="muted">For a coding agent: save p9m.env in your project folder (keep it out of git) and tell the agent: <em>Deploy this app to my Purgatorium sandbox — settings in p9m.env.</em></p>
  <form method="dialog"><div class="actions"><button class="primary">Done</button></div></form>
</dialog>`

// Let your agent deploy, the same in both views: the Claude Code plugin (installed once, then /p9m:init approved in the browser),
// or a zip for other agents (a new token for the sandbox, its Docker client keys and a README); Advanced adds Options
const EXPORT_DIALOG = `
<dialog data-export-dialog>
  <form method="dialog" data-export-form>
    <h2>Let your agent deploy</h2>
    <section class="agent-way" data-way="claude">
      <h3>Claude Code <small class="muted">recommended</small></h3>
      <ol>
        <li>Once on this computer, in a terminal (in VS Code: Terminal → New Terminal):
          <div class="copy-line"><code>claude plugin marketplace add p9m-team/p9m</code><button type="button" class="link" data-copy-from="code">Copy</button></div>
          <div class="copy-line"><code>claude plugin install p9m@p9m</code><button type="button" class="link" data-copy-from="code">Copy</button></div>
          <details class="plugin-other"><summary>In Claude Code instead:</summary>
            <div class="copy-line"><code>/plugin marketplace add p9m-team/p9m</code><button type="button" class="link" data-copy-from="code">Copy</button></div>
            <div class="copy-line"><code>/plugin install p9m@p9m</code><button type="button" class="link" data-copy-from="code">Copy</button></div>
          </details></li>
        <li>In Claude Code, in your project's folder, paste this, then approve in the browser page it opens:
          <div class="copy-line"><code data-init-cmd></code><button type="button" class="primary" data-copy-from="[data-init-cmd]">Copy</button></div></li>
      </ol>
    </section>
    <section class="agent-way" data-way="other">
      <h3>Other agents <small class="muted">Codex, Cursor…</small></h3>
      <p class="muted">Download the zip below, then tell your agent: <em>set up the p9m zip from my Downloads in this project and deploy</em>. It holds a token and keys: the agent puts them in a <code>.p9m</code> folder that git leaves out.</p>
    </section>
    <details class="adv export-options"><summary>Options</summary>
      <p class="muted">For the zip and Copy as .env. The zip holds a <code>.p9m</code> folder for your project's folder: a new token for this sandbox, its Docker client keys and a README with the commands; its own .gitignore keeps it out of git.</p>
      <label>Token name<input name="name" maxlength="80" placeholder="laptop agent"></label>
      <label>Expires<select name="expires_in" data-export-expiry><option value="30d">in 30 days</option><option value="90d" selected>in 90 days</option><option value="never">never</option></select></label>
      <label class="check"><input type="checkbox" name="no_docker"> Without the Docker keys (the zip: p9m.env and the README only)</label>
      <div class="actions"><button type="button" data-copy-env>Copy as .env</button><small class="muted">p9m.env with a new token, to the clipboard</small></div>
    </details>
    <p class="muted" data-export-needs-certs hidden>This sandbox has no Docker access yet: enable it (the sandbox restarts, ~30 s) to include the Docker keys, or export without them.</p>
    <p class="muted" data-export-progress hidden></p>
    <p class="error" data-export-error hidden></p>
    <div class="actions">
      <button value="cancel" formnovalidate>Cancel</button>
      <button value="plain" data-export-plain hidden>Export without Docker access</button>
      <button class="primary" value="enable" data-export-enable hidden>Enable Docker access and export</button>
      <button class="primary" value="download" data-export-download>Download</button>
    </div>
  </form>
</dialog>
<dialog data-env-dialog>
  <h2>p9m.env</h2>
  <p class="muted">Copy this into a <code>p9m.env</code> file in your project (keep it out of git): it holds a new token for this sandbox.</p>
  <textarea data-env-text readonly rows="8" style="width:100%;font:12px ui-monospace,Consolas,monospace"></textarea>
  <form method="dialog"><div class="actions"><button class="primary">Done</button></div></form>
</dialog>`

// Asks before Archive / Revoke. Not the browser's confirm(): that can be switched off or missing
// (embedded browsers), and then answers Cancel at once without showing anything.
// Wake at the running limit: the owner picks which running sandbox sleeps instead
const SWAP_DIALOG = `
<dialog data-swap-dialog>
  <form method="dialog" data-swap-form>
    <h2>Running limit reached</h2>
    <p data-swap-text></p>
    <div data-swap-options></div>
    <p class="error" data-swap-error hidden></p>
    <div class="actions"><button value="cancel" formnovalidate>Cancel</button><button class="primary" value="swap" data-swap-ok>Sleep it and wake</button></div>
  </form>
</dialog>`

const CONFIRM_DIALOG = `
<dialog data-confirm-dialog>
  <form method="dialog">
    <p data-confirm-text></p>
    <div class="actions"><button value="cancel">Cancel</button><button class="danger" value="ok" data-confirm-ok>OK</button></div>
  </form>
</dialog>`

export const OVERVIEW_BODY = `
<div class="ov">
  <div class="ov-head"><h1>Overview</h1><span class="muted" data-ov-scope></span></div>
  <div data-overview><p class="muted">Loading…</p></div>
  <section id="hub-feed" hidden><h2>Hub feed</h2>
    <p class="muted">An RSS link for Slack, Teams, Linkwarden or an RSS reader. Creating a new one ends the old link.</p>
    <button id="hub-feed-new">Create feed link</button> <code id="hub-feed-url"></code></section>
</div>${CONFIRM_DIALOG}`

export const SANDBOX_VIEW_BODY = `
<section class="split">
  <div class="list">
    <div class="list-head">
      <h1 data-title></h1>
      <div class="filters" data-filters hidden>
        <input type="search" placeholder="Filter…" aria-label="Filter" data-filter-text>
        <select data-filter-status aria-label="Status"><option value="">All statuses</option><option value="running">running</option><option value="exited">asleep</option><option value="deep_sleep">deep sleep</option></select>
      </div>
      <span class="muted quota" data-quota></span>
      <button class="primary" data-new>+ New sandbox</button>
    </div>
    <table class="grid"><thead data-head></thead><tbody data-rows><tr><td class="muted">Loading…</td></tr></tbody></table>
  </div>
  <aside class="panel" data-panel><p class="muted">Select a sandbox to see its details.</p></aside>
</section>
<dialog data-new-dialog class="wide">
  <form method="dialog" data-new-form>
    <h2>New sandbox</h2>
    <label>Name <small class="muted">a generated one, or type your own</small><input name="name" required pattern="[a-z0-9][a-z0-9_-]{0,62}" placeholder="shop-demo" autocomplete="off"></label>
    <small class="muted"><span data-name-hint>lowercase letters, digits, - and _</span> · <button type="button" class="link" data-new-name>another name</button></small>
    <label class="adv">Runtime<select name="runtime" data-runtimes></select></label>
    <label>Template<select name="template" data-templates></select></label>
    <details class="adv" data-compose-section><summary>Starter stack <small class="muted">what the template starts inside the sandbox, as it is; add your own apps afterwards</small></summary>
      <pre class="code" data-compose-view aria-label="Starter stack"></pre>
    </details>
    <details class="adv"><summary>Advanced</summary>
      <label>Sleep after no traffic for<input name="idle_timeout" value="30m" pattern="([1-9][0-9]*(s|m|h|d)|0|off)"></label>
      <label>Deep sleep after asleep for<input name="deep_sleep_after" value="7d" pattern="([1-9][0-9]*(m|h|d)|0|off)"></label>
      <label>CPUs<input name="cpus" inputmode="decimal" placeholder="2"></label>
      <label>Memory<input name="memory" placeholder="4g"></label>
      <small class="muted" data-resource-hint></small>
      <label>Extra SSH public keys <small class="muted">this sandbox only, one per line; your <a href="/settings/ssh-keys">SSH keys</a> always get in</small>
        <textarea name="ssh_keys" rows="3" spellcheck="false" autocomplete="off" placeholder="ssh-ed25519 AAAA… agent@ci"></textarea></label>
      <label class="check"><input type="checkbox" name="create_inner_stack" checked> Deploy the template's stack</label>
    </details>
    <p class="error" data-new-error hidden></p>
    <div class="actions"><button value="cancel" formnovalidate>Cancel</button><button class="primary" value="create">Create</button></div>
  </form>
</dialog>
<dialog data-sleep-dialog>
  <form method="dialog" data-sleep-form>
    <h2>Sleep settings</h2>
    <label>Sleep after no traffic for<input name="idle_timeout" required pattern="([1-9][0-9]*(s|m|h|d)|0|off)"></label>
    <small class="muted">e.g. 30m, 2h or 1d; 0 or off = never. A running sandbox's apps are unreachable for a few seconds while this is applied.</small>
    <label>Deep sleep after asleep for<input name="deep_sleep_after" required pattern="([1-9][0-9]*(m|h|d)|0|off)"></label>
    <small class="muted">e.g. 7d or 12h; 0 or off = never</small>
    <p class="error" data-sleep-error hidden></p>
    <div class="actions"><button value="cancel" formnovalidate>Cancel</button><button class="primary" value="save">Save</button></div>
  </form>
</dialog>
<dialog data-resource-dialog>
  <form method="dialog" data-resource-form>
    <h2>Resources</h2>
    <label>CPUs<input name="cpus" required inputmode="decimal"></label>
    <label>Memory<input name="memory" required placeholder="4g"></label>
    <small class="muted" data-resource-ceiling></small>
    <div data-disk-field hidden><label>Warn above disk use of<input name="disk" placeholder="20g"></label>
    <small class="muted">a warning only: nothing is stopped or refused</small></div>
    <p class="error" data-resource-error hidden></p>
    <div class="actions"><button value="cancel" formnovalidate>Cancel</button><button class="primary" value="save">Save</button></div>
  </form>
</dialog>
<dialog data-connect-dialog class="wide">
  <h2>Connect to <code data-connect-host></code></h2>
  <p class="muted small">TLS only, on port 443. The service's own login protects it (a Postgres password, Redis AUTH…). A sandbox without web traffic still falls asleep after its idle timeout, which drops open connections; the next connection wakes it.</p>
  <p class="small" data-connect-login hidden></p>
  <div data-connect-kind="postgres" hidden><h3>Postgres</h3><pre class="code" data-connect-psql></pre></div>
  <div data-connect-kind="redis" hidden><h3>Redis</h3><pre class="code" data-connect-redis></pre>
    <p class="muted small">Add <code>--insecure</code> if the server uses a self-signed certificate.</p></div>
  <div data-connect-kind="ssh" hidden><h3>SSH</h3><pre class="code" data-connect-ssh-cmd></pre>
    <h3>SSH (~/.ssh/config)</h3><pre class="code" data-connect-ssh></pre>
    <p class="muted small">Needs <code>openssl</code> next to <code>ssh</code> (on Windows: Git Bash).</p></div>
  <h3>Any TLS client</h3><pre class="code" data-connect-openssl></pre>
  <div class="actions"><form method="dialog"><button class="primary">Close</button></form></div>
</dialog>
<dialog data-compose-dialog class="wide">
  <h2>Starter stack of <span data-compose-name></span></h2>
  <p class="muted small">What Purgatorium deployed into the sandbox when it was created. Stacks you deployed yourself are in Portainer.</p>
  <pre class="code" data-compose-text>Loading…</pre>
  <p class="muted small">Secrets are masked (•••).</p>
  <div class="actions"><button data-compose-copy>Copy</button><form method="dialog"><button class="primary">Close</button></form></div>
</dialog>${TOKEN_DIALOG}${EXPORT_DIALOG}${CONFIRM_DIALOG}${SWAP_DIALOG}`

export const SSH_KEYS_VIEW_BODY = `
<section class="tokens">
  <div class="list-head"><h1>SSH keys</h1></div>
  <p class="muted">Your public keys let you into your sandboxes as root: <code>ssh root@&lt;sandbox&gt;-shell-tcp.&lt;domain&gt;</code> through port 443 (Connect… in a sandbox's panel). Adding or deleting a key takes effect at once.</p>
  <table class="grid"><thead><tr><th>Name</th><th>Type</th><th>Fingerprint</th><th>Added</th><th></th></tr></thead><tbody data-ssh-key-rows><tr><td class="muted" colspan="5">Loading…</td></tr></tbody></table>
  <form data-ssh-key-form>
    <h2>Add a key</h2>
    <label>Name <small class="muted">optional; defaults to the key's comment</small><input name="name" maxlength="80" placeholder="laptop"></label>
    <label>Public key <small class="muted">the contents of e.g. ~/.ssh/id_ed25519.pub</small><textarea name="key" rows="3" required spellcheck="false" placeholder="ssh-ed25519 AAAA… me@laptop"></textarea></label>
    <p class="error" data-ssh-key-error hidden></p>
    <div class="actions"><button class="primary">Add key</button></div>
  </form>
</section>${CONFIRM_DIALOG}`

export const TOKENS_VIEW_BODY = `
<section class="tokens">
  <div class="list-head"><h1>Access tokens</h1><button class="primary" data-new-token>+ New token</button></div>
  <p class="muted">Give a token to your own agents: they act on the API as you (<code>Authorization: Bearer p9m_…</code>). A token can be limited to one sandbox.</p>
  <table class="grid"><thead data-token-head></thead><tbody data-token-rows><tr><td class="muted">Loading…</td></tr></tbody></table>
</section>${TOKEN_DIALOG}${EXPORT_DIALOG}${CONFIRM_DIALOG}`
