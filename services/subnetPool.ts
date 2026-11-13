import yaml from 'js-yaml'

export interface SubnetBlock { subnet: string; ip_range: string; dns_ip: string }

export const DEFAULT_SUBNET_POOL = '10.213.0.0/16'

const BLOCK = 16

/** Parses an IPv4 CIDR into its network address and prefix length, or null when malformed. */
function parseCidr(cidr: string): { base: number; prefix: number } | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim())
  if (!m) return null
  const octets = m.slice(1, 5).map(Number)
  const prefix = Number(m[5])
  if (octets.some((o) => o > 255) || prefix > 32) return null
  const ip = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  return { base: (ip & mask) >>> 0, prefix }
}

function toIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}

/** Resolves the sandbox subnet pool from SANDBOX_SUBNET_POOL, falling back to the default with a warning. */
export function subnetPool(env: NodeJS.ProcessEnv = process.env): { pool: string; warnings: string[] } {
  const raw = env.SANDBOX_SUBNET_POOL
  if (raw === undefined || raw.trim() === '') return { pool: DEFAULT_SUBNET_POOL, warnings: [] }
  const p = parseCidr(raw)
  if (!p || p.prefix > 28) {
    return { pool: DEFAULT_SUBNET_POOL, warnings: [`SANDBOX_SUBNET_POOL "${raw}" is not an IPv4 CIDR of /28 or larger; using ${DEFAULT_SUBNET_POOL}`] }
  }
  return { pool: `${toIp(p.base)}/${p.prefix}`, warnings: [] }
}

/** True when the two IPv4 CIDRs share any address; malformed input counts as no overlap. */
export function cidrOverlaps(a: string, b: string): boolean {
  const x = parseCidr(a)
  const y = parseCidr(b)
  if (!x || !y) return false
  const prefix = Math.min(x.prefix, y.prefix)
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  return ((x.base ^ y.base) & mask) === 0
}

/** Picks the first /28 in the pool that overlaps nothing in used, or null when the pool is full. */
export function allocateSubnet(pool: string, used: string[]): SubnetBlock | null {
  const p = parseCidr(pool)
  if (!p || p.prefix > 28) return null
  const taken = used.map(parseCidr).filter((u): u is { base: number; prefix: number } => u !== null)
  const count = 2 ** (28 - p.prefix)
  for (let i = 0; i < count; i++) {
    const base = (p.base + i * BLOCK) >>> 0
    const overlaps = taken.some((u) => {
      const prefix = Math.min(u.prefix, 28)
      const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
      return ((u.base ^ base) & mask) === 0
    })
    if (!overlaps) return { subnet: `${toIp(base)}/28`, ip_range: `${toIp(base + 8)}/29`, dns_ip: toIp(base + 2) }
  }
  return null
}

/** Lists networks.*.ipam.config[].subnet from compose YAML, or [] when it does not parse. */
export function subnetsInCompose(text: string): string[] {
  try {
    const doc = yaml.load(text) as { networks?: Record<string, { ipam?: { config?: { subnet?: unknown }[] } } | null> } | null
    const out: string[] = []
    if (!doc || typeof doc !== 'object' || !doc.networks || typeof doc.networks !== 'object') return out
    for (const net of Object.values(doc.networks)) {
      const config = net?.ipam?.config
      if (!Array.isArray(config)) continue
      for (const c of config) if (c && typeof c.subnet === 'string') out.push(c.subnet)
    }
    return out
  } catch {
    return []
  }
}
