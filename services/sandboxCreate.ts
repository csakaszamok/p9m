import { defaultRuntime, runtimeMissing, runtimeAllowed } from './defaultRuntime'
import { sandboxService } from './sandbox'
import { reserveSandboxSlot } from './quota'
import { normalizeIdleTimeout, normalizeDeepSleepAfter, sleepLimitError } from './sleepSettings'
import type { Principal } from './principal'
import { listTemplates, loadTemplate } from './templateLoader'
import { listRuntimes } from './runtimeLoader'
import { parsePublicKey } from './sshKeys'
import { checkLimits, resourceDefaults, clampToHost } from './resources'
import { hostResources } from './docker'
import { recordSandboxCreated } from './userStats'

/** POST /sandboxes for this principal and body; /activate creates a new sandbox for Claude Code through it too */
export async function createSandboxRequest(p: Principal, body: Record<string, unknown>): Promise<Response> {
  const { name, runtime, template, ssh_keys, cpus, memory, create_inner_stack, idle_timeout, deep_sleep_after } = body as { name?: string; runtime?: unknown; template?: unknown; ssh_keys?: unknown; cpus?: unknown; memory?: unknown; create_inner_stack?: boolean; idle_timeout?: unknown; deep_sleep_after?: unknown }

  // No name (omitted or null): one is generated right before the create
  const given = name === undefined || name === null ? undefined : name
  if (given !== undefined && (typeof given !== 'string' || !given.trim())) {
    return Response.json({ error: 'name must be a non-empty string, or omitted for a generated one' }, { status: 400 })
  }

  const trimmed = given?.trim()
  if (trimmed !== undefined && !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(trimmed)) {
    return Response.json({ error: 'name must be 1-63 lowercase alphanumeric/underscore/hyphen characters' }, { status: 400 })
  }

  // A sandbox starts from its template as it is: the starter stack cannot be replaced or edited, at the create or later.
  // Apps go in afterwards, through the sandbox's Docker (docker, SSH or an agent), like anything else
  if ('compose' in body) {
    return Response.json({ error: "compose was removed: a sandbox starts with its template's stack as it is; deploy your own apps afterwards with docker, SSH or an agent (docs: agent-guide.md)" }, { status: 400 })
  }

  if ('ttl' in body) {
    return Response.json({ error: 'ttl was removed: sandboxes only sleep when idle, use idle_timeout (e.g. "30m")' }, { status: 400 })
  }

  // Ends up verbatim in compose labels, so only allow a plain Go duration (or 0 / off = never).
  const idle = idle_timeout === undefined ? undefined : normalizeIdleTimeout(idle_timeout)
  if (idle === null) {
    return Response.json({ error: 'idle_timeout must look like 30s, 15m, 2h or 1d, or 0 / off for never' }, { status: 400 })
  }
  const deep = deep_sleep_after === undefined ? undefined : normalizeDeepSleepAfter(deep_sleep_after)
  if (deep === null) {
    return Response.json({ error: 'deep_sleep_after must look like 30m, 12h or 7d, or 0 / off for never' }, { status: 400 })
  }
  // The server's limits for users (SANDBOX_MAX_IDLE_TIMEOUT, SANDBOX_MAX_DEEP_SLEEP_AFTER); a template's default is cut to them
  const tooLong = sleepLimitError({ idle_timeout: idle, deep_sleep_after: deep }, p.role)
  if (tooLong) return Response.json({ error: tooLong }, { status: 400 })

  if (runtime !== undefined && typeof runtime !== 'string') {
    return Response.json({ error: 'runtime must be a string' }, { status: 400 })
  }
  if (template !== undefined && typeof template !== 'string') {
    return Response.json({ error: 'template must be a string' }, { status: 400 })
  }
  // The defaults are checked too: a stale DEFAULT_TEMPLATE (e.g. the removed dind-standard) is a 400, not a 500
  const runtimeName = runtime ?? await defaultRuntime()
  const templateName = template ?? (process.env.DEFAULT_TEMPLATE || 'starter')
  if (!listRuntimes().some(r => r.name === runtimeName)) {
    return Response.json({ error: 'Unknown runtime' }, { status: 400 })
  }
  if (!runtimeAllowed(runtimeName)) {
    const why = runtime === undefined ? `the default runtime (${runtimeName}) is not allowed on this server` : `${runtimeName} is not allowed on this server`
    return Response.json({ error: `${why} (ALLOWED_RUNTIMES): pick one of GET /runtimes` }, { status: 400 })
  }
  const missing = await runtimeMissing(runtimeName)
  if (missing) return Response.json({ error: missing }, { status: 400 })
  if (!listTemplates().some(t => t.name === templateName)) {
    return Response.json({ error: 'Unknown template' }, { status: 400 })
  }
  // e.g. the empty template: no services, so no starter stack
  const templateServices = (loadTemplate(templateName).compose as { services?: unknown }).services
  const hasServices = !!templateServices && typeof templateServices === 'object' && Object.keys(templateServices).length > 0
  const innerStack = hasServices && create_inner_stack !== false
  let sshKeys: string[] | undefined
  if (ssh_keys !== undefined) {
    if (!Array.isArray(ssh_keys) || ssh_keys.some(k => typeof k !== 'string')) return Response.json({ error: 'ssh_keys must be a list of public keys' }, { status: 400 })
    if (ssh_keys.length > 10) return Response.json({ error: 'at most 10 ssh_keys' }, { status: 400 })
    sshKeys = []
    for (const [i, k] of (ssh_keys as string[]).entries()) {
      const parsed = parsePublicKey(k)
      if ('error' in parsed) return Response.json({ error: `ssh_keys[${i}]: ${parsed.error}` }, { status: 400 })
      sshKeys.push(parsed.comment ? `${parsed.line} ${parsed.comment}` : parsed.line)
    }
  }

  // Users up to SANDBOX_MAX_*, the admin up to the host; what is not given gets the default
  const def = resourceDefaults()
  const host = await hostResources()
  const lim = checkLimits({ cpus, memory }, p.role, { ceiling: def.ceiling, host })
  if (!lim.ok) return Response.json({ error: lim.error }, { status: lim.status })
  const base = clampToHost(def.limits, host)
  const limits = { cpus: lim.cpus ?? base.cpus, memory: lim.memory ?? base.memory }

  const slot = await reserveSandboxSlot(p)
  if (!slot.ok) {
    return Response.json({ error: slot.scope === 'room' && slot.message ? slot.message
      : slot.scope === 'server'
      ? `The server is full (${slot.limit} sandboxes running): ask the administrator.`
      : `${slot.limit} running sandbox${slot.limit === 1 ? '' : 'es'} allowed: put one to sleep first (Sleep in its panel), then create a new one.` }, { status: 409 })
  }

  try {
    // A generated name another create took meanwhile: another one, up to three times
    for (let attempt = 1; ; attempt++) {
      const chosen = trimmed ?? await sandboxService.suggestName()
      if (!chosen) return Response.json({ error: 'No free sandbox name was found: give one' }, { status: 503 })
      try {
        const result = await sandboxService.createSandbox(chosen, innerStack, idle, deep, p.sub, templateName, runtimeName, sshKeys, limits)
        recordSandboxCreated(p.sub)
        return Response.json(result, { status: 201 })
      } catch (err) {
        const msg = err instanceof Error ? err.message : ''
        if (trimmed === undefined && attempt < 3 && (msg.includes('already exists') || msg.includes('conflicts with an existing sandbox'))) continue
        throw err
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('[POST /sandboxes] error:', err instanceof Error ? err.stack : err)
    if (msg.includes('already exists') || msg.includes('conflicts with an existing sandbox') || msg.includes("would take Purgatorium's own address")) return Response.json({ error: msg }, { status: 409 })
    if (msg.includes('No free ports')) return Response.json({ error: msg }, { status: 503 })
    if (msg.includes('fully subnetted')) return Response.json({ error: 'No free Docker networks available — run docker network prune' }, { status: 503 })
    return Response.json({ error: msg }, { status: 500 })
  } finally {
    slot.release()
  }
}
