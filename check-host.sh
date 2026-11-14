#!/usr/bin/env bash
# Checks whether this machine is ready for Purgatorium, before the first `docker compose up`.
# Changes nothing on the host; the sysbox check runs one `docker run --rm alpine` (pulls alpine), the Kata check another.
#
#   curl -fsSL https://github.com/csakaszamok/p9m/releases/latest/download/check-host.sh | bash -s -- [domain]
#   ./check-host.sh [domain]     # domain: the HOST_DOMAIN you plan to use, e.g. dev.example.com (UI: p9m.dev.example.com)
#
# Exit code 1 if any check failed (✘), 0 otherwise (warnings ⚠ allowed). What is not secure (!) is listed again at the end.
# Run it in the Purgatorium folder of a running server too: it then also checks the settings in its .env.
set -uo pipefail
cd "$(dirname "$0")" || exit 1

DOMAIN=${1:-}
fails=0 warns=0
risks=()
ok()   { printf '  \033[32m✔\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '      → %s\n' "$2"; warns=$((warns + 1)); }
fail() { printf '  \033[31m✘\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '      → %s\n' "$2"; fails=$((fails + 1)); }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }
# Not secure: shown now, and again in the summary at the end
insecure() { printf '  \033[1;31m!\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '      → %s\n' "$2"; risks+=("$1"$'\t'"${2:-}"); }
# A setting of .env (none before setup.sh)
env_get() { [ -f .env ] && sed -n "s/^$1=//p" .env | tail -1; }
has() { command -v "$1" >/dev/null 2>&1; }
# docker ...: at most 30 s, so a daemon that does not answer is reported instead of hanging the check
dk() { if has timeout; then timeout 30 docker "$@"; else docker "$@"; fi; }
# size_mb SIZE: 4g, 512m, 1024k → megabytes
size_mb() { awk -v s="$1" 'BEGIN { n = s + 0; u = tolower(substr(s, length(s))); print int(u == "g" ? n * 1024 : u == "m" ? n : u == "k" ? n / 1024 : n / 1048576) }'; }
# suggest CPUS MEMORY_MB DISK_GB PER_CPUS PER_MEMORY_MB PER_DISK_MB [OVERHEAD_MB] → "suggested ideal bottleneck" (DISK_GB empty: unknown).
# OVERHEAD_MB: what each sandbox takes beyond its limit (200 with Kata: the VM around it).
# As services/capacity.ts: how many can use their full CPU and memory at once (2 GB kept for the rest),
# twice that (most idle or sleep), at most as many as the disk holds at SANDBOX_DISK each.
suggest() {
  awk -v c="$1" -v m="$2" -v d="$3" -v pc="$4" -v pm="$5" -v pd="$6" -v oh="${7:-0}" 'BEGIN {
    cpu = pc > 0 ? int(c / pc) : 0; mem = pm > 0 ? int((m - 2048) / (pm + oh)) : 0; if (mem < 0) mem = 0
    ideal = cpu < mem ? cpu : mem; if (ideal < 1) ideal = 1
    s = ideal * 2; by = cpu <= mem ? "CPU" : "memory"
    if (d != "" && pd > 0) { disk = int(d * 1024 / pd); if (disk < s) { s = disk; by = "disk" } }
    if (s < 1) s = 1
    print s, ideal, by }'
}
# version_ge A B: A >= B (dotted versions)
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
# mount_hardened PATH: the mount PATH is on has nosuid and nodev
mount_hardened() {
  local opts
  opts=$(findmnt -no OPTIONS --target "$1" 2>/dev/null | tr , '\n')
  grep -qx nosuid <<< "$opts" && grep -qx nodev <<< "$opts"
}

# The runtimes .env allows (empty: sysbox only; all: every one). The Kata checks run only where Kata is meant to be used.
allowed=$(env_get ALLOWED_RUNTIMES | tr 'A-Z' 'a-z' | tr -d ' ')
default_runtime=$(env_get DEFAULT_RUNTIME | tr 'A-Z' 'a-z' | tr -d ' ')
sysbox_allowed=false kata_allowed=false kata_wanted=false
[[ -z "$allowed" || ",$allowed," == *",sysbox,"* || ",$allowed," == *",all,"* ]] && sysbox_allowed=true
[[ ",$allowed," == *",kata,"* || ",$allowed," == *",all,"* ]] && kata_allowed=true
# DEFAULT_RUNTIME=kata alone does not allow it (every create is refused then), but it says Kata is meant to be used
[[ ",$allowed," == *",kata,"* || "$default_runtime" == kata ]] && kata_wanted=true

section "System"
if [ "$(uname -s)" != Linux ]; then
  fail "Not Linux ($(uname -s))" "Purgatorium runs on a Linux host (Docker Desktop works for trying it, not for a server)"
else
  # shellcheck disable=SC1091
  os=$( (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || echo Linux)
  kernel=$(uname -r | cut -d- -f1)
  # Kata: virtiofsd's --modcaps, which keeps device nodes off the sandboxes' shared folders, needs 5.8
  if $kata_wanted && ! version_ge "$kernel" 5.8; then
    fail "$os, kernel $kernel" "Kata sandboxes need kernel 5.8 or newer: upgrade the kernel"
  elif $sysbox_allowed && ! version_ge "$kernel" 5.5; then
    warn "$os, kernel $kernel" "sysbox needs kernel 5.5 or newer; without it sandboxes run privileged (dind)"
  else ok "$os, kernel $kernel"; fi
fi
cpus=$(nproc 2>/dev/null || echo 0)
mem_gb=$(awk '/MemTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo 0)
# A sandbox is limited to 2 CPUs / 4 GB by default (SANDBOX_CPUS, SANDBOX_MEMORY); these are limits, not reservations
if [ "$cpus" -lt 4 ] || [ "$mem_gb" -lt 8 ]; then
  warn "$cpus CPUs, $mem_gb GB RAM" "little for more than a sandbox or two at the default limits (2 CPUs, 4 GB each)"
else
  ok "$cpus CPUs, $mem_gb GB RAM (about $((mem_gb / 4)) sandboxes using their full default 4 GB at once)"
fi

section "Docker"
docker_ok=false
docker_rc=0
has docker && { dk info >/dev/null 2>&1 || docker_rc=$?; }
if ! has docker; then
  fail "docker is not installed" "install Docker Engine: https://docs.docker.com/engine/install/"
elif [ "$docker_rc" = 124 ]; then
  fail "the Docker daemon did not answer in 30 s" "is it busy or stuck? systemctl status docker, then run this again"
elif [ "$docker_rc" != 0 ]; then
  fail "the Docker daemon is not reachable" "is it running? Run this as root or as a member of the docker group"
else
  docker_ok=true
  engine=$(dk version --format '{{.Server.Version}}' 2>/dev/null)
  if version_ge "$engine" 24; then ok "Docker Engine $engine"
  else warn "Docker Engine $engine" "Purgatorium is tested on Docker 24 or newer"; fi
  if compose=$(dk compose version --short 2>/dev/null); then
    compose=${compose#v}
    if version_ge "$compose" 2.20; then ok "Docker Compose $compose"
    # p9m-init: depends_on with restart: true needs 2.17
    elif version_ge "$compose" 2.17; then warn "Docker Compose $compose" "Purgatorium is tested on Compose 2.20 or newer"
    else fail "Docker Compose $compose" "Purgatorium needs Compose 2.17 or newer: update docker-compose-plugin"; fi
  else
    fail "the docker compose plugin is not installed" "install docker-compose-plugin (Compose v2)"
  fi
fi

if $docker_ok; then
  section "Sandbox runtime"
  runtimes=$(docker info --format '{{range $k, $v := .Runtimes}}{{$k}} {{end}}' 2>/dev/null)
  # ALLOWED_RUNTIMES=all allows Kata wherever Docker has it: then its host checks apply too
  [[ ",$allowed," == *",all,"* && " $runtimes " == *" kata "* ]] && kata_wanted=true
  dind_allowed=false
  [[ ",$allowed," == *",dind,"* || ",$allowed," == *",all,"* ]] && dind_allowed=true
  if [[ " $runtimes " != *" sysbox-runc "* ]]; then
    if $dind_allowed; then
      insecure "sysbox is not installed, and ALLOWED_RUNTIMES=$allowed lets sandboxes run privileged (dind): root in a sandbox can reach the host" \
               "dind is for development only: install sysbox (https://github.com/nestybox/sysbox) and empty ALLOWED_RUNTIMES"
    elif ! $sysbox_allowed; then
      ok "sysbox is not installed (not needed: ALLOWED_RUNTIMES=$allowed)"
    elif $kata_wanted; then
      fail "sysbox is not installed, but ALLOWED_RUNTIMES=$allowed allows it: new sysbox sandboxes cannot be created" \
           "install sysbox (https://github.com/nestybox/sysbox), or take sysbox out of ALLOWED_RUNTIMES (e.g. ALLOWED_RUNTIMES=kata)"
    else
      fail "sysbox is not installed: new sandboxes cannot be created (only sysbox is allowed; dind is for development only)" \
           "install sysbox: https://github.com/nestybox/sysbox (to try Purgatorium on a laptop: ALLOWED_RUNTIMES=sysbox,dind in .env)"
    fi
  else
    inactive=""
    if has systemctl; then
      for s in sysbox-mgr sysbox-fs; do systemctl is-active --quiet "$s" || inactive="$inactive $s"; done
    fi
    # The sandbox image's runc starts no container inside a sandbox on an older sysbox
    sysbox_version=$(sysbox-runc --version 2>/dev/null | awk '/version:/ {print $2; exit}')
    if [ -n "$inactive" ]; then
      fail "sysbox is registered with Docker, but not running:$inactive" "systemctl start sysbox (and check: systemctl status sysbox)"
    elif [ -n "$sysbox_version" ] && [ "$(printf '%s\n0.7.0\n' "$sysbox_version" | sort -V | head -1)" != 0.7.0 ]; then
      fail "sysbox $sysbox_version is too old: new sandboxes cannot be created" "upgrade sysbox to 0.7.0 or newer: https://github.com/nestybox/sysbox/releases"
    elif out=$(timeout 120 docker run --rm --runtime=sysbox-runc alpine true 2>&1); then
      ok "sysbox works (new sandboxes use it: no privileged containers)"
      if $dind_allowed; then insecure "ALLOWED_RUNTIMES=$allowed also allows the privileged dind runtime" "dind is for development only: empty ALLOWED_RUNTIMES (sysbox only)"; fi
    else
      fail "sysbox is installed, but a test container did not start" "$(echo "$out" | tail -1)"
    fi
  fi

  if $kata_wanted; then
    section "Kata"
    root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)
    root=${root:-/var/lib/docker}
    if [ "$default_runtime" = kata ] && ! $kata_allowed; then
      warn "DEFAULT_RUNTIME=kata, but ALLOWED_RUNTIMES=${allowed:-(empty: sysbox only)} does not allow kata: every create without a runtime is refused" \
           "add kata to ALLOWED_RUNTIMES (e.g. ALLOWED_RUNTIMES=kata); DEFAULT_RUNTIME only picks the default among the allowed ones"
    fi
    if [ -e /dev/kvm ]; then ok "/dev/kvm is present"
    else fail "no /dev/kvm: Kata runs each sandbox in a VM and needs KVM" "use a dedicated server, or a VM whose provider enables nested virtualization"; fi

    kata_ok=false
    if [[ " $runtimes " != *" kata "* ]]; then
      fail "Kata is not registered with Docker (no kata runtime): new Kata sandboxes cannot be created" "run scripts/install-kata.sh as root (needs KVM)"
    else
      kata_ok=true
      kata_shim=$(docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -o '"kata":{[^}]*}' | grep -oE '"(runtimeType|path)":"[^"]*"' | head -1 | cut -d'"' -f4)
      # Docker does not report a runtimeType: then the shim containerd finds by name (install-kata.sh links it there)
      [ -n "$kata_shim" ] || kata_shim=$(command -v containerd-shim-kata-v2 || echo /usr/local/bin/containerd-shim-kata-v2)
      kata_version=$("$kata_shim" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
      if [ -z "$kata_version" ]; then warn "could not tell the Kata version (shim: ${kata_shim:-?})" "Purgatorium's Kata sandboxes need Kata 4.3.1 or newer"
      elif version_ge "$kata_version" 4.3.1; then ok "Kata $kata_version is registered with Docker"
      else fail "Kata $kata_version is too old: new Kata sandboxes cannot be created" "upgrade to 4.3.1 or newer: KATA_VERSION=4.3.1 scripts/install-kata.sh"; fi
    fi

    # The shipped config is edited in place (Kata 4.3 accepts no other); an /etc copy would be read instead of it
    kata_cfg=/opt/kata/share/defaults/kata-containers/runtime-rs/configuration.toml
    kata_clh=false
    for f in /etc/kata-containers/configuration.toml /etc/kata-containers/runtime-rs/configuration.toml; do
      [ -e "$f" ] && fail "$f shadows the hardened Kata config" "remove it, then run scripts/install-kata.sh again"
    done
    if [ ! -f "$kata_cfg" ]; then
      fail "no Kata config at $kata_cfg" "run scripts/install-kata.sh as root"
    else
      kata_real=$(readlink -f "$kata_cfg")
      case "$kata_real" in
        */configuration-clh-runtime-rs.toml) kata_clh=true ;;
        *) warn "the active Kata config is $kata_real, not Cloud Hypervisor's" "Purgatorium is tested with Cloud Hypervisor: scripts/install-kata.sh --hypervisor clh" ;;
      esac
      bad=""
      grep -qx 'static_sandbox_resource_mgmt = false' "$kata_real" || bad="$bad, static_sandbox_resource_mgmt = false"
      grep -qx 'sandbox_cgroup_only = true' "$kata_real" || bad="$bad, sandbox_cgroup_only = true"
      grep -qF -- '"--xattrmap=:map::user.virtiofs.:"' "$kata_real" || bad="$bad, virtiofsd's --xattrmap"
      # virtiofsd keeps only the last --modcaps: exactly one (counted per occurrence, not per line), and it drops mknod
      if [ "$(grep -o -- '--modcaps' "$kata_real" | wc -l)" -ne 1 ] || ! grep -q -- '"--modcaps=[^"]*-mknod' "$kata_real"; then
        bad="$bad, exactly one --modcaps=-mknod:-setfcap"
      fi
      # Through an annotation a sandbox could change virtiofsd's arguments or binary
      grep -E '^\s*enable_annotations\s*=' "$kata_real" | grep -qE '"virtio_fs_(extra_args|daemon)"' && bad="$bad, enable_annotations without virtio_fs_extra_args and virtio_fs_daemon"
      if [ -n "$bad" ]; then fail "the Kata config $kata_real lacks: ${bad#, }" "run scripts/install-kata.sh again"
      else ok "the Kata config is hardened ($kata_real)"; fi
    fi

    # virtiofsd writes as host root: setuid files and device nodes a sandbox leaves on Docker's data root must be inert
    # volumes and overlay2 too: a separately mounted one keeps its own flags, whatever the data root's are
    for d in "$root" "$root/volumes" "$root/overlay2" /var/lib/containerd; do
      [ -d "$d" ] || continue
      if mount_hardened "$d"; then ok "$d is mounted nosuid,nodev"
      elif [ "$(findmnt -no TARGET --target "$d" 2>/dev/null)" = "$d" ] && [ "$d" != "$root" ] && [ "$d" != /var/lib/containerd ]; then
        fail "$d is its own mount, not nosuid,nodev: a setuid file from a Kata sandbox would run as root on the host" "add nosuid,nodev to its mount options in /etc/fstab, then remount it (mount -o remount,nosuid,nodev $d)"
      else fail "$d is not mounted nosuid,nodev: a setuid file from a Kata sandbox would run as root on the host" "run scripts/install-kata.sh (a self-bind in /etc/fstab: $d $d none bind,nosuid,nodev 0 0)"; fi
    done
    # A running sandbox's rootfs is mounted without nosuid: only root may reach it
    for d in "$root" "$root/overlay2"; do
      mode=$(stat -c %a "$d" 2>/dev/null) || continue
      case "$mode" in
        710|700) ok "$d is mode $mode" ;;
        *) fail "$d is mode $mode: others can reach the running sandboxes' files" "chmod 710 $d" ;;
      esac
    done

    if $kata_ok; then
      if out=$(timeout 120 docker run --rm --runtime kata alpine true 2>&1); then ok "a Kata test container started"
      else fail "Kata is installed, but a test container did not start" "$(echo "$out" | tail -1)"; fi
      if [ -d /run/kata-containers ]; then
        mode=$(stat -c %a /run/kata-containers)
        if [ "${mode: -1}" = 0 ]; then ok "/run/kata-containers is mode $mode"
        else fail "/run/kata-containers is mode $mode: others can reach the running sandboxes' shared files" "chmod o-rwx /run/kata-containers"; fi
      fi
    fi
    # The VMM's own seccomp filter (Seccomp: 2 is filter mode): one layer between a VM escape and the host
    if $kata_clh; then
      clh_pids=$(pgrep -f '(^|/)cloud-hypervisor( |$)' 2>/dev/null)
      if [ -z "$clh_pids" ]; then
        warn "no running cloud-hypervisor process: its seccomp filter was not checked" "run this again while a Kata sandbox runs"
      else
        unfiltered=""
        for pid in $clh_pids; do grep -q $'^Seccomp:\t2$' "/proc/$pid/status" 2>/dev/null || unfiltered="$unfiltered $pid"; done
        if [ -z "$unfiltered" ]; then ok "Cloud Hypervisor runs with its seccomp filter"
        else fail "cloud-hypervisor without its seccomp filter (pid$unfiltered)" "remove disable_seccomp from $kata_real, then restart the Kata sandboxes"; fi
      fi
    fi

    if $sysbox_allowed; then
      ok "setuid programs in sysbox sandboxes' /opt, /home, /root and /srv volumes do not run (nosuid data root)"
    fi
    # Archives and copies of sandbox files, and the host folders Kata sandboxes may write to
    IFS=, read -ra host_roots <<< "$(env_get HOST_MOUNT_ROOTS)"
    for d in opt/sandboxes opt/archive "${host_roots[@]}"; do
      d=$(echo "$d" | tr -d ' ')
      [ -n "$d" ] && [ -d "$d" ] || continue
      abs=$(cd "$d" && pwd -P)
      if mount_hardened "$abs"; then ok "$abs is mounted nosuid,nodev"
      else
        case "$d" in
          opt/*) warn "$abs is not mounted nosuid,nodev: sandbox files kept there keep their setuid bits (new sandbox and archive directories are 0700, so only root reaches them)" "a self-bind in /etc/fstab: $abs $abs none bind,nosuid,nodev 0 0" ;;
          *) warn "HOST_MOUNT_ROOTS $abs is not mounted nosuid,nodev: Kata sandboxes get its folders read-only only" "for read-write, a self-bind in /etc/fstab: $abs $abs none bind,nosuid,nodev 0 0" ;;
        esac
      fi
    done
    # A host switching to Kata: device nodes in existing volumes (other than the 0:0 whiteouts) become reachable
    if [ -r "$root/volumes" ] && [ -x "$root/volumes" ]; then
      nodes=$(find "$root/volumes" -xdev \( -type b -o -type c \) -exec stat -c '%t:%T %n' {} + 2>/dev/null | grep -v '^0:0 ')
      if [ -z "$nodes" ]; then ok "no device nodes in Docker's volumes"
      else
        warn "$(echo "$nodes" | wc -l) device nodes in Docker's volumes (e.g. $(echo "$nodes" | head -1 | cut -d' ' -f2-))" \
             "delete them, and review setuid files (find $root/volumes -xdev -type f -perm /6000), before the first Kata start: find $root/volumes -xdev \\( -type b -o -type c \\) -exec sh -c 'for f; do [ \"\$(stat -c %t:%T \"\$f\")\" = 0:0 ] || rm -v \"\$f\"; done' sh {} +"
      fi
    elif [ -e "$root/volumes" ]; then
      warn "could not read $root/volumes: device nodes in existing volumes not checked" "run this as root"
    fi
  fi

  section "Networks"
  # Every sandbox (asleep ones too) keeps its own Docker network
  pools=$(docker info 2>/dev/null | awk '/Default Address Pools:/ {on=1; next} on && /Base:/ {print $2, $4; next} on {exit}' | tr -d ',')
  if [ -z "$pools" ]; then
    warn "Docker's default address pools: about 30 networks, so about 30 sandboxes" \
         'set "default-address-pools": [{"base": "10.64.0.0/12", "size": 28}] in /etc/docker/daemon.json and restart Docker (see https://csakaszamok.github.io/p9m/latest/install/)'
  else
    total=0
    while read -r base size; do
      prefix=${base#*/}
      [ "$size" -ge "$prefix" ] && total=$((total + (1 << (size - prefix))))
    done <<< "$pools"
    used=$(docker network ls -q | wc -l)
    if [ "$total" -lt 200 ]; then
      warn "address pools allow $total networks ($used in use)" "SANDBOX_MAX_TOTAL defaults to 200 sandboxes: use smaller subnets (e.g. size 28, see https://csakaszamok.github.io/p9m/latest/install/)"
    else
      ok "address pools allow $total networks ($used in use)"
    fi
  fi

  section "Disk"
  root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)
  free_gb=$(df -BG --output=avail "$root" 2>/dev/null | tail -1 | tr -dc 0-9)
  if [ -z "$free_gb" ]; then warn "could not read the free space of $root"
  elif [ "$free_gb" -lt 10 ]; then fail "$free_gb GB free for Docker ($root)" "sandbox images and volumes need at least 10 GB, more with every sandbox"
  elif [ "$free_gb" -lt 50 ]; then warn "$free_gb GB free for Docker ($root)" "enough to start; sandboxes are flagged above 20 GB each (SANDBOX_DISK)"
  else ok "$free_gb GB free for Docker ($root)"; fi
