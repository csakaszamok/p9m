import fs from 'fs'
import path from 'path'

/**
 * Files in a sandbox's directory that the sandbox can write, or once could (its /inner and /certs were mounted read-write
 * before 0.12.22): root in the sandbox may have put a symlink there, and Purgatorium, which reads and writes them as
 * root in its own file system, would follow it (the Purgatorium container's environment, its data, the Traefik config
 * it writes). So no symlink anywhere below the sandbox's directory, only plain files, and a size limit.
 */

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0
// A FIFO opened for reading waits for a writer: without this, a planted one would hang Purgatorium
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0

/** Every folder from `base` down to the file must be a real folder (not a symlink); `create` makes missing ones. */
function checkedParent(base: string, rel: string, create: boolean): string {
  const parts = path.normalize(rel).split(/[\\/]+/).filter(Boolean)
  if (!parts.length || parts.includes('..')) throw new Error(`Not a path in the sandbox: ${rel}`)
  let at = base
  for (const part of parts.slice(0, -1)) {
    at = path.join(at, part)
    let st: fs.Stats | undefined
    try { st = fs.lstatSync(at) } catch { /* missing */ }
    if (!st && create) { fs.mkdirSync(at); continue }
    if (!st?.isDirectory() || st.isSymbolicLink()) throw new Error(`Not a folder: ${at}`)
  }
  return path.join(at, parts[parts.length - 1])
}

/** A plain file below `base` (no symlink on the way), at most `max` bytes; throws for anything else. */
export function readSandboxFile(base: string, rel: string, max = 1024 * 1024): string {
  const file = checkedParent(base, rel, false)
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK)
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile()) throw new Error(`Not a file: ${file}`)
    if (st.size > max) throw new Error(`Larger than ${max} bytes: ${file}`)
    return fs.readFileSync(fd, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/** The same, or null when it is not there (or not a plain file). */
export function readSandboxFileIfAny(base: string, rel: string, max?: number): string | null {
  try { return readSandboxFile(base, rel, max) } catch { return null }
}

/** Writes a new plain file below `base`: whatever was at its place (a symlink too) is removed first, never followed. */
export function writeSandboxFile(base: string, rel: string, data: string, mode = 0o644): void {
  const file = checkedParent(base, rel, true)
  try {
    const st = fs.lstatSync(file)
    if (st.isDirectory() && !st.isSymbolicLink()) fs.rmSync(file, { recursive: true, force: true })
    else fs.unlinkSync(file)
  } catch { /* not there */ }
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, mode)
  try {
    fs.writeFileSync(fd, data)
    fs.fchmodSync(fd, mode) // the umask may have taken bits off; on the open file, not its name
  } finally { fs.closeSync(fd) }
}

/**
 * Copies a sandbox's directory for Purgatorium's own keeping (the archive): real folders, made 0700, and regular files
 * only, made 0600 (0644 if the source was readable by others: nothing secret). Root in a sandbox (under Kata, host
 * root) may have planted setuid files, device nodes, FIFOs or symlinks there; none is copied or re-armed. `skip` names
 * top-level entries to leave out.
 */
export function copySandboxDir(src: string, dest: string, skip: string[]): void {
  fs.mkdirSync(dest, { mode: 0o700 })
  for (const name of fs.readdirSync(src)) {
    if (skip.includes(name)) continue
    const from = path.join(src, name), to = path.join(dest, name)
    const st = fs.lstatSync(from)
    if (st.isDirectory()) copySandboxDir(from, to, [])
    else if (st.isFile()) copyRegularFile(from, to)
  }
}

function copyRegularFile(from: string, to: string): void {
  let fd: number
  try {
    fd = fs.openSync(from, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ELOOP') return // became a symlink since the lstat
    throw e
  }
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile()) return
    const mode = st.mode & 0o004 ? 0o644 : 0o600
    const out = fs.openSync(to, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, mode)
    try {
      const buf = Buffer.alloc(64 * 1024)
      for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) fs.writeSync(out, buf, 0, n)
      fs.fchmodSync(out, mode) // the umask may have taken bits off
    } finally { fs.closeSync(out) }
  } finally { fs.closeSync(fd) }
}
