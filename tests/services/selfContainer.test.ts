import { describe, it, expect } from 'vitest'
import { selfContainerId } from '../../services/selfContainer'

const ID = 'b0d5f9d74d0cce3ae3bbdd5247c10a2aefd5532b446b50ba82e26a46cd7f18b7'
const files = (map: Record<string, string>) => (p: string) => {
  if (p in map) return map[p]
  throw new Error(`ENOENT: ${p}`)
}

// Docker sets a container's hostname to the start of its ID, but not always (a container recreated by compose kept
// the old one on a server): /etc/hostname, /etc/hosts and /etc/resolv.conf are bind mounts out of the container's own
// directory, whose name is its full ID
describe('selfContainerId', () => {
  it('reads the ID from the bind mounts of /etc/hostname (Docker on the root filesystem)', () => {
    const mountinfo = [
      '612 545 0:52 / / rw,relatime master:301 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/X',
      `628 612 8:1 /var/lib/docker/containers/${ID}/resolv.conf /etc/resolv.conf rw,relatime - ext4 /dev/sda1 rw`,
      `629 612 8:1 /var/lib/docker/containers/${ID}/hostname /etc/hostname rw,relatime - ext4 /dev/sda1 rw`,
    ].join('\n')
    expect(selfContainerId(files({ '/proc/self/mountinfo': mountinfo, '/etc/hostname': 'a8d92c8e37b7\n' }))).toBe(ID)
  })

  it('reads it when Docker has a disk of its own (the path starts at /containers)', () => {
    const mountinfo = `629 612 8:17 /containers/${ID}/hostname /etc/hostname rw,relatime - ext4 /dev/sdb1 rw`
    expect(selfContainerId(files({ '/proc/self/mountinfo': mountinfo }))).toBe(ID)
  })

  it('falls back to the hostname when the mounts do not say (not in Docker, another runtime)', () => {
    expect(selfContainerId(files({ '/proc/self/mountinfo': '612 545 0:52 / / rw - overlay overlay rw', '/etc/hostname': 'a8d92c8e37b7\n' }))).toBe('a8d92c8e37b7')
    expect(selfContainerId(files({ '/etc/hostname': 'c0ffee\n' }))).toBe('c0ffee')
  })
})
