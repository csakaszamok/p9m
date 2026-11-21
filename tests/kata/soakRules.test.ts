import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { evaluate, type Row, type Dur } from './soakRules.mjs'

// The Kata soak's rules over its host samples: orphans and missing VMs at once, slow growth and slowdown only from
// medians of windows after the warm-up, so cycle-to-cycle noise never fails a run
const N = 6
const steady = { mounts: 400, links: 30, netns: 0, mem_avail_kb: 12_000_000, disk_used_kb: 8_000_000 }

function rows(cycles: number, tweak: (r: Row) => void = () => {}): Row[] {
  const out: Row[] = [{ cycle: 0, phase: 'baseline', sandboxes: 0, shims: 0, hypervisors: 0, virtiofsd: 0, ...steady }]
  for (let c = 1; c <= cycles; c++) {
    out.push({ cycle: c, phase: 'stopped', sandboxes: N, shims: 0, hypervisors: 0, virtiofsd: 0, ...steady })
    out.push({ cycle: c, phase: 'running', sandboxes: N, shims: N, hypervisors: N, virtiofsd: 2 * N, ...steady, mounts: 500 })
  }
  out.forEach(tweak)
  return out
}

function starts(cycles: number, ms: (c: number) => number = () => 20_000): Dur[] {
  const out: Dur[] = []
  for (let c = 1; c <= cycles; c++) for (let s = 0; s < N; s++) out.push({ cycle: c, sandbox: `sb${s}`, op: 'start', ms: ms(c) })
  return out
}

const ids = (f: { id: string }[]) => f.map(x => x.id)

describe('evaluate', () => {
  it('steady data passes', () => {
    expect(evaluate(rows(60), starts(60))).toEqual([])
  })
  it('an orphan virtiofsd in a stopped sample fails, at its earliest cycle only', () => {
    const f = evaluate(rows(60, r => { if (r.phase === 'stopped' && r.cycle >= 17) r.virtiofsd = 1 }), starts(60))
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ id: 'soak.orphan-virtiofsd', cycle: 17 })
  })
  it('an orphan in the final sample fails', () => {
    const r = rows(30)
    r.push({ cycle: 31, phase: 'final', sandboxes: 0, shims: 1, hypervisors: 0, virtiofsd: 0, ...steady })
    expect(ids(evaluate(r, starts(30)))).toEqual(['soak.orphan-shim'])
  })
  it('a running sample with a VM missing fails', () => {
    const f = evaluate(rows(30, r => { if (r.phase === 'running' && r.cycle === 5) r.hypervisors = N - 1 }), starts(30))
    expect(f).toEqual([expect.objectContaining({ id: 'soak.missing-vm', cycle: 5 })])
  })
  it('mounts growing by one a cycle fail', () => {
    expect(ids(evaluate(rows(60, r => { r.mounts += r.cycle }), starts(60)))).toEqual(['soak.mount-growth'])
  })
  it('mounts jumping ±8 around a flat level do not', () => {
    expect(evaluate(rows(60, r => { r.mounts += r.cycle % 2 ? 8 : -8 }), starts(60))).toEqual([])
  })
  it('growth before a full second window exists is not judged yet', () => {
    expect(evaluate(rows(45, r => { r.mounts += 5 * r.cycle }), starts(45))).toEqual([])
  })
  it('interfaces and namespaces growing fail under their own IDs', () => {
    expect(ids(evaluate(rows(60, r => { r.links += r.cycle; r.netns += r.cycle }), starts(60))).sort())
      .toEqual(['soak.link-growth', 'soak.netns-growth'])
  })
  it('available memory falling 15 % fails, 5 % does not', () => {
    const fall = (share: number) => (r: Row) => { if (r.cycle > 40) r.mem_avail_kb = steady.mem_avail_kb * (1 - share) }
    expect(ids(evaluate(rows(60, fall(0.15)), starts(60)))).toEqual(['soak.mem-decline'])
    expect(evaluate(rows(60, fall(0.05)), starts(60))).toEqual([])
  })
  it('disk use growing steadily fails', () => {
    expect(ids(evaluate(rows(60, r => { r.disk_used_kb += r.cycle * 50_000 }), starts(60)))).toEqual(['soak.disk-growth'])
  })
  it('starts taking 2.5 times as long fail, 1.5 times does not', () => {
    expect(ids(evaluate(rows(110), starts(110, c => (c > 60 ? 50_000 : 20_000))))).toEqual(['soak.start-slowdown'])
    expect(evaluate(rows(110), starts(110, c => (c > 60 ? 30_000 : 20_000)))).toEqual([])
  })
  it('a final sample far from the baseline fails', () => {
    const r = rows(30)
    r.push({ cycle: 31, phase: 'final', sandboxes: 0, shims: 0, hypervisors: 0, virtiofsd: 0, ...steady, mounts: steady.mounts + 30 })
    expect(ids(evaluate(r, starts(30)))).toEqual(['soak.final-not-baseline'])
  })
})

describe('soakRules.mjs CLI', () => {
  it('prints one <id>\\t<message> line per failure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kata-rules-'))
    const cols = ['cycle', 'phase', 'sandboxes', 'shims', 'hypervisors', 'virtiofsd', 'mounts', 'links', 'netns', 'mem_avail_kb', 'disk_used_kb'] as const
    const r = rows(3, x => { if (x.phase === 'stopped' && x.cycle === 2) x.shims = 1 })
    fs.writeFileSync(path.join(dir, 'm.csv'), [cols.join(','), ...r.map(x => cols.map(c => x[c]).join(','))].join('\n') + '\n')
    fs.writeFileSync(path.join(dir, 'd.csv'), 'cycle,sandbox,op,ms\n' + starts(3).map(d => `${d.cycle},${d.sandbox},${d.op},${d.ms}`).join('\n') + '\n')
    const out = spawnSync(process.execPath, ['tests/kata/soakRules.mjs', path.join(dir, 'm.csv'), path.join(dir, 'd.csv')], { encoding: 'utf8' })
    expect(out.status).toBe(0)
    expect(out.stdout.trim().split('\n')).toEqual([expect.stringMatching(/^soak\.orphan-shim\t/)])
  })
})
