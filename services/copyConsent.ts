import fs from 'fs'
import path from 'path'
import { sandboxDir } from './sandboxPaths'
import { readSandboxFileIfAny, writeSandboxFile } from './sandboxFs'

/**
 * The owner's permission to copy a sandbox with scripts/clone-sandbox.mjs, and the record of the copies made. A rule and
 * a trace, not a lock: whoever runs the server's Docker can read a sandbox anyway (docs: copy-sandbox.md). In the
 * sandbox's directory on the host, which the sandbox itself cannot write.
 */
const CONSENT = 'copy-consent.json', LOG = 'copy-log.jsonl'
export const CONSENT_HOURS = 24

export interface CopyConsent { by: string; at: string; expires: string }
export interface CopyRecord { at: string; by: string; via: 'consent' | 'own' | 'no_consent'; reason?: string; what?: string }

function dirOf(name: string): string {
  const dir = sandboxDir(name)
  if (!dir) throw new Error(`Sandbox not found: ${name}`)
  return dir
}

export function grantCopyConsent(name: string, by: string, now = Date.now()): CopyConsent {
  const consent = { by, at: new Date(now).toISOString(), expires: new Date(now + CONSENT_HOURS * 3600_000).toISOString() }
  writeSandboxFile(dirOf(name), CONSENT, JSON.stringify(consent), 0o600)
  console.log(`[copy] ${name}: ${by} allowed a copy until ${consent.expires}`)
  return consent
}

export function withdrawCopyConsent(name: string): void {
  fs.rmSync(path.join(dirOf(name), CONSENT), { force: true })
}

/** The permission in force, null when there is none or it has run out. */
export function copyConsent(name: string, now = Date.now()): CopyConsent | null {
  const text = readSandboxFileIfAny(dirOf(name), CONSENT)
  if (!text) return null
  try {
    const c = JSON.parse(text) as CopyConsent
    return typeof c.by === 'string' && Date.parse(c.expires) > now ? c : null
  } catch { return null }
}

/** Uses the permission up: true when there was one. It holds for one copy. */
export function takeCopyConsent(name: string, now = Date.now()): boolean {
  const had = copyConsent(name, now) !== null
  withdrawCopyConsent(name)
  return had
}

export function recordCopy(name: string, record: CopyRecord): void {
  const dir = dirOf(name)
  const before = readSandboxFileIfAny(dir, LOG, 1024 * 1024) ?? ''
  writeSandboxFile(dir, LOG, `${before}${JSON.stringify(record)}\n`, 0o600)
  console.log(`[copy] ${name}: ${record.what ?? 'copied'} by ${record.by} (${record.via}${record.reason ? `: ${record.reason}` : ''})`)
}

/** The copies made, the newest first. */
export function copyHistory(name: string): CopyRecord[] {
  const text = readSandboxFileIfAny(dirOf(name), LOG, 1024 * 1024) ?? ''
  return text.split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line) as CopyRecord] } catch { return [] }
  }).reverse()
}
