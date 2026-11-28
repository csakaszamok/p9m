import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import { repoInfo, statsEnabled, newerReleases, _settled, _resetRepoInfo } from '../../services/repoInfo'
import { repoBadge, shortCount, updateNotice, renderPage } from '../../services/ui/layout'

const github = (body: unknown, ok = true) => vi.fn(async () => ({ ok, status: ok ? 200 : 403, json: async () => body }) as Response)
/** GitHub answering the repo and its releases */
const githubRepo = (repo: unknown, releases: unknown) => vi.fn(async (url: string | URL) => {
  const body = String(url).includes('/releases') ? releases : repo
  return { ok: true, status: 200, json: async () => body } as Response
})
const release = (tag: string, extra: object = {}) => ({ tag_name: tag, draft: false, prerelease: false, ...extra })
const info = (updates = { patch: null as string | null, next: null as string | null }) =>
  ({ repo: 'csakaszamok/p9m', url: 'https://github.com/csakaszamok/p9m', version: '0.12.1', stars: null, forks: null, updates })

beforeEach(() => {
  _resetRepoInfo()
  vi.stubEnv('GITHUB_STATS', 'on')
  vi.stubEnv('P9M_PACKAGE_JSON', path.join(__dirname, '..', '..', 'package.json'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('repoInfo', () => {
  it('the version from package.json; the counts once GitHub answered, then cached for an hour', async () => {
    const f = githubRepo({ stargazers_count: 42, forks_count: 7 }, [release('v99.0.0')])
    vi.stubGlobal('fetch', f)
    const first = repoInfo()
    expect(first).toMatchObject({ repo: 'csakaszamok/p9m', url: 'https://github.com/csakaszamok/p9m', stars: null, forks: null, updates: { patch: null, next: null } })
    expect(first.version).toMatch(/^\d+\.\d+\.\d+/)
    await _settled()
    expect(repoInfo()).toMatchObject({ stars: 42, forks: 7, updates: { patch: null, next: '99.0.0' } })
    expect(f).toHaveBeenCalledTimes(2)
    expect(f.mock.calls.map(c => String((c as unknown[])[0])).sort()).toEqual([
      'https://api.github.com/repos/csakaszamok/p9m',
      'https://api.github.com/repos/csakaszamok/p9m/releases?per_page=100',
    ])
    repoInfo(Date.now() + 30 * 60_000)
    expect(f).toHaveBeenCalledTimes(2)
    repoInfo(Date.now() + 61 * 60_000)
    await _settled()
    expect(f).toHaveBeenCalledTimes(4)
  })

  it('GitHub failing: no counts, no error, asked again after 10 minutes', async () => {
    const f = github({ message: 'rate limited' }, false)
    vi.stubGlobal('fetch', f)
    repoInfo(); await _settled()
    expect(repoInfo()).toMatchObject({ stars: null, forks: null, updates: { patch: null, next: null } })
    expect(f).toHaveBeenCalledTimes(2)
    repoInfo(Date.now() + 11 * 60_000); await _settled()
    expect(f).toHaveBeenCalledTimes(4)
  })

  it('GITHUB_STATS=off: never asks GitHub, the link and version stay', async () => {
    vi.stubEnv('GITHUB_STATS', 'off')
    const f = github({ stargazers_count: 1, forks_count: 1 })
    vi.stubGlobal('fetch', f)
    const info = repoInfo(); await _settled()
    expect(f).not.toHaveBeenCalled()
    expect(info.version).not.toBeNull()
    expect(statsEnabled({ GITHUB_STATS: ' OFF ' })).toBe(false)
    expect(statsEnabled({})).toBe(true)
  })

  it('no package.json: no version', () => {
    vi.stubEnv('GITHUB_STATS', 'off')
    vi.stubEnv('P9M_PACKAGE_JSON', path.join(__dirname, 'missing.json'))
    expect(repoInfo().version).toBeNull()
  })
})

describe('newerReleases', () => {
  const tags = ['v0.11.12', 'v0.12.0', 'v0.12.1', 'v0.12.3', 'v0.12.2', 'v0.13.0', 'v0.13.1', 'v1.0.0']
  it('the newest release of the running series, and the newest of a later series', () => {
    expect(newerReleases('0.12.1', tags.map(t => release(t)))).toEqual({ patch: '0.12.3', next: '1.0.0' })
    expect(newerReleases('0.13.1', tags.map(t => release(t)))).toEqual({ patch: null, next: '1.0.0' })
    expect(newerReleases('1.0.0', tags.map(t => release(t)))).toEqual({ patch: null, next: null })
  })
  it('leaves out drafts, pre-releases and tags that are not a version', () => {
    const rs = [release('v0.12.5', { draft: true }), release('v0.13.0', { prerelease: true }), release('v0.12.4-rc.1'), release('nightly'), { name: 'x' }]
    expect(newerReleases('0.12.1', rs)).toEqual({ patch: null, next: null })
  })
  it('no version of its own, or not a list: nothing to offer', () => {
    expect(newerReleases(null, [release('v1.0.0')])).toEqual({ patch: null, next: null })
    expect(newerReleases('0.12.1', { message: 'Not Found' })).toEqual({ patch: null, next: null })
  })
})

describe('updateNotice', () => {
  it('a newer release of the series: its version, linking to its release notes', () => {
    const html = updateNotice(info({ patch: '0.12.3', next: '0.13.0' }))
    expect(html).toContain('href="https://github.com/csakaszamok/p9m/releases/tag/v0.12.3"')
    expect(html).toContain('v0.12.3 available')
    expect(html).not.toContain('0.13.0')
  })
  it('only a later series: says so, quieter (its upgrade may need more than a pull)', () => {
    const html = updateNotice(info({ patch: null, next: '0.13.0' }))
    expect(html).toContain('href="https://github.com/csakaszamok/p9m/releases/tag/v0.13.0"')
    expect(html).toContain('v0.13.0 out')
    expect(html).toContain('class="update-notice later"')
  })
  it('up to date: nothing', () => {
    expect(updateNotice(info())).toBe('')
  })
  it('in the app bar for the admin only', async () => {
    vi.stubGlobal('fetch', githubRepo({ stargazers_count: 1, forks_count: 1 }, [release('v99.0.0')]))
    repoInfo(); await _settled()
    const page = (role: 'admin' | 'user') => renderPage({ title: 'x', view: 'mine', session: { sub: 'root', role, exp: 0 }, body: '' })
    expect(page('admin')).toContain('v99.0.0 out')
    expect(page('user')).not.toContain('update-notice')
  })
})

describe('repoBadge', () => {
  it('links to the repo with stars, forks and version', () => {
    const html = repoBadge({ ...info(), version: '0.3.0', stars: 1234, forks: 5 })
    expect(html).toContain('href="https://github.com/csakaszamok/p9m"')
    expect(html).toContain('rel="noopener"')
    expect(html).toContain('title="1234 stars"')
    expect(html).toContain('1.2k')
    expect(html).toContain('title="5 forks"')
    expect(html).toContain('v0.3.0')
  })
  it('before the counts (or with GITHUB_STATS=off): only the name and the version', () => {
    const html = repoBadge({ ...info(), version: '0.3.0' })
    expect(html).not.toContain('stars')
    expect(html).toContain('v0.3.0')
  })
  it('shortCount', () => {
    expect([0, 999, 1000, 1234, 9999, 12345].map(shortCount)).toEqual(['0', '999', '1k', '1.2k', '10k', '12k'])
  })
})
