import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = path.join(__dirname, '..')
const json = (p: string) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'))
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)])

/** The route file a `METHOD /path` names (`:name` → `[name]`), as the file router maps them */
const routeFile = (method: string, p: string) =>
  path.join(root, 'routes', ...p.split('/').filter(Boolean).map(s => s.startsWith(':') ? `[${s.slice(1)}]` : s), `${method}.ts`)

function frontmatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (!m) return {}
  return Object.fromEntries(m[1].split(/\r?\n/).map(l => /^([a-z-]+):\s*(.*)$/.exec(l)).filter(Boolean).map(x => [x![1], x![2]]))
}

describe('the Claude Code plugin', () => {
  const market = json('.claude-plugin/marketplace.json')
  const entry = market.plugins.find((p: { name: string }) => p.name === 'p9m')
  const pluginDir = path.join(root, entry?.source ?? '')
  const manifest = json(path.join(entry?.source ?? '', '.claude-plugin/plugin.json'))

  it('the marketplace lists the p9m plugin from this repository', () => {
    expect(market.name).toBe('p9m')
    expect(market.owner?.name).toBeTruthy()
    expect(entry?.source).toBe('./plugins/p9m')
    expect(manifest.name).toBe('p9m')
  })

  it('has the version of the release it comes with (an installed plugin updates when it changes)', () => {
    expect(manifest.version).toBe(json('package.json').version)
  })

  // Each project's .p9m/p9m.env says which Purgatorium, sandbox and token: the plugin keeps none
  it('has no MCP server and asks nothing', () => {
    expect(manifest.mcpServers).toBeUndefined()
    expect(manifest.userConfig).toBeUndefined()
    expect(fs.existsSync(path.join(pluginDir, 'mcp'))).toBe(false)
  })

  it('skills: init, deploy and teleport', () => {
    expect(fs.readdirSync(path.join(pluginDir, 'skills')).sort()).toEqual(['deploy', 'init', 'teleport'])
  })

  // The script does the copying: the secrets' contents never pass through the model, only their names
  it('teleport runs the plugin\'s script, asks about each secret by name, and resumes the conversation', () => {
    const md = fs.readFileSync(path.join(pluginDir, 'skills/teleport/SKILL.md'), 'utf8')
    const fm = frontmatter(md)
    expect(fm.description).toContain('/p9m:teleport')
    expect(fm['argument-hint']).toBe('[--ecc]')
    expect(md).toContain('"${CLAUDE_PLUGIN_ROOT}/scripts/teleport.sh" --plan')
    expect(md).toContain('"${CLAUDE_PLUGIN_ROOT}/scripts/teleport.sh" --run')
    expect(md).toContain('--secret')
    expect(md).toContain('claude --resume')
    // The first run pulls an image: the Bash tool's 2-minute default would kill it halfway
    expect(md).toContain('600000')
    // A secret that is a symlink is never taken: the skill says so instead of asking
    expect(md).toContain('secret-link')
    expect(fs.existsSync(path.join(pluginDir, 'scripts/teleport.sh'))).toBe(true)
  })

  it('every skill has a name matching its folder and a description within the limit', () => {
    const skills = fs.readdirSync(path.join(pluginDir, 'skills'))
    for (const s of skills) {
      const fm = frontmatter(fs.readFileSync(path.join(pluginDir, 'skills', s, 'SKILL.md'), 'utf8'))
      expect(fm.name).toBe(s)
      expect(fm.description?.length ?? 0).toBeGreaterThan(20)
      expect(fm.description.length).toBeLessThanOrEqual(1024)
    }
  })

  it('the skills call only routes the API has', () => {
    for (const f of files(path.join(pluginDir, 'skills')).filter(f => f.endsWith('.md'))) {
      const calls = [...fs.readFileSync(f, 'utf8').matchAll(/`(GET|POST|PATCH|DELETE) (\/[^`\s]+)`/g)]
      expect(calls.length, f).toBeGreaterThan(0)
      for (const [, method, p] of calls) expect(fs.existsSync(routeFile(method, p)), `${path.basename(path.dirname(f))}: ${method} ${p}`).toBe(true)
    }
  })

  // No polling: the token only comes with the code the approver's browser shows, pasted back by the user
  it('init starts a device approval and hands in the code the user pastes', () => {
    const md = fs.readFileSync(path.join(pluginDir, 'skills/init/SKILL.md'), 'utf8')
    expect(md).toContain('`POST /device/code`')
    expect(md).toContain('`POST /device/token`')
    expect(md).not.toContain('/device/poll')
    expect(md).toContain('^[A-Za-z]{4}[- ]?[A-Za-z]{4}$')
    expect(frontmatter(md)['argument-hint']).toBe('<purgatorium address> [sandbox | --template <name>]')
  })

  it('init checks the address before it goes into a command', () => {
    const md = fs.readFileSync(path.join(pluginDir, 'skills/init/SKILL.md'), 'utf8')
    expect(md).toContain('^https?://[A-Za-z0-9.:-]+$')
  })

  // A project folder with a space in it must not break the unpack after the single-use link is spent
  it('the skills quote the project folder', () => {
    for (const f of files(path.join(pluginDir, 'skills')).filter(f => f.endsWith('.md'))) {
      expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/-C <project folder>/)
    }
  })

  it('no skill uses the plugin\'s old settings or MCP tools', () => {
    for (const f of files(path.join(pluginDir, 'skills'))) {
      const text = fs.readFileSync(f, 'utf8')
      expect(text, f).not.toMatch(/userConfig|user_config|who_am_i/)
    }
  })

  it('no secrets or internal hosts in the plugin', () => {
    for (const f of files(pluginDir)) {
      const text = fs.readFileSync(f, 'utf8')
      expect(text, f).not.toMatch(/p9m_[A-Za-z0-9]{20,}/)
      // No address other than the two the deploy rules name
      const ips = [...text.matchAll(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g)].map(m => m[0])
      expect(ips.filter(ip => ip !== '127.0.0.1' && ip !== '0.0.0.0'), f).toEqual([])
    }
  })

  // Only in a git checkout (a release's source tarball has no index to ask)
  const inGit = (() => { try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === root } catch { return false } })()
  it.skipIf(!inGit)('a script a skill runs directly is executable in git (Linux and macOS installs keep the mode)', () => {
    const skills = files(path.join(pluginDir, 'skills')).filter(f => f.endsWith('SKILL.md')).map(f => fs.readFileSync(f, 'utf8')).join('\n')
    const direct = [...skills.matchAll(/^\s*"\$\{CLAUDE_PLUGIN_ROOT\}\/(scripts\/[^"]+)"/gm)].map(m => m[1])
    expect(direct.length).toBeGreaterThan(0)
    for (const script of new Set(direct)) {
      const staged = execFileSync('git', ['ls-files', '-s', path.join(entry?.source ?? '', script)], { cwd: root, encoding: 'utf8' })
      expect(staged.split(' ')[0], script).toBe('100755')
    }
  })
})
