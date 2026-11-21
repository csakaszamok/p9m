#!/usr/bin/env node
// The Kata soak's pass rules over its host samples (tests/kata-soak.sh writes them). Counts are judged sample by
// sample: a shim, hypervisor or virtiofsd left while the sandboxes are stopped, or a VM missing while they run. Slow
// leaks and slowdown are judged from medians of windows after the warm-up (never single samples), so the runner's
// noise does not fail a run. At most one failure per ID: its earliest cycle. Node 18+, no packages.
//
//   node tests/kata/soakRules.mjs <metrics.csv> <durations.csv>    prints "<id>\t<message>" per failure, exit 0
//
// metrics.csv: cycle,phase,sandboxes,shims,hypervisors,virtiofsd,mounts,links,netns,mem_avail_kb,disk_used_kb
//   (phase baseline | stopped | running | final); durations.csv: cycle,sandbox,op,ms (op stop | start)
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

export const DEFAULTS = {
  warmup: 10, window: 20, mountsTol: 10, linksTol: 4, netnsTol: 2,
  memDeclineShare: 0.10, diskGrowthKb: 512_000, slowdownFactor: 2, slowdownWindow: 50,
}

export function parseCsv(text) {
  const [head, ...lines] = text.split('\n').map(l => l.trim()).filter(Boolean)
  const cols = head.split(',')
  return lines.map(l => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v !== '' && !isNaN(Number(v)) ? Number(v) : v])))
}

const median = xs => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const p95 = xs => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(0.95 * xs.length) - 1)]

export function evaluate(metrics, durations, opts = {}) {
  const o = { ...DEFAULTS, ...opts }
  const failures = new Map()
  const fail = (id, cycle, message) => { if (!failures.has(id)) failures.set(id, { id, cycle, message }) }

  for (const r of metrics) {
    if (r.phase === 'stopped' || r.phase === 'final') {
      for (const [k, id] of [['shims', 'soak.orphan-shim'], ['hypervisors', 'soak.orphan-hypervisor'], ['virtiofsd', 'soak.orphan-virtiofsd']])
        if (r[k] > 0) fail(id, r.cycle, `${r[k]} ${k} left with every sandbox ${r.phase === 'final' ? 'deleted' : 'stopped'} (cycle ${r.cycle})`)
    }
    if (r.phase === 'running' && (r.shims !== r.sandboxes || r.hypervisors !== r.sandboxes || r.virtiofsd < r.sandboxes))
      fail('soak.missing-vm', r.cycle, `${r.sandboxes} sandboxes running but ${r.shims} shims, ${r.hypervisors} hypervisors, ${r.virtiofsd} virtiofsd (cycle ${r.cycle})`)
  }

  // Slow growth: the last window of stopped samples against the window right after the warm-up
  const stopped = metrics.filter(r => r.phase === 'stopped').sort((a, b) => a.cycle - b.cycle)
  if (stopped.length >= o.warmup + 2 * o.window) {
    const early = stopped.slice(o.warmup, o.warmup + o.window), late = stopped.slice(-o.window)
    const at = late[late.length - 1].cycle
    const delta = k => median(late.map(r => r[k])) - median(early.map(r => r[k]))
    for (const [k, tol, id] of [['mounts', o.mountsTol, 'soak.mount-growth'], ['links', o.linksTol, 'soak.link-growth'], ['netns', o.netnsTol, 'soak.netns-growth']])
      if (delta(k) > tol) fail(id, at, `${k} with the sandboxes stopped grew by ${delta(k)} (median of cycles ${late[0].cycle}-${at} against ${early[0].cycle}-${early[early.length - 1].cycle}; tolerance ${tol})`)
    const memEarly = median(early.map(r => r.mem_avail_kb))
    if (-delta('mem_avail_kb') > o.memDeclineShare * memEarly)
      fail('soak.mem-decline', at, `available memory with the sandboxes stopped fell by ${Math.round(-delta('mem_avail_kb') / 1024)} MiB (${Math.round(-100 * delta('mem_avail_kb') / memEarly)} %, tolerance ${o.memDeclineShare * 100} %)`)
    if (delta('disk_used_kb') > o.diskGrowthKb)
      fail('soak.disk-growth', at, `disk use grew by ${Math.round(delta('disk_used_kb') / 1024)} MiB (tolerance ${Math.round(o.diskGrowthKb / 1024)} MiB)`)
  }

  // Slowdown: p95 start time of the last window of cycles against the window right after the warm-up
  const startCycles = [...new Set(durations.filter(d => d.op === 'start').map(d => d.cycle))].sort((a, b) => a - b)
  if (startCycles.length >= o.warmup + 2 * o.slowdownWindow) {
    const ms = cs => { const set = new Set(cs); return durations.filter(d => d.op === 'start' && set.has(d.cycle)).map(d => d.ms) }
    const earlyC = startCycles.slice(o.warmup, o.warmup + o.slowdownWindow), lateC = startCycles.slice(-o.slowdownWindow)
    const before = p95(ms(earlyC)), after = p95(ms(lateC))
    if (after > o.slowdownFactor * before)
      fail('soak.start-slowdown', lateC[lateC.length - 1], `p95 start took ${after} ms in cycles ${lateC[0]}-${lateC[lateC.length - 1]}, ${before} ms in ${earlyC[0]}-${earlyC[earlyC.length - 1]} (tolerance ${o.slowdownFactor}x)`)
  }

  const base = metrics.find(r => r.phase === 'baseline'), fin = metrics.find(r => r.phase === 'final')
  if (base && fin) {
    const off = [['mounts', o.mountsTol], ['links', o.linksTol], ['netns', o.netnsTol]].filter(([k, tol]) => Math.abs(fin[k] - base[k]) > tol)
    if (off.length) fail('soak.final-not-baseline', fin.cycle, `after deleting the sandboxes: ${off.map(([k]) => `${k} ${base[k]} -> ${fin[k]}`).join(', ')}`)
  }
  return [...failures.values()]
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [m, d] = process.argv.slice(2)
  for (const f of evaluate(parseCsv(fs.readFileSync(m, 'utf8')), parseCsv(fs.readFileSync(d, 'utf8'))))
    console.log(`${f.id}\t${f.message}`)
}
