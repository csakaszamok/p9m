// The compose file of a project in a sandbox, made from what its containers run (docker inspect). scripts/export-app.mjs
// writes the result; no input of it reaches a path or a shell: what a sandbox's user controls is only data here.
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
const safe = (kind, s) => { if (!NAME.test(s)) throw new Error(`not a usable ${kind} name: ${JSON.stringify(s)}`); return s }
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const seconds = ns => `${ns / 1e9}s`
// Files of the machine itself, not of the app: they are not copied, and the target's own are used
const SYSTEM = /^\/(var\/run\/docker\.sock|run\/docker\.sock|proc|sys|dev)(\/|$)/
const MANAGED_LABEL = /^(com\.docker\.|p9m\.|desktop\.docker\.)/

/** One value of an env file, double-quoted: the one form compose reads back exactly, whatever is in the value. */
export const envLine = (key, value) => `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`

function envOf(config, image) {
  const inherited = new Set(image?.Config?.Env ?? [])
  return (config.Env ?? []).filter(e => !inherited.has(e) && e.includes('=')).map(e => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)])
}

function dependsOn(label) {
  const out = {}
  for (const part of (label ?? '').split(',').filter(Boolean)) {
    const [service, condition] = part.split(':')
    out[safe('service', service)] = { condition: condition || 'service_started' }
  }
  return Object.keys(out).length ? out : undefined
}

function healthcheck(h) {
  if (!h?.Test?.length) return undefined
  if (h.Test[0] === 'NONE') return { disable: true }
  return {
    test: h.Test,
    ...(h.Interval ? { interval: seconds(h.Interval) } : {}),
    ...(h.Timeout ? { timeout: seconds(h.Timeout) } : {}),
    ...(h.StartPeriod ? { start_period: seconds(h.StartPeriod) } : {}),
    ...(h.Retries ? { retries: h.Retries } : {}),
  }
}

function portsOf(bindings) {
  const out = []
  for (const [port, hosts] of Object.entries(bindings ?? {})) {
    const [container, protocol] = port.split('/')
    for (const h of hosts ?? []) {
      const ip = h.HostIp && h.HostIp !== '0.0.0.0' && h.HostIp !== '::' ? `${h.HostIp}:` : ''
      out.push(`${ip}${h.HostPort}:${container}${protocol && protocol !== 'tcp' ? `/${protocol}` : ''}`)
    }
  }
  return [...new Set(out)].sort()
}

/**
 * containers: `docker inspect` of the project's containers; images: of their images, by the name in Config.Image;
 * isDir: of each bind source in the sandbox. Returns the compose object, one env file per service, the volumes and
 * bind sources to save, the images, and what the reader must know before running it.
 */
