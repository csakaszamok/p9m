import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import yaml from 'js-yaml'
import {
  MOUNTS_LABEL, SYSTEM_DIRS, hostMountRoots, parseHostMountRoots, cleanPath, underRoot, ownTargets,
  validateMount, readMounts, withMounts, mountsOf, setMounts, addMount, MountError, type HostMount,
} from '../../services/hostMounts'
import { withUsersDir, mountedUsersDir } from '../../services/pathMigration'

// The sandbox's compose file as created from runtimes/dind.yaml (its mounts are what the targets must keep clear of)
const RUNTIME = yaml.load(fs.readFileSync(path.join(__dirname, '..', '..', 'runtimes', 'dind.yaml'), 'utf8')) as { docker_compose: unknown }
const HOST = '/data/p9m/opt/sandboxes/admin'
const compose = () => yaml.dump(RUNTIME.docker_compose, { lineWidth: -1 }).split('${sandbox_dir}').join(`${HOST}/p9m-shop`).split('${name}').join('p9m-shop')
const ctx = (existing: HostMount[] = [], text = compose()) => ({ roots: ['/srv/shared', '/data/projects'], existing, own: ownTargets(text) })

describe('HOST_MOUNT_ROOTS', () => {
  it('a comma-separated list of absolute directories, normalized; unset or empty: none (the feature is off)', () => {
    expect(hostMountRoots({})).toEqual([])
    expect(hostMountRoots({ HOST_MOUNT_ROOTS: ' ' })).toEqual([])
    expect(hostMountRoots({ HOST_MOUNT_ROOTS: '/srv/shared/, /data//projects ,' })).toEqual(['/srv/shared', '/data/projects'])
  })
  it('relative ones and ones with .. are left out (and reported)', () => {
    expect(parseHostMountRoots('srv/x,/a/../b,/ok')).toEqual({ roots: ['/ok'], invalid: ['srv/x', '/a/../b'] })
  })
})

describe('cleanPath / underRoot', () => {
  it('absolute, normalized, no trailing slash; relative, .., $ (compose variables) and control characters refused', () => {
    expect(cleanPath('/srv/shared/')).toBe('/srv/shared')
    expect(cleanPath('/srv//shared/./x')).toBe('/srv/shared/x')
    expect(cleanPath('/')).toBe('/')
    for (const bad of ['srv/shared', '', '/srv/../etc', '/srv/shared/..', '/srv/$HOME', '/srv/a\nb', 'C:\\x', 42, null]) expect(cleanPath(bad), String(bad)).toBeNull()
  })
  it('at or under a root, never a sibling that only starts with the same letters', () => {
    expect(underRoot('/srv/shared', ['/srv/shared'])).toBe(true)
    expect(underRoot('/srv/shared/team/a', ['/srv/shared'])).toBe(true)
    expect(underRoot('/srv/shared2', ['/srv/shared'])).toBe(false)
    expect(underRoot('/srv', ['/srv/shared'])).toBe(false)
    expect(underRoot('/anything', ['/'])).toBe(true)
    expect(underRoot('/srv/shared', [])).toBe(false)
  })
})

describe('ownTargets', () => {
  it("the sandbox container's own mount points, from its compose file (not its host mounts)", () => {
    const own = ownTargets(compose())
    for (const t of ['/var/lib/docker', '/opt', '/root', '/home', '/srv', '/certs/server', '/inner', '/etc/docker/daemon.json']) expect(own).toContain(t)
    const mounted = withMounts(compose(), [{ host: '/srv/shared', target: '/mnt/shared', readonly: false }])
    expect(ownTargets(mounted)).not.toContain('/mnt/shared')
  })
})