fi

section "How many sandboxes"
# The per-sandbox limits of .env, if there is one already, else the defaults
per_cpus=$(env_get SANDBOX_CPUS) per_mem=$(env_get SANDBOX_MEMORY) per_disk=$(env_get SANDBOX_DISK)
host_mb=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo 2>/dev/null)
if [ -z "$host_mb" ]; then
  warn "could not read the memory size: no suggested SANDBOX_MAX_TOTAL"
else
  read -r max ideal by < <(suggest "$cpus" "$host_mb" "${free_gb:-}" "${per_cpus:-2}" "$(size_mb "${per_mem:-4g}")" "$(size_mb "${per_disk:-20g}")" "$([ "$(env_get DEFAULT_RUNTIME)" = kata ] && echo 200 || echo 0)")
  if [ "$by" = disk ]; then why="as many as the disk holds at ${per_disk:-20g} each, asleep ones too"
  else why="$ideal can use their full ${per_cpus:-2} CPUs and ${per_mem:-4g} at once ($by first), twice that since most idle or sleep"; fi
  set_max=$(env_get SANDBOX_MAX_TOTAL)
  if [ -n "$set_max" ] && [ "$set_max" != 0 ] && [ "$set_max" -gt $((max * 3 / 2)) ]; then
    warn "SANDBOX_MAX_TOTAL=$set_max in .env; $max suggested for this host: $why" "more running at once than the host can serve when they all work: lower it"
  else
    ok "SANDBOX_MAX_TOTAL=$max suggested: $why${set_max:+ (.env: $set_max)}"
  fi
