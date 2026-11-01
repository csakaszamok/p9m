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
      return { id, folder }
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
