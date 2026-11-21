// Types of soakRules.mjs for its vitest test (the module itself is plain JavaScript, run by node in CI)
export interface Row {
  cycle: number
  phase: 'baseline' | 'stopped' | 'running' | 'final'
  sandboxes: number
  shims: number
  hypervisors: number
  virtiofsd: number
  mounts: number
  links: number
  netns: number
  mem_avail_kb: number
  disk_used_kb: number
}
export interface Dur { cycle: number; sandbox: string; op: 'stop' | 'start'; ms: number }
export interface Failure { id: string; cycle: number; message: string }
export interface Opts {
  warmup: number; window: number; mountsTol: number; linksTol: number; netnsTol: number
  memDeclineShare: number; diskGrowthKb: number; slowdownFactor: number; slowdownWindow: number
}
export const DEFAULTS: Opts
export function parseCsv(text: string): Record<string, string | number>[]
export function evaluate(metrics: Row[], durations: Dur[], opts?: Partial<Opts>): Failure[]
