import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let dir: string
const { sandboxDir } = vi.hoisted(() => ({ sandboxDir: vi.fn() }))
vi.mock('../../services/sandboxPaths', () => ({ sandboxDir }))
const { grantCopyConsent, copyConsent, takeCopyConsent, withdrawCopyConsent, recordCopy, copyHistory } = await import('../../services/copyConsent')

const HOUR = 3600_000

describe('the permission to copy a sandbox', () => {
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-')); sandboxDir.mockReturnValue(dir) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('there is none until the owner gives it', () => {
    expect(copyConsent('p9m-a')).toBeNull()
    expect(takeCopyConsent('p9m-a')).toBe(false)
  })
  it('holds for 24 hours', () => {
    grantCopyConsent('p9m-a', 'alice@x', 0)
    expect(copyConsent('p9m-a', 23 * HOUR)?.by).toBe('alice@x')
    expect(copyConsent('p9m-a', 24 * HOUR)).toBeNull()
    expect(takeCopyConsent('p9m-a', 25 * HOUR)).toBe(false)
  })
  it('holds for one copy', () => {
    grantCopyConsent('p9m-a', 'alice@x', 0)
    expect(takeCopyConsent('p9m-a', 1)).toBe(true)
    expect(takeCopyConsent('p9m-a', 2)).toBe(false)
  })
  it('can be withdrawn', () => {
    grantCopyConsent('p9m-a', 'alice@x', 0)
    withdrawCopyConsent('p9m-a')
    expect(copyConsent('p9m-a', 1)).toBeNull()
  })
  it('a file that is not a permission is none', () => {
    fs.writeFileSync(path.join(dir, 'copy-consent.json'), 'not json')
    expect(copyConsent('p9m-a')).toBeNull()
  })
  it('is not read through a symlink', () => {
    const other = path.join(dir, 'other.json')
    fs.writeFileSync(other, JSON.stringify({ by: 'x', at: '', expires: new Date(HOUR).toISOString() }))
    fs.symlinkSync(other, path.join(dir, 'copy-consent.json'))
    expect(copyConsent('p9m-a', 0)).toBeNull()
  })
  it('keeps a record of the copies, the newest first', () => {
    recordCopy('p9m-a', { at: '1', by: 'admin', via: 'consent' })
    recordCopy('p9m-a', { at: '2', by: 'admin', via: 'no_consent', reason: 'left the company' })
    expect(copyHistory('p9m-a').map(r => r.at)).toEqual(['2', '1'])
    expect(copyHistory('p9m-a')[0].reason).toBe('left the company')
  })
})
