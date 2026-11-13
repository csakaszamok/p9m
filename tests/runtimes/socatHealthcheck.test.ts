import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import yaml from 'js-yaml'

// socat's health check, run as written in each runtime against a stand-in for the frps API
const RUNTIMES = ['dind', 'kata', 'sysbox']
const hasSh = spawnSync('sh', ['-c', 'true']).status === 0

function check(runtime: string): string {
  const doc = yaml.load(fs.readFileSync(path.join(__dirname, '..', '..', 'runtimes', `${runtime}.yaml`), 'utf8')) as Record<string, unknown>
  const found = JSON.stringify(doc).match(/"CMD-SHELL","((?:[^"\\]|\\.)*api\/proxy(?:[^"\\]|\\.)*)"/)
  if (!found) throw new Error(`${runtime}: no socat health check`)
  // $$ is docker compose's escape for $
  return (JSON.parse(`"${found[1]}"`) as string).replace(/\$\$/g, '$')
}

const online = (name: string) => JSON.stringify({ proxies: [{ name, status: 'online' }] })
const none = JSON.stringify({ proxies: [] })

/** Runs the check with frps answering `http` and `stcp`; the marker's first sighting is `since` seconds ago (none: not yet). */
function run(script: string, answers: { http: string; stcp: string }, since?: number): number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socat-check-'))
  fs.writeFileSync(path.join(dir, 'http'), answers.http)
  fs.writeFileSync(path.join(dir, 'stcp'), answers.stcp)
  if (since !== undefined) {
    const t = Date.now() / 1000 - since
    fs.writeFileSync(path.join(dir, 'ready'), '')
    fs.utimesSync(path.join(dir, 'ready'), t, t)
  }
  // Forward slashes: on Windows the shell would eat a path's backslashes
  const d = dir.replaceAll('\\', '/')
  const fake = `wget() { case "$2" in */http) cat "${d}/http" ;; */stcp) cat "${d}/stcp" ;; *) return 1 ;; esac; }\n`
  return spawnSync('sh', ['-c', fake + script.replaceAll('/dev/shm', d)], { env: { ...process.env, FRPS_API_AUTH: 'p9m:x' } }).status ?? -1
}

describe.skipIf(!hasSh)("socat's health check", () => {
  it('every runtime has the same check', () => {
    for (const runtime of RUNTIMES) expect(check(runtime), runtime).toBe(check('dind'))
  })

  for (const runtime of RUNTIMES) {
    describe(runtime, () => {
      const script = check(runtime)
      it('healthy once an HTTP proxy is online', () => {
        expect(run(script, { http: online('a-web'), stcp: none })).toBe(0)
      })
      it('no proxy at all: not healthy', () => {
        expect(run(script, { http: none, stcp: none })).not.toBe(0)
      })
      it('only the readiness marker (a stack without public ports): not yet at first, healthy after 15 s', () => {
        const stcp = online('a.ready')
        expect(run(script, { http: none, stcp })).not.toBe(0)
        expect(run(script, { http: none, stcp }, 5)).not.toBe(0)
        expect(run(script, { http: none, stcp }, 20)).toBe(0)
      })
    })
  }
})
