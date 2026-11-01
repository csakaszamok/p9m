#!/usr/bin/env node
// Claude Code scenarios: a headless Claude Code with the p9m plugin (plugins/p9m) does what a user asks it, in a new
// project folder, and the test checks the result itself. Each step is timed.
//
//   webapp     a web app from nothing, online
//   database   a web app with PostgreSQL; its data outlives sleep and wake
//   mcp        an MCP server online; the test speaks MCP to it
//   teleport   a skill written, then the project and the conversation moved into the sandbox (/p9m:teleport)
//
// Each starts with /p9m:init (the test approves the code in the browser's place, as a signed-in test user) and
// checks at the end that the sandbox's token is in nothing Claude Code printed or read. Then the admin archives the
// sandbox and the docker context is removed.
//
// Needs the server's SESSION_SECRET to sign the test user's and the admin's sessions: never put it in a file in the
// repository. Needs `claude` (signed in, or ANTHROPIC_API_KEY), `docker` with compose, `curl`, `tar` and `git`:
// what a user has. Each scenario costs some model calls (MAX_BUDGET caps each turn).
//
//   P9M_URL=https://p9m.demo.example.com SESSION_SECRET=… node tests/claude-code/run.mjs [scenario…]   (all of them)
//
// MODEL for Claude Code (its default), MAX_BUDGET in USD for each turn (3), TEMPLATE for the sandboxes (the server's
// default), USER_DOMAIN for the test users' e-mails (example.com: must pass OIDC_ALLOWED_DOMAINS / _EMAILS), KEEP=1
// keeps the sandboxes and folders, CA_FILE: the CA of the server's certificate for Claude Code's curl, INSECURE=1
// accepts any certificate (a local lvh.me stack with a mkcert certificate). RECORD=<folder>: each scenario's
// messages, tool calls, steps and screenshots, for video.mjs (screenshots need Docker: Playwright's image).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, runScenario } from './harness.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const all = fs.readdirSync(path.join(here, 'scenarios')).filter(f => f.endsWith('.mjs')).map(f => f.slice(0, -4))
const ORDER = ['webapp', 'database', 'mcp', 'teleport']
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : [...ORDER.filter(n => all.includes(n)), ...all.filter(n => !ORDER.includes(n))]
const unknown = wanted.filter(n => !all.includes(n))
if (unknown.length) { console.error(`unknown scenario(s): ${unknown.join(', ')}; there are: ${all.join(', ')}`); process.exit(2) }

let c
try { c = config() } catch (err) { console.error(err.message); process.exit(2) }
const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

const results = []
for (const name of wanted) {
  const scenario = (await import(path.join(here, 'scenarios', `${name}.mjs`))).default
  console.log(`\n▶ ${scenario.name}: ${scenario.title}`)
  const r = await runScenario(scenario, c)
  for (const s of r.steps) console.log(`  ${s.ok ? '✔' : '✘'} ${s.name.padEnd(56)} ${mmss(s.s).padStart(6)}${s.why ? `\n      ${s.why}` : ''}`)
  console.log(`  ${r.ok ? 'PASSED' : 'FAILED'} in ${mmss(r.seconds)}, Claude Code $${r.cost.toFixed(2)}`)
  results.push(r)
}

console.log(`\n${'scenario'.padEnd(12)}${'result'.padEnd(9)}${'time'.padStart(7)}${'cost'.padStart(8)}`)
for (const r of results) console.log(`${r.name.padEnd(12)}${(r.ok ? 'passed' : 'FAILED').padEnd(9)}${mmss(r.seconds).padStart(7)}${`$${r.cost.toFixed(2)}`.padStart(8)}`)

if (c.record) {
  const md = [`# Claude Code scenarios against ${c.p9mUrl}`, '', new Date().toISOString(), '']
  for (const r of results) {
    md.push(`## ${r.name}: ${r.title} (${r.ok ? 'passed' : 'FAILED'}, ${mmss(r.seconds)}, $${r.cost.toFixed(2)})`, '', '| step | | time |', '|---|---|---|')
    for (const s of r.steps) md.push(`| ${s.name} | ${s.ok ? '✔' : `✘ ${s.why?.replace(/\|/g, '\\|').slice(0, 120) ?? ''}`} | ${mmss(s.s)} |`)
    md.push('')
  }
  fs.writeFileSync(path.join(c.record, 'results.md'), md.join('\n'))
  fs.writeFileSync(path.join(c.record, 'results.json'), JSON.stringify(results, null, 2))
  console.log(`\nrecorded in ${c.record} (node tests/claude-code/video.mjs ${c.record} makes the videos)`)
}
process.exit(results.every(r => r.ok) ? 0 : 1)
