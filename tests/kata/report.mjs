#!/usr/bin/env node
// The Kata soak and durability tests report every failure through this, by a stable ID (soak.*, durability.*).
// A failure listed in tests/kata-known-issues.txt (each entry names the issue that tracks it) is a warning and the
// run goes on; any other fails it. A listed entry that did not occur in a run is reported too, so the list does not
// rot. Node 18+, no packages.
//
//   node tests/kata/report.mjs validate                 exit 2 if the list is malformed
//   node tests/kata/report.mjs fail <id> <message...>   known: ::warning, exit 0; unknown: ::error, exit 1
//   node tests/kata/report.mjs unseen <soak|durability> ::warning for each listed entry not seen in this run
//
// KATA_KNOWN: the list (tests/kata-known-issues.txt); KATA_SEEN: the IDs seen in this run, one per line;
// GITHUB_STEP_SUMMARY: the job summary, one line per known finding.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ID = /^(soak|durability)\.[a-z0-9-]+$/

/** The list's entries, ID → issue URL; throws on a malformed line */
export function parseKnown(text) {
  const known = new Map()
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const [id, url, ...rest] = line.split(/\s+/)
    const at = `line ${i + 1}`
    if (!ID.test(id)) throw new Error(`${at}: the ID ${id} is not soak.<name> or durability.<name>`)
    if (!url) throw new Error(`${at}: ${id} names no issue`)
    if (!url.startsWith('https://') || rest.length) throw new Error(`${at}: ${id}'s issue must be one https:// address`)
    if (known.has(id)) throw new Error(`${at}: ${id} is listed twice`)
    known.set(id, url)
  })
  return known
}

export function classify(id, known) {
  return known.has(id) ? { fatal: false, issue: known.get(id) } : { fatal: true }
}

/** This test's listed entries that did not occur */
export function unseen(known, seen, prefix) {
  return [...known.keys()].filter(id => id.startsWith(`${prefix}.`) && !seen.has(id))
}

function readSeen(file) {
  try { return new Set(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) } catch { return new Set() }
}

function main(argv) {
  const listFile = process.env.KATA_KNOWN || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kata-known-issues.txt')
  let known
  try { known = parseKnown(fs.readFileSync(listFile, 'utf8')) } catch (e) {
    console.error(`${listFile}: ${e.message}`)
    return 2
  }
  const [cmd, ...args] = argv
  if (cmd === 'validate') return 0
  if (cmd === 'fail') {
    const [id, ...words] = args
    const message = words.join(' ')
    const c = classify(id, known)
    if (c.fatal) { console.log(`::error title=${id}::${message}`); return 1 }
    console.log(`::warning title=${id}::${message} (known: ${c.issue})`)
    const seenFile = process.env.KATA_SEEN
    if (seenFile && !readSeen(seenFile).has(id)) {
      fs.appendFileSync(seenFile, `${id}\n`)
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- known finding \`${id}\`: ${message} ([issue](${c.issue}))\n`)
    }
    return 0
  }
  if (cmd === 'unseen') {
    for (const id of unseen(known, readSeen(process.env.KATA_SEEN || ''), args[0]))
      console.log(`::warning::${id} did not occur in this run: it may be fixed (${known.get(id)}); check and remove it from tests/kata-known-issues.txt`)
    return 0
  }
  console.error('usage: report.mjs validate | fail <id> <message...> | unseen <soak|durability>')
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)))