fi
# Every running sandbox takes two addresses on traefik-net (its frps and socat), besides p9m, Traefik and the two
# registries: on a subnet of the address pools' size (/28: 13 addresses) only a few sandboxes can run at once
if $docker_ok; then
  net=$(docker network inspect traefik-net -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null)
  if [ -n "$net" ]; then bits=${net#*/} where="traefik-net ($net)"
  else bits=$(echo "${pools:-}" | awk 'NR == 1 {print $2}') where="traefik-net (a /${bits:-?} of the address pools, once created)"; fi
  if [ -n "$bits" ]; then
    fits=$(( ((1 << (32 - bits)) - 3 - 4) / 2 ))
    want=${set_max:-${max:-0}}; [ "$want" = 0 ] && want=${max:-0}
    if [ "$fits" -lt "$want" ]; then
      fail "$where has room for $fits running sandboxes, SANDBOX_MAX_TOTAL is $want" \
           'give traefik-net its own subnet in docker-compose.override.yml (see "traefik-net" in https://csakaszamok.github.io/p9m/latest/install/)'
    else
      ok "$where has room for $fits running sandboxes"
    fi
  fi
fi

section "Ports"
for port in 80 443 8081; do
  if has ss; then busy=$(ss -ltnH "sport = :$port" 2>/dev/null | head -1); else busy=""; fi
  if [ -z "$busy" ]; then ok "port $port is free"; continue; fi
  # Already used by Purgatorium's own stack (a re-run after `docker compose up`) is fine
  owner=""
  if $docker_ok; then
    owner=$(docker ps --filter "publish=$port" --format '{{.Label "com.docker.compose.project"}}' | head -1)
  fi
  if [ -n "$owner" ] && [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$owner" --filter label=com.docker.compose.service=p9m)" ]; then
    ok "port $port is used by Purgatorium (compose project $owner)"
  else
    fail "port $port is in use" "Purgatorium's Traefik needs 80 and 443, its API 8081: $(echo "$busy" | grep -o 'users:.*' || echo 'see: ss -ltnp')"
  fi
done

section "Internet"
if ! has curl; then
  warn "curl is not installed: registry access not checked"
else
  # A registry answers 401 to an anonymous /v2/: reachable
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://registry-1.docker.io/v2/)
  if [ "$code" = 401 ] || [ "$code" = 200 ]; then ok "Docker Hub is reachable (sandbox, Traefik and Sablier images)"
  else fail "Docker Hub is not reachable (HTTP $code)" "the sandbox images come from there; check the proxy / firewall, or set a registry mirror"; fi
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://ghcr.io/v2/)
  if [ "$code" = 401 ] || [ "$code" = 200 ]; then ok "ghcr.io is reachable (the Purgatorium image)"
  else warn "ghcr.io is not reachable (HTTP $code)" "build the image here instead: docker compose up -d --build"; fi
fi

if [ -n "$DOMAIN" ]; then
  section "Domain: $DOMAIN"
  my_ips=" $(hostname -I 2>/dev/null) "
  resolve() { getent ahostsv4 "$1" 2>/dev/null | awk '{print $1; exit}'; }
  check_name() { # NAME WHAT FAIL|WARN
    local ip
    ip=$(resolve "$1")
    if [ -z "$ip" ]; then
      "$3" "$1 does not resolve" "add a DNS record: *.$DOMAIN (and $DOMAIN) → this machine's address${my_ips:+ (one of:$my_ips)}"
    elif [[ "$my_ips" != *" $ip "* ]] && [[ "$ip" != 127.* ]]; then
      "$3" "$1 → $ip, not this machine (its addresses:$my_ips)" "fine if a proxy or NAT in front forwards to it; otherwise fix the DNS record"
    else
      ok "$1 → $ip ($2)"
    fi
  }
  # The UI's own name (UI_HOST in .env, e.g. console.example.com), else p9m.<domain>
  ui_host=$(env_get UI_HOST)
  check_name "${ui_host:-p9m.$DOMAIN}" "the UI" fail
  # The users' own address (USER_HOST), sbx.<domain> unless off
  user_host=$(env_get USER_HOST)
  user_host=${user_host:-sbx.$DOMAIN}
  [ "${user_host,,}" != off ] && [ "${user_host,,}" != "${ui_host:-p9m.$DOMAIN}" ] && check_name "$user_host" "the users' address" fail
  # A made-up name: only a wildcard record resolves it (every sandbox app has its own name)
  check_name "check-$RANDOM-web.$DOMAIN" "wildcard record for sandbox apps" warn

  if [ -f certs/tls.crt ] || [ -f certs/tls.key ]; then
    section "Certificate (certs/)"
    if ! has openssl; then
      warn "openssl is not installed: certificate not checked"
    elif [ ! -f certs/tls.crt ] || [ ! -f certs/tls.key ]; then
      fail "only one of certs/tls.crt and certs/tls.key is there" "both are needed (PEM)"
    elif ! openssl x509 -in certs/tls.crt -noout 2>/dev/null; then
      fail "certs/tls.crt is not a PEM certificate"
    else
      if [ "$(openssl x509 -in certs/tls.crt -noout -pubkey 2>/dev/null)" != "$(openssl pkey -in certs/tls.key -pubout 2>/dev/null)" ]; then
        fail "certs/tls.key does not belong to certs/tls.crt" "or the key is encrypted: it must be unencrypted PEM"
      else
        ok "the key matches the certificate"
      fi
      end=$(openssl x509 -in certs/tls.crt -noout -enddate | cut -d= -f2)
      if ! openssl x509 -in certs/tls.crt -noout -checkend 0 >/dev/null; then fail "the certificate expired ($end)"
      elif ! openssl x509 -in certs/tls.crt -noout -checkend $((30 * 86400)) >/dev/null; then warn "the certificate expires within 30 days ($end)"
      else ok "valid until $end"; fi
      if openssl x509 -in certs/tls.crt -noout -ext subjectAltName 2>/dev/null | grep -qF "DNS:*.$DOMAIN"; then
        ok "covers *.$DOMAIN"
      else
        warn "does not cover *.$DOMAIN" "sandbox addresses (and p9m.$DOMAIN) would get a certificate warning"
      fi
    fi
  fi
else
  section "Domain"
  warn "no domain given: DNS not checked" "run again with the domain you plan to use: ./check-host.sh dev.example.com"
fi

section "Security"
if [ -f .env ]; then
  # The settings of this folder's .env (a server already set up)
  # Where it really listens (Purgatorium running), else what .env asks for: a docker-compose.yml from before 0.14.0
  # opens it to every network with P9M_API_BIND empty
  api_bind=""
  if $docker_ok; then
    api_bind=$(docker ps --filter publish=8081 --filter label=com.docker.compose.service=p9m --format '{{.Ports}}' | tr ',' '\n' \
      | sed -n 's/^ *\(.*\):8081->.*/\1/p' | sort -u | tr '\n' ' ')
  fi
  if [ -n "$api_bind" ]; then
    api_open=false
    for a in $api_bind; do case "$a" in 127.0.0.1|::1|"[::1]") ;; *) api_open=true ;; esac; done
  else
    case "$(env_get P9M_API_BIND)" in ""|127.0.0.1|localhost|::1) api_open=false ;; *) api_open=true ;; esac
  fi
  if $api_open; then insecure "the API port 8081 is open to every network, as plain HTTP: tokens and passwords cross it unencrypted" "P9M_API_BIND=127.0.0.1 (or empty, with the docker-compose.yml of 0.14.0 or later) in .env, then docker compose up -d"
  else ok "the API port 8081 listens on this machine only (P9M_API_BIND)"; fi
  case "$(env_get ADMIN_LOGIN | tr 'A-Z' 'a-z' | tr -d ' ')" in
    on|true|1|yes) insecure "ADMIN_LOGIN is on: the admin can sign in with a password" "it is for emergencies: ADMIN_LOGIN=off once you are done, then docker compose up -d" ;;
    *) ok "the admin's password sign-in is off (ADMIN_LOGIN)" ;;
  esac
  weak=""
  case "$(env_get ADMIN_TOKEN)" in ""|abc123|change-me-to-a-strong-secret) weak="$weak ADMIN_TOKEN" ;; esac
  case "$(env_get SESSION_SECRET)" in ""|change-me-to-a-long-random-string) weak="$weak SESSION_SECRET" ;; esac
  [ "$(env_get ADMIN_PASSWORD)" = change-me ] && weak="$weak ADMIN_PASSWORD"
  if [ -n "$weak" ]; then insecure "default or example secrets in .env:$weak" "run ./setup.sh (it fills in random ones), or set long random values"
  else ok "no default secrets in .env"; fi
  if [ -n "$(env_get OIDC_ISSUER)" ] && [ -z "$(env_get OIDC_ALLOWED_DOMAINS)$(env_get OIDC_ALLOWED_EMAILS)" ]; then
    # Without OIDC_ALLOW_ANYONE=true Purgatorium does not even start so
    insecure "OIDC sign-in is open to anyone with an account at the provider: strangers can create sandboxes" "OIDC_ALLOWED_DOMAINS or OIDC_ALLOWED_EMAILS in .env (OIDC_ALLOW_ANYONE=true only if you mean it)"
  fi
  if [ "$(env_get SESSION_IDLE_TIMEOUT | tr 'A-Z' 'a-z' | tr -d ' ')" = off ]; then
    insecure "SESSION_IDLE_TIMEOUT=off: a browser left signed in stays signed in for 7 days" "empty SESSION_IDLE_TIMEOUT in .env (30 minutes), then docker compose up -d"
  fi
  # setup.sh wrote public into .env before 0.12.12 (from env.example)
  if [ "$(env_get APPS_ACCESS_DEFAULT | tr 'A-Z' 'a-z' | tr -d ' ')" = public ]; then
    insecure "APPS_ACCESS_DEFAULT=public: every sandbox app without a p9m.access label opens for anyone" "empty APPS_ACCESS_DEFAULT in .env (only the owner opens them), label the public ones p9m.access: public, then docker compose up -d"
  else
    ok "sandbox apps without a label open only for their owner (or the domain) (APPS_ACCESS_DEFAULT)"
  fi
  public_url=$(env_get PUBLIC_URL)
  case "$public_url" in
    https://*) ok "the UI is served over HTTPS ($public_url)" ;;
    *lvh.me*|"") ;;
    *) insecure "PUBLIC_URL is not https ($public_url): sign-ins and tokens cross the network unencrypted" "put a certificate into certs/, then PUBLIC_URL=https://… (see the HTTPS page of the docs)" ;;
  esac