describe('validateMount', () => {
  it('a host path under a root; the target defaults to /mnt/<last part of the host path>, read-write', () => {
    expect(validateMount({ host: '/srv/shared/team/' }, ctx())).toEqual({ host: '/srv/shared/team', target: '/mnt/team', readonly: false })
    expect(validateMount({ host: '/data/projects', target: '/work/p/', readonly: true }, ctx())).toEqual({ host: '/data/projects', target: '/work/p', readonly: true })
  })
  it('refuses a host path outside the roots, relative, or with ..', () => {
    expect(validateMount({ host: '/srv/shared2' }, ctx())).toMatch(/HOST_MOUNT_ROOTS/)
    expect(validateMount({ host: '/etc' }, ctx())).toMatch(/HOST_MOUNT_ROOTS/)
    expect(validateMount({ host: 'srv/shared' }, ctx())).toMatch(/absolute/)
    expect(validateMount({ host: '/srv/shared/../../etc' }, ctx())).toMatch(/absolute/)
    expect(validateMount({}, ctx())).toMatch(/host/)
    expect(validateMount('x', ctx())).toMatch(/JSON object/)
  })
  it('refuses a target that is relative, /, has .., or is taken', () => {
    expect(validateMount({ host: '/srv/shared', target: 'mnt/x' }, ctx())).toMatch(/absolute/)
    expect(validateMount({ host: '/srv/shared', target: '/' }, ctx())).toMatch(/not \//)
    expect(validateMount({ host: '/srv/shared', target: '/mnt/../x' }, ctx())).toMatch(/absolute/)
    const existing = [{ host: '/data/projects', target: '/mnt/shared', readonly: false }]
    expect(validateMount({ host: '/srv/shared' }, ctx(existing))).toMatch(/already/)
  })
  it("refuses a target on, above or under the sandbox's own mounts (from its compose file)", () => {
    for (const t of ['/var/lib/docker', '/var/lib', '/var', '/var/lib/docker/volumes/x', '/opt', '/opt/data', '/root/x', '/home', '/srv/x', '/inner', '/certs', '/certs/server/a']) {
      expect(validateMount({ host: '/srv/shared', target: t }, ctx()), t).toMatch(/own mount/)
    }
  })
  it('refuses a target in a system directory', () => {
    for (const d of ['/proc', '/sys', '/dev', '/etc', '/usr', '/bin', '/sbin', '/lib', '/run', '/boot']) expect(SYSTEM_DIRS).toContain(d)
    for (const t of ['/proc', '/etc/x', '/usr/local/share', '/dev/shm', '/run/docker']) {
      expect(validateMount({ host: '/srv/shared', target: t }, ctx()), t).toMatch(/system/)
    }
    // A sibling that only starts with the same letters is fine
    expect(validateMount({ host: '/srv/shared', target: '/etcetera' }, ctx())).toMatchObject({ target: '/etcetera' })
  })
  it('the host path / has no default target; readonly must be a boolean', () => {
    const all = { ...ctx(), roots: ['/'] }
    expect(validateMount({ host: '/' }, all)).toMatch(/target/)
    expect(validateMount({ host: '/srv/shared', readonly: 'yes' }, ctx())).toMatch(/readonly/)
  })
})

describe('withMounts / readMounts', () => {
  const m1 = { host: '/srv/shared', target: '/mnt/shared', readonly: true }
  const m2 = { host: '/data/projects/a', target: '/work/a', readonly: false }
  type Svc = { volumes: unknown[]; labels: Record<string, string> }
  const sandbox = (text: string) => (yaml.load(text) as { services: { sandbox: Svc } }).services.sandbox

  it('bind mounts on the sandbox (long syntax, a missing host folder is an error, not an empty new one) and the p9m.mounts label', () => {
    const text = withMounts(compose(), [m1, m2])
    const sb = sandbox(text)
    expect(sb.volumes).toContainEqual({ type: 'bind', source: '/srv/shared', target: '/mnt/shared', read_only: true, bind: { create_host_path: false } })
    expect(sb.volumes).toContainEqual({ type: 'bind', source: '/data/projects/a', target: '/work/a', read_only: false, bind: { create_host_path: false } })
    expect(JSON.parse(sb.labels[MOUNTS_LABEL])).toEqual([m1, m2])
    expect(readMounts(text)).toEqual([m1, m2])
    // Everything else stays: its own mounts and labels
    expect(sb.volumes).toContain('docker_data:/var/lib/docker')
    expect(sb.labels['p9m.name']).toBe('p9m-shop')
  })
  it('replaces the earlier ones; none left: no label, no binds', () => {
    const one = withMounts(withMounts(compose(), [m1, m2]), [m2])
    expect(readMounts(one)).toEqual([m2])
    expect(sandbox(one).volumes.filter(v => typeof v === 'object')).toHaveLength(1)
    const none = withMounts(one, [])
    expect(readMounts(none)).toEqual([])
    expect(sandbox(none).labels[MOUNTS_LABEL]).toBeUndefined()
    expect(sandbox(none).volumes).toEqual(sandbox(compose()).volumes)
  })
  it('a file without the label, or not readable: no mounts', () => {
    expect(readMounts(compose())).toEqual([])
    expect(readMounts(': not yaml [')).toEqual([])
    expect(() => withMounts(yaml.dump({ services: { other: {} } }), [m1])).toThrow(/no sandbox service/)
  })

  it('kept by the host-path migration (a moved install directory)', () => {
    // A host mount that happens to sit in the sandbox's old directory is not moved with it
    const inDir = { host: `${HOST}/p9m-shop/shared`, target: '/mnt/x', readonly: false }
    const text = withMounts(compose(), [inDir])
    expect(mountedUsersDir(text, 'p9m-shop')).toBe(HOST)
    const moved = withUsersDir(text, 'p9m-shop', HOST, '/new/sandboxes/admin')
    expect(readMounts(moved)).toEqual([inDir])
    expect(sandbox(moved).volumes).toContainEqual(expect.objectContaining({ source: inDir.host }))
    expect(sandbox(moved).volumes).toContain('/new/sandboxes/admin/p9m-shop/certs/server:/certs/server:ro')
  })
})

describe('setMounts', () => {
  const file = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9m-mounts-'))
    fs.writeFileSync(`${dir}/docker-compose.yml`, compose())
    return `${dir}/docker-compose.yml`
  }
  const m1 = { host: '/srv/shared', target: '/mnt/shared', readonly: false }

  it('writes the compose file and recreates the sandbox container: started if it was running, else left stopped', async () => {
    for (const [status, start] of [['running', true], ['exited', false], ['created', false]] as const) {
      const f = file()
      const recreate = vi.fn(async () => {})
      expect(await setMounts('p9m-shop', status, [m1], { composePath: () => f, recreate })).toEqual([m1])
      expect(recreate).toHaveBeenCalledWith(f, start)
      expect(mountsOf('p9m-shop', f)).toEqual([m1])
    }
  })
  it('deep sleep: only the file (it applies when the sandbox wakes)', async () => {
    const f = file()
    const recreate = vi.fn(async () => {})
    await setMounts('p9m-shop', 'deep_sleep', [m1], { composePath: () => f, recreate })
    expect(recreate).not.toHaveBeenCalled()
    expect(mountsOf('p9m-shop', f)).toEqual([m1])
  })
  it("Docker refuses (e.g. the host folder does not exist): the file as it was, the container brought back, Docker's words in the error", async () => {
    const f = file()
    const before = fs.readFileSync(f, 'utf8')
    const recreate = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Command failed: docker compose up'), { stderr: 'Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /srv/shared\n' }))
      .mockResolvedValueOnce(undefined)
    await expect(setMounts('p9m-shop', 'running', [m1], { composePath: () => f, recreate })).rejects.toThrow(/bind source path does not exist: \/srv\/shared/)
    expect(fs.readFileSync(f, 'utf8')).toBe(before)
    expect(recreate).toHaveBeenCalledTimes(2)
    expect(recreate).toHaveBeenLastCalledWith(f, true)
  })
  it('mountsOf: none for a sandbox without a readable compose file', () => {
    expect(mountsOf('p9m-none', '/nonexistent/docker-compose.yml')).toEqual([])
  })
})

