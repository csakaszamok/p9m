/**
 * A browser terminal that continues a teleported conversation: /sandboxes/:name/terminal?container=claude&resume=<id>
 * &dir=<folder> runs `claude --resume <id>` in that folder, then leaves a shell. The link /p9m:teleport gives every
 * user. Only these two, strictly checked: a link someone else sends can at most open a conversation in your own
 * container, never run a command.
 */
export interface TerminalResume { resume: string; dir: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// The folder /p9m:teleport puts a project in (teleport-lib.sh's tp_project_name: lower case, digits, . _ -)
const DIR = /^\/home\/agent\/workspace\/[a-z0-9_-][a-z0-9._-]{0,127}$/

/** The resume of these query parameters: null when there is none, 'bad' when one is given and not valid (or half). */
export function terminalResume(params: URLSearchParams): TerminalResume | null | 'bad' {
  const resume = params.get('resume'), dir = params.get('dir')
  if (resume === null && dir === null) return null
  if (!resume || !dir || !UUID.test(resume) || !DIR.test(dir) || params.get('container') === null) return 'bad'
  return { resume, dir }
}

/** The container shell's script, running Claude Code first (the values are checked: nothing to quote) */
export function resumeScript(r: TerminalResume): string {
  return `cd ${r.dir} 2>/dev/null || cd; "$s" -l -c 'claude --resume ${r.resume}'; exec "$s" -l`
}
