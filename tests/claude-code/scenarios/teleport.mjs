// A user has Claude Code write a small skill, then moves the project (and the conversation) into the sandbox with
// /p9m:teleport.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const SKILL = '.claude/skills/release-notes/SKILL.md'

export default {
  name: 'teleport',
  title: 'A skill, moved into the sandbox with /p9m:teleport',
  files: () => ({ 'README.md': '# Notes\n\nA small project that keeps its release notes tidy.\n', 'CHANGELOG.md': '# Changelog\n' }),
  async run(h) {
    // A project as users have one: a git repository with a commit
    const git = (...a) => execFileSync('git', a, { cwd: h.project, stdio: 'ignore' })
    git('init', '-q'); git('-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', 'commit', '-q', '--allow-empty', '-m', 'Start')
    git('add', '.'); git('-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', 'commit', '-q', '-m', 'README and changelog')

    await h.init()
    await h.step('/p9m:init again keeps the link', async () => {
      // A folder tied already: it checks the link and stops, with no new code, token, keys or docker context
      const file = path.join(h.project, '.p9m', 'p9m.env')
      const before = fs.readFileSync(file, 'utf8'), mtime = fs.statSync(file).mtimeMs
      const answer = await h.claude(`/p9m:init ${h.config.p9mUrl}`)
      if (/\/activate\?code=|[B-Z]{4}-[B-Z]{4}/.test(answer)) h.fail(`it asked for a new code: ${answer.slice(0, 300)}`)
      if (fs.readFileSync(file, 'utf8') !== before || fs.statSync(file).mtimeMs !== mtime) h.fail('.p9m/p9m.env was written again')
      h.note('no new code, .p9m untouched: it is tied already')
    })
    await h.step('"write a skill"', async () => {
      await h.claude(`Create a small Claude Code skill in this project, ${SKILL}: when I ask for release notes, it writes ` +
        'them from the git log since the last tag, grouped into Added, Changed and Fixed. Keep it short.')
      const file = path.join(h.project, SKILL)
      if (!fs.existsSync(file) || !/^---[\s\S]*?name:/m.test(fs.readFileSync(file, 'utf8'))) h.fail(`no skill with a name at ${SKILL}`)
      h.note(`${SKILL} written`)
    })
    const moved = await h.step('/p9m:teleport moves the project', async () => {
      let answer = await h.claude('/p9m:teleport')
      // It tells what would move and may ask; the user says yes (no secret files here)
      for (let i = 0; i < 2 && !/--resume\s+[0-9a-f-]{36}/.test(answer); i++) answer = await h.claude('Yes, go ahead.')
      const id = answer.match(/--resume\s+([0-9a-f-]{36})/)?.[1]
      const folder = answer.match(/\/home\/agent\/workspace\/[A-Za-z0-9._-]+/)?.[0]
      if (!id || !folder) h.fail(`no "claude --resume <id>" and folder in its answer: ${answer.slice(0, 300)}`)
      // The way on is one command on this machine, for every user (the web terminal of a container is the admins')
      const command = answer.match(/docker --context \S+ exec -it -w \S+ claude claude --resume [0-9a-f-]{36}/)?.[0]
      if (!command) h.fail(`no "docker --context … exec -it … claude --resume" command in its answer: ${answer.slice(0, 300)}`)
      return { id, folder, command }
    })
    await h.step('its command opens Claude Code there', async () => {
      // Run as the user would, in a terminal: Claude Code starts in the sandbox (the first time with its set-up: the theme,
      // then the sign-in). The cursor moves between words are left out with the escape codes: match without spaces too
      const out = h.terminal(moved.command, 40)
      if (!/Claude\s*Code|Syntax\s*theme|text\s*style|sign\s*in|log\s*in/i.test(out)) h.fail(`no Claude Code from "${moved.command}": ${out.slice(-400)}`)
      h.note(`${moved.command}: Claude Code answers in the sandbox`)
    })
    await h.step('in the sandbox: the skill and the conversation', async () => {
      const exec = cmd => h.docker('exec', 'claude', 'sh', '-c', cmd)
      try { exec(`test -f '${moved.folder}/${SKILL}'`) } catch { h.fail(`no ${SKILL} in the sandbox's claude container`) }
      h.note(`docker exec claude: ${moved.folder}/${SKILL} is there`)
      try { exec(`ls /home/agent/.claude/projects/*/${moved.id}.jsonl`) } catch { h.fail(`the conversation ${moved.id} is not in the sandbox`) }
      h.note(`the conversation ${moved.id} is there: claude --resume picks it up`)
    })
    await h.step("the claude image came from Purgatorium's ghcr.io cache", async () => {
      // teleport.sh pulls registry-cache:5001/<path> when the sandbox has it: then that name is in its dockerd
      const cached = 'registry-cache:5001/csakaszamok/p9m-claude-code-minimal:latest'
      try { h.docker('image', 'inspect', '--format', '{{.Id}}', cached) } catch { h.fail(`no ${cached} in the sandbox: pulled from ghcr.io directly`) }
      h.note(`${cached}: from the server, not from the internet`)
    })
  },
}
