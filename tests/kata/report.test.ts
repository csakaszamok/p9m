import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseKnown, classify, unseen } from './report.mjs'

// The Kata soak's known-issues list: a listed finding warns and the run goes on, anything else fails it
const URL8583 = 'https://github.com/kata-containers/kata-containers/issues/8583'

describe('parseKnown', () => {
  it('reads <id> <url> lines, skipping comments and blank lines', () => {
    const known = parseKnown(`# known findings\n\nsoak.stop-hang ${URL8583}\n`)
    expect([...known]).toEqual([['soak.stop-hang', URL8583]])
  })
  it('refuses an entry without an issue', () => {
    expect(() => parseKnown('soak.stop-hang\n')).toThrow(/issue/)
  })
  it('refuses an issue that is not https', () => {
    expect(() => parseKnown('soak.stop-hang http://example.com/1\n')).toThrow(/https/)
  })
  it('refuses an ID that is not soak.* or durability.*', () => {
    expect(() => parseKnown('Soak.X https://example.com/1\n')).toThrow(/ID/)
  })
  it('refuses the same ID twice', () => {
    expect(() => parseKnown(`soak.a ${URL8583}\nsoak.a ${URL8583}\n`)).toThrow(/twice/)
  })
})

describe('classify', () => {
  const known = parseKnown(`soak.stop-hang ${URL8583}\n`)
  it('a listed ID is not fatal and names its issue', () => {
    expect(classify('soak.stop-hang', known)).toEqual({ fatal: false, issue: URL8583 })
  })
  it('an unlisted ID is fatal', () => {
    expect(classify('soak.app-down', known)).toEqual({ fatal: true })
  })
})

describe('unseen', () => {
  const known = parseKnown(`soak.a ${URL8583}\ndurability.b ${URL8583}\n`)
  it("lists this test's entries that did not occur", () => {
    expect(unseen(known, new Set(), 'soak')).toEqual(['soak.a'])
  })
  it('leaves out the ones that occurred', () => {
    expect(unseen(known, new Set(['soak.a']), 'soak')).toEqual([])
  })
})

describe('report.mjs CLI', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kata-report-'))
  const env = {
    ...process.env,
    KATA_KNOWN: path.join(dir, 'known.txt'),
    KATA_SEEN: path.join(dir, 'seen.txt'),
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'),
  }
  fs.writeFileSync(env.KATA_KNOWN, `soak.stop-hang ${URL8583}\n`)
  const run = (...args: string[]) => spawnSync(process.execPath, ['tests/kata/report.mjs', ...args], { env, encoding: 'utf8' })

  it('a known finding warns, is recorded once, and exits 0', () => {
    const a = run('fail', 'soak.stop-hang', 'sandbox', 'x', 'hung')
    run('fail', 'soak.stop-hang', 'again')
    expect(a.status).toBe(0)
    expect(a.stdout).toMatch(/^::warning title=soak\.stop-hang::sandbox x hung \(known: https:/)
    expect(fs.readFileSync(env.KATA_SEEN, 'utf8')).toBe('soak.stop-hang\n')
    expect(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8').trim().split('\n')).toHaveLength(1)
  })
  it('an unknown finding is an error and exits 1', () => {
    const r = run('fail', 'soak.app-down', 'no hello')
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/^::error title=soak\.app-down::no hello/)
  })
  it('unseen warns about listed entries that did not occur', () => {
    fs.writeFileSync(env.KATA_KNOWN, `soak.stop-hang ${URL8583}\nsoak.mem-decline ${URL8583}\n`)
    const r = run('unseen', 'soak')
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/::warning::soak\.mem-decline did not occur/)
    expect(r.stdout).not.toMatch(/soak\.stop-hang did not occur/)
  })
  it('validate exits 2 on a bad list', () => {
    fs.writeFileSync(env.KATA_KNOWN, 'soak.stop-hang\n')
    const r = run('validate')
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/issue/)
  })
})