else
  warn "no .env here: Purgatorium's settings not checked" "run this again in the Purgatorium folder after ./setup.sh"
fi
if [ "$(uname -s)" = Linux ]; then
  # Listening on every interface, besides SSH, HTTP(S) and the API port checked above
  if has ss; then
    open=$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E '^(0\.0\.0\.0|\*|\[::\]):' | sed 's/.*://' | sort -un | grep -vxE '22|80|443|8081' | tr '\n' ' ')
    if [ -n "$open" ]; then insecure "ports open to every network besides 22, 80 and 443: $open" "close what does not have to be public (a port Docker publishes passes by ufw: bind it to 127.0.0.1)"
    else ok "no other ports open to every network (besides 22, 80, 443)"; fi
  fi
  if has systemctl && { systemctl is-active --quiet ufw || systemctl is-active --quiet firewalld || systemctl is-active --quiet nftables; }; then
    ok "a firewall is running"
  else
    insecure "no firewall is running (ufw, firewalld or nftables)" "e.g. ufw allow 22,80,443/tcp && ufw enable"
  fi
  if [ -d /etc/apt/apt.conf.d ]; then
    if grep -rqsE 'Unattended-Upgrade[^;]*"1"' /etc/apt/apt.conf.d/ && has unattended-upgrade; then ok "automatic security updates are on (unattended-upgrades)"
    else insecure "automatic security updates are off" "apt install unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades"; fi
  elif has systemctl && systemctl list-unit-files 2>/dev/null | grep -q '^dnf-automatic'; then
    if systemctl is-active --quiet dnf-automatic.timer || systemctl is-active --quiet dnf-automatic-install.timer; then ok "automatic updates are on (dnf-automatic)"
    else insecure "automatic updates are off" "systemctl enable --now dnf-automatic-install.timer"; fi
  fi
  # sshd takes the first value it reads: the drop-ins (read first by the main file's Include) usually decide
  if [ -f /etc/ssh/sshd_config ]; then
    pw=$(cat /etc/ssh/sshd_config.d/*.conf /etc/ssh/sshd_config 2>/dev/null | grep -iE '^\s*PasswordAuthentication\s' | head -1 | awk '{print tolower($2)}')
    if [ "$pw" = no ]; then ok "SSH takes keys only (PasswordAuthentication no)"
    else insecure "SSH accepts passwords: they can be guessed" "PasswordAuthentication no in /etc/ssh/sshd_config (with your key in place first), then systemctl reload ssh"; fi
  fi
fi

echo
if [ "${#risks[@]}" -gt 0 ]; then
  printf '\033[1;31m'
  printf '  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
  printf '  !!!                                                      !!!\n'
  printf '  !!!   NOT SECURE: %2d thing(s) to fix before going public  !!!\n' "${#risks[@]}"
  printf '  !!!                                                      !!!\n'
  printf '  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
  printf '\033[0m'
  for r in "${risks[@]}"; do
    printf '  \033[1;31m!\033[0m %s\n' "${r%%$'\t'*}"
    fix=${r#*$'\t'}; [ -n "$fix" ] && printf '      → %s\n' "$fix"
  done
  echo
fi
if [ "$fails" -gt 0 ]; then
  if [ -f .env ]; then printf '\033[31m%d problem(s)\033[0m and %d warning(s): fix the ✘ lines.\n' "$fails" "$warns"
  else printf '\033[31m%d problem(s)\033[0m and %d warning(s): fix the ✘ lines before installing.\n' "$fails" "$warns"; fi
  exit 1
fi
# Set up already (a .env here): nothing comes next
if [ -f .env ]; then next=""; else next=" Next: ./setup.sh"; fi
if [ "$warns" -gt 0 ]; then printf 'Ready, with %d warning(s).%s\n' "$warns" "$next"
else echo "Ready.$next"; fi