export function composeFromInspect({ project, containers, images, isDir }) {
  safe('project', project)
  const services = {}, topVolumes = {}, topNetworks = {}, envFiles = {}, warnings = [], binds = [], volumes = new Map()
  const bindOf = new Map()
  const byService = new Map()
  for (const c of [...containers].sort((a, b) => Number(a.Config.Labels?.['com.docker.compose.container-number'] ?? 1) - Number(b.Config.Labels?.['com.docker.compose.container-number'] ?? 1))) {
    const service = safe('service', c.Config.Labels?.['com.docker.compose.service'] ?? '')
    if (byService.has(service)) { byService.get(service).extra++; continue }
    byService.set(service, { c, extra: 0 })
  }

  for (const [service, { c, extra }] of byService) {
    const image = images[c.Config.Image], hc = c.HostConfig ?? {}, s = { image: c.Config.Image }
    if (extra) warnings.push(`${service}: ran ${extra + 1} replicas, the export has one`)
    if (!same(c.Config.Entrypoint, image?.Config?.Entrypoint)) s.entrypoint = c.Config.Entrypoint ?? []
    if (!same(c.Config.Cmd, image?.Config?.Cmd)) s.command = c.Config.Cmd ?? []
    if (c.Config.User && c.Config.User !== image?.Config?.User) s.user = c.Config.User
    if (c.Config.WorkingDir && c.Config.WorkingDir !== image?.Config?.WorkingDir) s.working_dir = c.Config.WorkingDir
    if (c.Config.Tty) s.tty = true
    if (c.Config.OpenStdin) s.stdin_open = true

    const env = envOf(c.Config, image)
    if (env.length) { envFiles[service] = env.map(([k, v]) => envLine(k, v)).join('\n') + '\n'; s.env_file = [`env/${service}.env`] }

    const labels = Object.fromEntries(Object.entries(c.Config.Labels ?? {}).filter(([k, v]) => !MANAGED_LABEL.test(k) && image?.Config?.Labels?.[k] !== v))
    if (Object.keys(labels).length) s.labels = labels
    const ports = portsOf(hc.PortBindings)
    if (ports.length) s.ports = ports
    if (hc.RestartPolicy?.Name && hc.RestartPolicy.Name !== 'no') s.restart = hc.RestartPolicy.Name === 'on-failure' && hc.RestartPolicy.MaximumRetryCount ? `on-failure:${hc.RestartPolicy.MaximumRetryCount}` : hc.RestartPolicy.Name
    const deps = dependsOn(c.Config.Labels?.['com.docker.compose.depends_on'])
    if (deps) s.depends_on = deps
    const health = !same(c.Config.Healthcheck, image?.Config?.Healthcheck) ? healthcheck(c.Config.Healthcheck) : undefined
    if (health) s.healthcheck = health

    const mounts = []
    for (const m of c.Mounts ?? []) {
      if (m.Type === 'volume') {
        safe('volume', m.Name)
        const prefix = `${project}_`
        const key = m.Name.startsWith(prefix) ? m.Name.slice(prefix.length) : m.Name
        topVolumes[key] = { name: m.Name }
        volumes.set(m.Name, key)
        mounts.push({ type: 'volume', source: key, target: m.Destination, ...(m.RW === false ? { read_only: true } : {}) })
      } else if (m.Type === 'bind') {
        if (SYSTEM.test(m.Source)) {
          warnings.push(`${service}: mounts the machine's own ${m.Source}, which gives it control over that machine`)
          mounts.push({ type: 'bind', source: m.Source, target: m.Destination, ...(m.RW === false ? { read_only: true } : {}) })
          continue
        }
        if (!bindOf.has(m.Source)) {
          const n = binds.length, dir = !!isDir[m.Source]
          bindOf.set(m.Source, dir ? `./binds/${n}` : `./binds/${n}/file`)
          binds.push({ n, source: m.Source, dir })
        }
        mounts.push({ type: 'bind', source: bindOf.get(m.Source), target: m.Destination, ...(m.RW === false ? { read_only: true } : {}) })
      }
    }
    if (mounts.length) s.volumes = mounts

    const nets = {}
    for (const [net, cfg] of Object.entries(c.NetworkSettings?.Networks ?? {})) {
      const key = net.startsWith(`${project}_`) ? net.slice(project.length + 1) : net
      if (hc.NetworkMode === 'host' || hc.NetworkMode === 'none' || net === 'bridge') continue
      if (cfg?.IPAMConfig?.IPv4Address) warnings.push(`${service}: had a fixed address on ${key}, the export does not`)
      if (key === 'default') continue
      safe('network', key)
      topNetworks[key] = net === `${project}_${key}` ? {} : { name: net }
      const aliases = (cfg?.Aliases ?? []).filter(a => a !== service && a !== c.Config.Hostname && a !== c.Name?.replace(/^\//, ''))
      nets[key] = aliases.length ? { aliases } : {}
    }
    if (Object.keys(nets).length) s.networks = nets

    if (hc.NetworkMode === 'host') { s.network_mode = 'host'; warnings.push(`${service}: uses the machine's own network`) }
    if (hc.NetworkMode === 'none') s.network_mode = 'none'
    if ((hc.NetworkMode ?? '').startsWith('container:')) warnings.push(`${service}: shared another container's network, the export does not`)
    if (hc.Privileged) { s.privileged = true; warnings.push(`${service}: runs privileged, with control over the machine`) }
    if (hc.PidMode === 'host') { s.pid = 'host'; warnings.push(`${service}: sees the machine's processes`) }
    if (hc.CapAdd?.length) { s.cap_add = hc.CapAdd; warnings.push(`${service}: has extra capabilities: ${hc.CapAdd.join(', ')}`) }
    if (hc.CapDrop?.length) s.cap_drop = hc.CapDrop
    if (hc.Devices?.length) { s.devices = hc.Devices.map(d => `${d.PathOnHost}:${d.PathInContainer}:${d.CgroupPermissions}`); warnings.push(`${service}: uses the machine's devices`) }
    if (hc.SecurityOpt?.length) s.security_opt = hc.SecurityOpt
    if (hc.ReadonlyRootfs) s.read_only = true
    if (hc.ExtraHosts?.length) s.extra_hosts = hc.ExtraHosts
    if (hc.Init) s.init = true
    if (hc.Tmpfs && Object.keys(hc.Tmpfs).length) s.tmpfs = Object.entries(hc.Tmpfs).map(([p, o]) => o ? `${p}:${o}` : p)
    if (hc.Sysctls && Object.keys(hc.Sysctls).length) s.sysctls = hc.Sysctls
    if (hc.Memory > 0) s.mem_limit = hc.Memory
    if (hc.NanoCpus > 0) s.cpus = hc.NanoCpus / 1e9
    if (hc.ShmSize && hc.ShmSize !== 67108864) s.shm_size = hc.ShmSize
    services[service] = s
  }

  const compose = {
    name: project, services,
    ...(Object.keys(topVolumes).length ? { volumes: topVolumes } : {}),
    ...(Object.keys(topNetworks).length ? { networks: topNetworks } : {}),
  }
  return { compose, envFiles, volumes: [...volumes.keys()], binds, images: [...new Set(Object.values(services).map(s => s.image))], warnings }
}
