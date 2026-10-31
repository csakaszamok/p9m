import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { summaryFor, archivedOwners } from '../../services/summary'

const live = [
  { name: 'p9m-a', owner: 'alice@x', status: 'running' },
  { name: 'p9m-b', owner: 'alice@x', status: 'exited' },
  { name: 'p9m-c', owner: 'alice@x', status: 'deep_sleep' },
  { name: 'p9m-d', owner: 'bob@x', status: 'exited' },
  { name: 'p9m-e', owner: 'admin', status: 'running' },
]
const resources = { cpu: { used: 0.5, reserved: 4, host: 20 }, memory: { used: 2e9, reserved: 8e9, host: 16e9 }, disk: { used: 30e9, over: 1 } }
const deps = { list: async () => live, archived: async () => ['alice@x', 'alice@x', 'carol@x'], quota: () => 3 as number | null, server: () => null as number | null, running: () => 1 as number | null, resources: async () => resources }
const alice = { sub: 'alice@x', role: 'user' as const }
const admin = { sub: 'admin', role: 'admin' as const }

describe('summaryFor', () => {
  it("a user: their own sandboxes by state, against their quota", async () => {
    expect(await summaryFor(alice, deps)).toEqual({ quota: 3, total: 3, free: 2, running: 1, asleep: 1, deep_sleep: 1, archived: 2, max_running: 1, server_full: false })
  })
  it('unlimited quota: free is null', async () => {
    expect(await summaryFor({ sub: 'bob@x', role: 'user' }, { ...deps, quota: () => null })).toEqual({ quota: null, total: 1, free: null, running: 0, asleep: 1, deep_sleep: 0, archived: 0, max_running: 1, server_full: false })
  })
  it('the admin: the whole server, and per owner (also owners with only archived sandboxes)', async () => {
    const s = await summaryFor(admin, deps)
    expect(s).toMatchObject({ quota: null, free: null, total: 5, running: 2, asleep: 2, deep_sleep: 1, archived: 3, server_limit: null, server_used: 2, resources })
    expect(s.by_owner).toEqual([
      { owner: 'admin', quota: null, total: 1, free: null, running: 1, asleep: 0, deep_sleep: 0, archived: 0, max_running: null },
      { owner: 'alice@x', quota: 3, total: 3, free: 2, running: 1, asleep: 1, deep_sleep: 1, archived: 2, max_running: 1 },
      { owner: 'bob@x', quota: 3, total: 1, free: 3, running: 0, asleep: 1, deep_sleep: 0, archived: 0, max_running: 1 },
      { owner: 'carol@x', quota: 3, total: 0, free: 3, running: 0, asleep: 0, deep_sleep: 0, archived: 1, max_running: 1 },
    ])
  })
})

// Being created: it takes a place already; never "asleep · not counted" while it is made
describe('summaryFor, a sandbox being created', () => {
  it('counts as running, not asleep', async () => {
    const list = async () => [{ name: 'p9m-n', owner: 'alice@x', status: 'creating' }]
    expect(await summaryFor(alice, { ...deps, list })).toMatchObject({ total: 1, running: 1, asleep: 0, deep_sleep: 0, free: 2 })
  })
})

describe('summaryFor, server places', () => {
  it("the running sandboxes count, the admin's too; asleep and deep-sleeping ones do not", async () => {
    const d = { ...deps, server: () => 2, list: async () => [
      { name: 'p9m-x', owner: 'admin', status: 'running' }, { name: 'p9m-y', owner: 'admin', status: 'exited' }, { name: 'p9m-z', owner: 'alice@x', status: 'deep_sleep' },
    ] }
    expect(await summaryFor(admin, d)).toMatchObject({ server_limit: 2, server_used: 1 })
    expect((await summaryFor(alice, d)).server_full).toBe(false)
    const full = { ...d, list: async () => [...await d.list(), { name: 'p9m-w', owner: 'bob@x', status: 'running' }] }
    expect((await summaryFor(alice, full)).server_full).toBe(true)
  })
})

describe('summaryFor, server limit', () => {
  it("the admin sees the users' sandboxes against SANDBOX_MAX_TOTAL; a user only whether it is full", async () => {
    const d = { ...deps, server: () => 2 }
    expect(await summaryFor(admin, d)).toMatchObject({ server_limit: 2, server_used: 2 })
    const a = await summaryFor(alice, d)
    expect(a.server_full).toBe(true)
    expect(a).not.toHaveProperty('server_used')
    expect(a).not.toHaveProperty('resources')
  })
})

describe('archivedOwners', () => {
  it("reads each archive's owner from its compose file; bare labels too, admin without one; skips non-archives", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9m-arch-'))
    const arch = (n: string, compose: string | null) => {
      fs.mkdirSync(`${dir}/${n}/config`, { recursive: true })
      fs.writeFileSync(`${dir}/${n}/manifest.json`, JSON.stringify({ name: n }))
      if (compose !== null) fs.writeFileSync(`${dir}/${n}/config/docker-compose.yml`, compose)
    }
    arch('p9m-a-2026', 'services:\n  sandbox:\n    labels:\n      p9m.owner: "alice@x"\n')
    arch('p9m-b-2026', 'services:\n  sandbox:\n    labels:\n      p9m.owner: bob@x\n')
    arch('p9m-c-2026', null)
    // A bulk save of orphan volumes: a manifest, but no sandbox config
    fs.mkdirSync(`${dir}/_orphan-volumes-2026`)
    fs.writeFileSync(`${dir}/_orphan-volumes-2026/manifest.json`, '{}')
    expect((await archivedOwners(dir)).sort()).toEqual(['admin', 'alice@x', 'bob@x'])
    expect(await archivedOwners(`${dir}/missing`)).toEqual([])
  })
})

describe('archivedOwners in the per-owner layout', () => {
  it('reads archives under owner directories (manifest owner first), and flat ones not moved yet', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9m-arch2-'))
    fs.mkdirSync(`${dir}/carol@x/p9m-a-2026/config`, { recursive: true })
    fs.writeFileSync(`${dir}/carol@x/p9m-a-2026/manifest.json`, JSON.stringify({ name: 'p9m-a', owner: 'Carol@x' }))
    fs.mkdirSync(`${dir}/admin/p9m-b-2026/config`, { recursive: true })
    fs.writeFileSync(`${dir}/admin/p9m-b-2026/manifest.json`, JSON.stringify({ name: 'p9m-b' }))
    fs.mkdirSync(`${dir}/p9m-c-2026/config`, { recursive: true })
    fs.writeFileSync(`${dir}/p9m-c-2026/manifest.json`, JSON.stringify({ name: 'p9m-c' }))
    fs.writeFileSync(`${dir}/p9m-c-2026/config/docker-compose.yml`, '      p9m.owner: dave@x\n')
    expect((await archivedOwners(dir)).sort()).toEqual(['Carol@x', 'admin', 'dave@x'])
  })
})
