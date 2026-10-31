/**
 * Purgatorium's own container, to inspect (its mounts, networks, image). Its hostname is usually the start of its ID,
 * but not always: a container that compose recreated kept an older one on a server, and every self-inspect by hostname
 * failed ("no such container"), so new sandboxes got their bind mounts under a guessed path and never started. The
 * bind mounts of /etc/hostname, /etc/hosts and /etc/resolv.conf come from the container's own directory, named by its
 * full ID: read from /proc/self/mountinfo; the hostname only when they do not say (not in Docker, another runtime).
 */
import fs from 'node:fs'

const OWN_FILE = /\/containers\/([0-9a-f]{64})\/(?:hostname|hosts|resolv\.conf) /

export function selfContainerId(read: (p: string) => string = p => fs.readFileSync(p, 'utf8')): string {
  try {
    const m = OWN_FILE.exec(read('/proc/self/mountinfo'))
    if (m) return m[1]
  } catch { /* not Linux, or no /proc */ }
  return read('/etc/hostname').trim()
}
