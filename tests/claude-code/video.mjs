#!/usr/bin/env node
// Demo videos from recorded Claude Code scenarios (run.mjs with RECORD=<folder>): for each scenario an MP4 that
// replays the session as a terminal (the user's prompts, Claude Code's answers and tool calls, the browser's part, the
// test's checks), each line with the real time since the start, each step with how long it really took; long waits
// are shortened (the times shown stay the real ones). Then the screenshots of the apps, and a summary of the steps.
//
//   node tests/claude-code/video.mjs <record folder> [scenario…]      → <record folder>/<scenario>.mp4
//
// Needs agg (https://github.com/asciinema/agg: asciicast → GIF) and ffmpeg on the PATH, or AGG= / FFMPEG= their
// paths; FONT_DIR for agg's fonts (the system's otherwise). The captions are drawn by agg too (an ffmpeg without
// freetype will do).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const AGG = process.env.AGG ?? 'agg'
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg'
const W = 104, H = 32 // the terminal, in characters
const MAX_GAP = 2.2 // seconds: a longer wait is shown this long
const dir = process.argv[2]
if (!dir) { console.error('usage: node tests/claude-code/video.mjs <record folder> [scenario…]'); process.exit(2) }
const only = process.argv.slice(3)

const mmss = ms => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
const esc = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', magenta: '\x1b[35m', blue: '\x1b[34m', yellow: '\x1b[33m', grey: '\x1b[90m' }
// Long secret-looking strings (device codes, link tokens: upper and lower case and digits mixed) are not for a
// video; addresses (lower case) stay
const mask = s => String(s).replace(/(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{32,}/g, '••••••')
const md = s => s.replace(/\*\*([^*]+)\*\*/g, `${esc.bold}$1${esc.reset}`).replace(/`([^`]+)`/g, `${esc.yellow}$1${esc.reset}`)

/** Lines of at most width characters (ANSI codes not counted) */
function wrap(text, width) {
  const out = []
  for (const para of String(text).split('\n')) {
    let line = '', len = 0
    for (const word of para.split(/(\s+)/)) {
      const wlen = word.replace(/\x1b\[[0-9;]*m/g, '').length
      if (len + wlen > width && len > 0) { out.push(line.trimEnd()); line = ''; len = 0; if (!word.trim()) continue }
      if (wlen > width) { for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width)); continue }
      line += word; len += wlen
    }
    out.push(line.trimEnd())
  }
  return out
}

function toolLine(e) {
  const i = e.input ?? {}
  const arg = e.name === 'Bash' ? (i.description ? `${i.description}` : i.command)
    : e.name === 'Skill' ? i.skill
    : i.file_path ?? i.path ?? i.pattern ?? i.url ?? Object.values(i)[0] ?? ''
  const cmd = e.name === 'Bash' && i.command ? `\n${esc.grey}${mask(i.command).split('\n').slice(0, 2).map(l => `      $ ${l.slice(0, W - 12)}`).join('\n')}${esc.reset}` : ''
  return `${esc.green}●${esc.reset} ${esc.bold}${e.name}${esc.reset}(${mask(String(arg)).split('\n')[0].slice(0, W - 20)})${cmd}`
}

/** The session as an asciicast v2: [seconds, "o", text] after a header */
function cast(run) {
  const out = []
  let T = 0, last = 0
  const emit = (s, after = 0) => { T += after; out.push([+T.toFixed(3), 'o', s.replace(/\n/g, '\r\n')]) }
  const stamp = t => `${esc.grey}${mmss(t).padStart(5)}${esc.reset} `
  const steps = run.steps.filter(s => !s.name.startsWith('archive'))
  let n = 0

  emit(`\x1b[2J\x1b[H${esc.bold}${esc.cyan}Purgatorium × Claude Code${esc.reset}\n\n`)
  emit(`${esc.bold}${run.title}${esc.reset}\n`, 0.4)
  emit(`${esc.dim}A headless Claude Code with the p9m plugin, in a new project folder, against ${run.url}.\n${new Date(run.date).toUTCString()}${esc.reset}\n\n`, 0.4)
  T += 2.5

  for (const e of run.events) {
    T += Math.min(Math.max(0, (e.t - last) / 1000), MAX_GAP)
    last = e.t
    switch (e.kind) {
      case 'step':
        n++
        emit(`\n${esc.cyan}${esc.bold}━━ ${n}/${steps.length}  ${e.name} ${esc.reset}${esc.cyan}${'━'.repeat(Math.max(2, W - 10 - e.name.length))}${esc.reset}\n`)
        T += 0.6
        break
      case 'step-done':
        emit(`${stamp(e.t)}${e.ok ? `${esc.green}✔` : `${esc.red}✘`} ${e.name}: ${mmss(e.s * 1000)}${e.why ? `  ${mask(e.why).slice(0, 80)}` : ''}${esc.reset}\n`)
        T += 0.8
        break
      case 'prompt': {
        emit(`${stamp(e.t)}${esc.bold}> ${esc.reset}`)
        const lines = wrap(e.text, W - 10)
        for (const [k, l] of lines.entries()) {
          for (let i = 0; i < l.length; i += 3) emit(l.slice(i, i + 3), 0.025)
          if (k < lines.length - 1) emit(`\n        `)
        }
        emit('\n', 0.3)
        T += 0.4
        break
      }
      case 'text': {
        const lines = wrap(md(mask(e.text)), W - 10)
        const shown = lines.length > 9 ? [...lines.slice(0, 8), `${esc.dim}… ${lines.length - 8} more lines${esc.reset}`] : lines
        emit(`${stamp(e.t)}● ${shown.join('\n        ')}\n`)
        T += Math.min(3, 0.25 * shown.length)
        break
      }
      case 'tool':
        emit(`${stamp(e.t)}${toolLine(e)}\n`)
        break
      case 'tool-result': {
        const lines = mask(e.text).split('\n').filter(l => l.trim())
        const shown = lines.slice(0, 3).map(l => l.slice(0, W - 14))
        emit(`${esc.grey}        ⎿  ${shown.join('\n           ')}${lines.length > 3 ? `\n           … +${lines.length - 3} lines` : ''}${esc.reset}\n`)
        break
      }
      case 'browser':
        emit(`${stamp(e.t)}${esc.blue}◉ browser:${esc.reset} ${wrap(mask(e.text), W - 18).join('\n                ')}\n`)
        T += 1
        break
      case 'note':
        emit(`${stamp(e.t)}${esc.magenta}◆ test:${esc.reset} ${wrap(mask(e.text), W - 16).join('\n              ')}\n`)
        T += 1
        break
      case 'shot':
        emit(`${stamp(e.t)}${esc.magenta}◆ test:${esc.reset} screenshot of ${e.url} (after this)\n`)
        break
    }
  }

  // The summary
  emit(`\n${esc.bold}${run.ok ? `${esc.green}PASSED` : `${esc.red}FAILED`}${esc.reset}${esc.bold} in ${mmss(run.seconds * 1000)}${esc.reset}  ${esc.dim}(Claude Code: $${run.cost.toFixed(2)})${esc.reset}\n`, 1)
  for (const s of steps) emit(`  ${s.ok ? `${esc.green}✔` : `${esc.red}✘`}${esc.reset} ${s.name.padEnd(58)} ${mmss(s.s * 1000).padStart(6)}\n`, 0.12)
  emit('', 5)
  return [JSON.stringify({ version: 2, width: W, height: H, title: run.title }), ...out.map(e => JSON.stringify(e))].join('\n') + '\n'
}

const names = fs.readdirSync(dir).filter(n => fs.existsSync(path.join(dir, n, 'run.json')) && (!only.length || only.includes(n)))
if (!names.length) { console.error(`no recorded scenario in ${dir}`); process.exit(2) }
for (const name of names) {
  const rec = path.join(dir, name)
  const run = JSON.parse(fs.readFileSync(path.join(rec, 'run.json'), 'utf8'))
  fs.writeFileSync(path.join(rec, 'session.cast'), cast(run))
  const aggArgs = ['--theme', 'monokai', '--idle-time-limit', '6', '--last-frame-duration', '1']
  if (process.env.FONT_DIR) aggArgs.push('--font-dir', process.env.FONT_DIR, '--font-family', 'JetBrains Mono,DejaVu Sans Mono')
  execFileSync(AGG, [...aggArgs, '--font-size', '18', path.join(rec, 'session.cast'), path.join(rec, 'session.gif')], { stdio: 'ignore' })
  // A screenshot's caption: one line drawn by agg
  const caption = (text, file) => {
    const line = `  ${text}  `
    fs.writeFileSync(`${file}.cast`, `${JSON.stringify({ version: 2, width: line.length, height: 1 })}\n${JSON.stringify([0, 'o', `\x1b[1m${line}\x1b[0m`])}\n`)
    execFileSync(AGG, [...aggArgs, '--font-size', '26', `${file}.cast`, file], { stdio: 'ignore' })
    return file
  }

  // The terminal as video, then each screenshot for 5 s with its caption, all at the terminal's size
  // ffmpeg -i alone exits 1 and tells the size on stderr
  const size = (() => { try { execFileSync(FFMPEG, ['-hide_banner', '-i', path.join(rec, 'session.gif')], { stdio: 'pipe' }) } catch (err) { return /, (\d+)x(\d+)/.exec(String(err.stderr)) } return null })()
  const [vw, vh] = size ? [Number(size[1]) & ~1, Number(size[2]) & ~1] : [1280, 800]
  const inputs = ['-i', path.join(rec, 'session.gif')]
  const filters = [`[0:v]fps=25,scale=${vw}:${vh}:flags=lanczos,format=yuv420p,setsar=1[v0]`]
  run.shots.forEach((s, i) => {
    const k = inputs.filter(a => a === '-i').length
    inputs.push('-loop', '1', '-t', '5', '-i', path.join(rec, s.file), '-i', caption(s.label, path.join(rec, `caption-${i + 1}.gif`)))
    filters.push(`[${k}:v]fps=25,scale=${vw}:${vh - 60}:force_original_aspect_ratio=decrease,pad=${vw}:${vh}:(ow-iw)/2:0:color=0x272822[s${i}];` +
      `[s${i}][${k + 1}:v]overlay=(W-w)/2:H-h-8,format=yuv420p,setsar=1[v${i + 1}]`)
  })
  const parts = run.shots.length + 1
  filters.push(`${Array.from({ length: parts }, (_, i) => `[v${i}]`).join('')}concat=n=${parts}:v=1:a=0[out]`)
  const mp4 = path.join(dir, `${name}.mp4`)
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-c:v', 'libx264', '-crf', '23', '-preset', 'medium', '-movflags', '+faststart', mp4], { stdio: 'inherit' })
  console.log(`${mp4}  (${(fs.statSync(mp4).size / 1048576).toFixed(1)} MB)`)
}