describe('addMount: Kata sandboxes', () => {
  // Guest root reaches a read-write host folder through virtiofsd as host root: only a nosuid,nodev host mount defuses setuid files left there
  const KATA = yaml.load(fs.readFileSync(path.join(__dirname, '..', '..', 'runtimes', 'kata.yaml'), 'utf8')) as { docker_compose: unknown }
  const kataCompose = () => yaml.dump(KATA.docker_compose, { lineWidth: -1 }).split('${runtime_name}').join('kata').split('${sandbox_dir}').join(`${HOST}/p9m-shop`).split('${name}').join('p9m-shop')
  const file = (text: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9m-kata-mounts-'))
    fs.writeFileSync(`${dir}/docker-compose.yml`, text)
    return `${dir}/docker-compose.yml`
  }
  const env = { HOST_MOUNT_ROOTS: '/srv/shared' }
  const rw = { host: '/srv/shared/a', target: '/mnt/a' }
  const run = (text: string, input: unknown, options: string[]) => {
    const f = file(text)
    const mountOptions = vi.fn(async () => options)
    const recreate = vi.fn(async () => {})
    return { mountOptions, recreate, result: addMount('p9m-shop', 'running', input, { env, composePath: () => f, recreate, mountOptions }) }
  }

  it('read-write on a host mount without nosuid and nodev: refused', async () => {
    const { result, recreate, mountOptions } = run(kataCompose(), rw, ['rw', 'relatime'])
    await expect(result).rejects.toThrow('A Kata sandbox gets a read-write host folder only where the host mounts it nosuid,nodev; mount it read-only')
    await expect(result).rejects.toBeInstanceOf(MountError)
    expect(mountOptions).toHaveBeenCalledWith('/srv/shared/a')
    expect(recreate).not.toHaveBeenCalled()
  })
  it('read-write needs both flags: nosuid alone is refused', async () => {
    await expect(run(kataCompose(), rw, ['rw', 'nosuid']).result).rejects.toThrow(/nosuid,nodev/)
  })
  it('read-write on a nosuid,nodev host mount: added', async () => {
    expect(await run(kataCompose(), rw, ['rw', 'nosuid', 'nodev']).result).toEqual([{ ...rw, readonly: false }])
  })
  it('read-only: added whatever the host mount flags are', async () => {
    const { result, mountOptions } = run(kataCompose(), { ...rw, readonly: true }, ['rw'])
    expect(await result).toEqual([{ ...rw, readonly: true }])
    expect(mountOptions).not.toHaveBeenCalled()
  })
  it('a dind sandbox: read-write added, and the host mount is never inspected', async () => {
    const { result, mountOptions } = run(compose(), rw, ['rw'])
    expect(await result).toEqual([{ ...rw, readonly: false }])
    expect(mountOptions).not.toHaveBeenCalled()
  })
  it('fails closed: if the host mount options cannot be read, nothing is added or recreated', async () => {
    const f = file(kataCompose())
    const recreate = vi.fn(async () => {})
    await expect(addMount('p9m-shop', 'running', rw, { env, composePath: () => f, recreate, mountOptions: async () => { throw new Error('docker unavailable') } })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/could not read the mount options of \/srv\/shared\/a.*docker unavailable/) })
    expect(recreate).not.toHaveBeenCalled()
    expect(mountsOf('p9m-shop', f)).toEqual([])
  })
  it("says what Docker said when the host folder is missing, as a MountError", async () => {
    const f = file(kataCompose())
    const recreate = vi.fn(async () => {})
    const missing = Object.assign(new Error('Command failed: docker run'), { stderr: 'docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /srv/shared/a' })
    const err = await addMount('p9m-shop', 'running', rw, { env, composePath: () => f, recreate, mountOptions: async () => { throw missing } }).catch(e => e)
    expect(err).toBeInstanceOf(MountError)
    expect(err.message).toContain('bind source path does not exist: /srv/shared/a')
    expect(err.message).not.toContain('Command failed')
    expect(recreate).not.toHaveBeenCalled()
  })
})
