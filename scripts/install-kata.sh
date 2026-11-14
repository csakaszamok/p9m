#!/usr/bin/env bash
# Installs Kata Containers (static release) on this host and registers it with Docker as the runtime "kata", with
# the hardened configuration Purgatorium's Kata sandboxes rely on. Run as root.
#
#   sudo scripts/install-kata.sh [--hypervisor clh|qemu] [--yes]   # default clh (Cloud Hypervisor)
#   KATA_VERSION=4.3.1 sudo scripts/install-kata.sh                # another Kata release
#
# Needs KVM (/dev/kvm): a dedicated server, or a VM whose provider offers nested virtualization.
# Safe to run again: when everything is already in place it changes nothing and leaves Docker running. Otherwise
# Docker is stopped for a moment (its data root gets a nosuid,nodev self-bind, kept in /etc/fstab), which stops
# every running container and sandbox: with containers running it asks for --yes first.
set -euo pipefail

KATA_VERSION=${KATA_VERSION:-4.3.1}
KATA_DEFAULTS=/opt/kata/share/defaults/kata-containers

# The three virtiofsd arguments, in this order:
# - --xattr with the map: every guest xattr (trusted.overlay.* and security.capability too) is stored on the host as
#   user.virtiofs.*, so overlay2 inside the sandbox works on a plain volume and image layers keep their capabilities;
# - --modcaps: no device nodes on shared paths (the 0:0 whiteouts still work). Exactly one --modcaps: virtiofsd keeps
#   only the last one.
KATA_VIRTIOFS_ARGS='"--xattr", "--xattrmap=:map::user.virtiofs.:", "--modcaps=-mknod:-setfcap"'

# kata_edit_config FILE: the hardened settings in a shipped Kata config, edited in place (Kata 4.3 accepts only its
# shipped config files). Running it again changes nothing. Fails when a setting could not be made.
kata_edit_config() {
  local f=$1
  # Earlier hardening arguments out first, so a re-run (or an older install) never ends with two of them
  sed -i -E '/^virtio_fs_extra_args\s*=/{
    s/"--xattr"//g
    s/"--xattrmap=[^"]*"//g
    s/"--modcaps=[^"]*"//g
    s/\[(\s*,)+\s*/[/
    :c
    s/,\s*,/,/
    tc
    s/,\s*\]/]/
    s/^(virtio_fs_extra_args\s*=\s*\[)\s*/\1'"$KATA_VIRTIOFS_ARGS"', /
    s/,\s*\]/]/
  }' "$f"
  # Dynamic sizing: `docker update` reaches the guest, and the container's limit is added to a small base
  if grep -qE '^#?\s*static_sandbox_resource_mgmt\s*=' "$f"; then
    sed -i -E 's/^#?\s*static_sandbox_resource_mgmt\s*=.*/static_sandbox_resource_mgmt = false/' "$f"
  else
    sed -i -E 's/^\[runtime\]\s*$/[runtime]\nstatic_sandbox_resource_mgmt = false/' "$f"
  fi
  sed -i -E 's/^default_memory\s*=.*/default_memory = 512/' "$f"
  # The whole VM (hypervisor, virtiofsd) in the container's cgroup, so Docker's limits cover it
  sed -i -E 's/^#?\s*sandbox_cgroup_only\s*=.*/sandbox_cgroup_only = true/' "$f"
  # A sandbox must not be able to change virtiofsd's arguments or binary through an annotation
  sed -i -E '/^enable_annotations\s*=/{
    s/"virtio_fs_(extra_args|daemon)"//g
    s/\[(\s*,)+\s*/[/
    :c
    s/,\s*,/,/
    tc
    s/,\s*\]/]/
  }' "$f"

  # A sed that matched nothing must fail here, not leave an unhardened config
  kata_verify_config "$f" || return 1
  grep -nE '^\s*(static_sandbox_resource_mgmt|default_memory|sandbox_cgroup_only|virtio_fs_extra_args|enable_annotations)\s*=' "$f"
}

# kata_verify_config FILE: FILE has every hardened setting; else names the missing ones and fails
kata_verify_config() {
  local f=$1 bad=""
  grep -qx 'static_sandbox_resource_mgmt = false' "$f" || bad="$bad static_sandbox_resource_mgmt"
  grep -qx 'default_memory = 512' "$f" || bad="$bad default_memory"
  grep -qx 'sandbox_cgroup_only = true' "$f" || bad="$bad sandbox_cgroup_only"
  grep -qF -- "$KATA_VIRTIOFS_ARGS" "$f" || bad="$bad virtio_fs_extra_args"
  # Occurrences, not lines: a second --modcaps on the same line would override the first
  [ "$(grep -o -- '--modcaps' "$f" | wc -l)" -eq 1 ] || bad="$bad --modcaps(count)"
  ! grep -E '^enable_annotations\s*=' "$f" | grep -qE '"virtio_fs_(extra_args|daemon)"' || bad="$bad enable_annotations"
  if [ -n "$bad" ]; then
    echo "install-kata: could not set in $f:$bad" >&2
    return 1
  fi
}

# kata_find_shim [ROOT]: the runtime-rs containerd shim under ROOT (default /opt/kata); nothing when there is none yet
kata_find_shim() {
  local root=${1:-/opt/kata}
  [ -d "$root" ] || return 0
  find "$root" -path '*runtime-rs*' -name containerd-shim-kata-v2 \( -type f -o -type l \) 2>/dev/null | head -1 || true
}

# kata_private_run_dir [CONF] [DIR]: DIR (default /run/kata-containers, the running VMs' shared files) closed to
# other users, now and after a reboot: /run starts empty, and systemd-tmpfiles makes DIR with this mode before Kata
# would make it 0755
kata_private_run_dir() {
  local conf=${1:-/etc/tmpfiles.d/kata-containers.conf} dir=${2:-/run/kata-containers}
  mkdir -p "$(dirname "$conf")" "$dir"
  printf 'd %s 0750 root root -
' "$dir" > "$conf"
  chmod 0750 "$dir"
}

# mount_hardened DIR: DIR's mount has nosuid and nodev
mount_hardened() {
  local opts
  opts=$(findmnt -no OPTIONS --target "$1" 2>/dev/null | tr , '\n')
  grep -qx nosuid <<< "$opts" && grep -qx nodev <<< "$opts"
}

# kata_submounts DIR: the mount points under DIR (not DIR itself), one per line, from "TARGET FSTYPE" lines on stdin
# (findmnt -rn -o TARGET,FSTYPE). A plain self-bind of DIR would hide them. A running container's own mounts (its
# overlay merged dir, its shm) are left out: they go with the container
kata_submounts() {
  local dir=$1 target fstype
  while read -r target fstype _; do
    case "$target" in "$dir"/*) ;; *) continue ;; esac
    case "$target" in
      "$dir"/overlay2/*/merged) [ "$fstype" = overlay ] && continue ;;
      "$dir"/containers/*/mounts/shm) [ "$fstype" = tmpfs ] && continue ;;
    esac
    printf '%s\n' "$target"
  done
}

# State for the EXIT trap: what this run changed, the step it is on, whether it stopped Docker
_ki_dl="" _ki_stopped=false _ki_step=""
_ki_done=()

_ki_on_exit() {
  local rc=$?
  [ -z "$_ki_dl" ] || rm -rf "$_ki_dl"
  [ "$rc" = 0 ] && return 0
  echo "install-kata: failed (exit $rc) at: ${_ki_step:-start}" >&2
  if [ "${#_ki_done[@]}" -gt 0 ]; then
    echo "install-kata: changed before that:" >&2
    printf '  - %s\n' "${_ki_done[@]}" >&2
  fi
  if $_ki_stopped; then
    echo "install-kata: starting containerd and Docker again" >&2
    systemctl start containerd docker || echo "install-kata: they did not start: see systemctl status docker containerd" >&2
  fi
}

main() {
  local hypervisor=clh yes=false
  while [ $# -gt 0 ]; do
    case "$1" in
      --hypervisor) hypervisor=${2:-}; shift 2 || { echo "--hypervisor needs a value: clh or qemu" >&2; exit 2; } ;;
      --hypervisor=*) hypervisor=${1#*=}; shift ;;
      -y|--yes) yes=true; shift ;;
      -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
      *) echo "unknown argument: $1 (usage: install-kata.sh [--hypervisor clh|qemu] [--yes])" >&2; exit 2 ;;
    esac
  done
  case "$hypervisor" in
    clh|qemu) ;;
    *) echo "--hypervisor must be clh or qemu, not $hypervisor" >&2; exit 2 ;;
  esac

  [ "$(id -u)" = 0 ] || { echo "install-kata: run as root (sudo $0)" >&2; exit 1; }
  if [ ! -e /dev/kvm ]; then
    echo "install-kata: no /dev/kvm on this host. Kata runs each sandbox in a VM and needs KVM: use a dedicated" >&2
    echo "(bare-metal) server, or a VM whose provider enables nested virtualization (KVM inside the VM)." >&2
    exit 1
  fi
  command -v docker >/dev/null || { echo "install-kata: install Docker Engine first" >&2; exit 1; }
  command -v systemctl >/dev/null || { echo "install-kata: needs systemd (systemctl)" >&2; exit 1; }

  local arch
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64) arch=arm64 ;;
    *) echo "install-kata: no Kata static release for $(uname -m)" >&2; exit 1 ;;
  esac

  trap _ki_on_exit EXIT
  _ki_step="installing curl, jq, zstd"
  local missing="" c
  for c in curl jq zstd; do command -v "$c" >/dev/null || missing="$missing $c"; done
  if [ -n "$missing" ]; then
    if command -v apt-get >/dev/null; then
      # shellcheck disable=SC2086 # one word per package
      if ! { apt-get update -qq && apt-get install -y -qq $missing >/dev/null; }; then
        echo "install-kata: apt-get could not install$missing: install them, then run this again" >&2; exit 1
      fi
    else
      echo "install-kata: install$missing first" >&2; exit 1
    fi
  fi

  # Docker's data root while Docker still runs: that is the folder to harden
  local data_root
  data_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
  data_root=${data_root:-/var/lib/docker}
  local dirs=("$data_root" /var/lib/containerd) d unit
  local dropin
  dropin=$(printf '[Unit]\nRequiresMountsFor=%s' "${dirs[*]}")
  local cfg=$KATA_DEFAULTS/runtime-rs/configuration-$hypervisor-runtime-rs.toml

  # The self-bind is not recursive: a separate mount under a folder (Docker's volumes on their own disk, say) would be
  # hidden from Docker until the next reboot, and would keep its own flags (setuid files armed) after it. Refused here,
  # while nothing has changed and Docker still runs
  _ki_step="checking the mounts under ${dirs[*]}"
  local subs s
  for d in "${dirs[@]}"; do
    subs=$(findmnt -rn -o TARGET,FSTYPE 2>/dev/null | kata_submounts "$d" || true)
    [ -n "$subs" ] || continue
    if ! mount_hardened "$d"; then
      echo "install-kata: other filesystems are mounted under $d:" >&2
      # shellcheck disable=SC2086 # findmnt -r escapes blanks: one word per mount point
      printf '  %s\n' $subs >&2
      echo "install-kata: a nosuid,nodev self-bind of $d would hide them from Docker. Add nosuid,nodev to the mount options" >&2
      echo "of $d's own filesystem and of each of these in /etc/fstab, remount them (mount -o remount,nosuid,nodev DIR)," >&2
      echo "then run this again (docs/install.md, \"Docker's volumes on a separate disk\")." >&2
      trap - EXIT
      exit 1
    fi
    for s in $subs; do
      if ! mount_hardened "$s"; then
        echo "install-kata: $s is mounted under $d without nosuid,nodev: a setuid file a Kata sandbox leaves there would" >&2
        echo "run as root on the host. Add nosuid,nodev to its mount options in /etc/fstab, remount it" >&2
        echo "(mount -o remount,nosuid,nodev $s), then run this again." >&2
        trap - EXIT
        exit 1
      fi
    done
  done

  # What needs Docker restarted, worked out before anything changes
  _ki_step="checking what is already in place"
  local shim installed=false
  shim=$(kata_find_shim)
  if [ -n "$shim" ] && "$shim" --version 2>/dev/null | grep -qF "$KATA_VERSION"; then installed=true; fi
  local restart=()
  if ! $installed; then
    restart+=("install Kata $KATA_VERSION")
  else
    local probe
    probe=$(mktemp)
    if [ -f "$cfg" ] && cp "$cfg" "$probe" && kata_edit_config "$probe" >/dev/null 2>&1 && cmp -s "$cfg" "$probe"; then :
    else restart+=("harden $cfg"); fi
    rm -f "$probe"
    if [ ! -s /etc/docker/daemon.json ] || ! jq -e --arg shim "$shim" '.runtimes.kata == {runtimeType: $shim}' /etc/docker/daemon.json >/dev/null 2>&1; then
      restart+=("register the kata runtime in /etc/docker/daemon.json")
    fi
  fi
  for d in "${dirs[@]}"; do
    grep -qxF "$d $d none bind,nosuid,nodev 0 0" /etc/fstab 2>/dev/null || restart+=("add the $d self-bind to /etc/fstab")
    mount_hardened "$d" || restart+=("mount $d nosuid,nodev")
  done
  for unit in docker containerd; do
    [ "$(cat "/etc/systemd/system/$unit.service.d/kata-data-root.conf" 2>/dev/null)" = "$dropin" ] \
      || restart+=("add the RequiresMountsFor drop-in for $unit")
  done
  if [ "${#restart[@]}" -gt 0 ] && ! $yes; then
    local running
    # || true: with Docker stopped (a re-run after a failed start) docker ps fails, and pipefail would end the script
    running=$(docker ps -q 2>/dev/null | wc -l || true)
    if [ "$running" -gt 0 ]; then
      echo "install-kata: Docker has to be restarted to:" >&2
      printf '  - %s\n' "${restart[@]}" >&2
      echo "install-kata: that stops the $running running containers (sandboxes included). Run again with --yes to go ahead." >&2
      trap - EXIT
      exit 1
    fi
  fi

  # 1. The static release (skipped when this version is already in place)
  if $installed; then
    echo "== Kata $KATA_VERSION is already installed"
  else
    _ki_step="downloading Kata $KATA_VERSION"
    echo "== downloading Kata $KATA_VERSION ($arch)"
    _ki_dl=$(mktemp -d)
    curl -fsSL -o "$_ki_dl/kata.tar.zst" \
      "https://github.com/kata-containers/kata-containers/releases/download/$KATA_VERSION/kata-static-$KATA_VERSION-$arch.tar.zst"
    _ki_step="extracting Kata $KATA_VERSION into /opt/kata"
    tar --zstd -xf "$_ki_dl/kata.tar.zst" -C /
    _ki_done+=("extracted Kata $KATA_VERSION into /opt/kata")
    shim=$(kata_find_shim)
  fi
  [ -n "$shim" ] || { echo "install-kata: no runtime-rs containerd-shim-kata-v2 under /opt/kata" >&2; exit 1; }

  # 2. The config, edited in place; Kata 4.3 rejects copies elsewhere, and an /etc copy would shadow the edits
  _ki_step="hardening $cfg"
  [ -f "$cfg" ] || { echo "install-kata: $cfg is not in the release" >&2; exit 1; }
  rm -f /etc/kata-containers/configuration.toml /etc/kata-containers/runtime-rs/configuration.toml
  echo "== $cfg"
  kata_edit_config "$cfg"
  _ki_done+=("hardened $cfg")

  # 3. The default lookup name points at it; 4. the shim where containerd looks for it
  _ki_step="linking the config and the shim"
  ln -sfn "$(basename "$cfg")" "$KATA_DEFAULTS/runtime-rs/configuration.toml"
  ln -sfn "$shim" /usr/local/bin/containerd-shim-kata-v2

  # 5. Docker's runtime "kata" (the rest of daemon.json kept)
  _ki_step="registering the kata runtime in /etc/docker/daemon.json"
  mkdir -p /etc/docker
  [ -s /etc/docker/daemon.json ] || echo '{}' > /etc/docker/daemon.json
  if ! jq -e --arg shim "$shim" '.runtimes.kata == {runtimeType: $shim}' /etc/docker/daemon.json >/dev/null; then
    jq --arg shim "$shim" '.runtimes.kata = {runtimeType: $shim}' /etc/docker/daemon.json > /etc/docker/daemon.json.kata
    chmod --reference=/etc/docker/daemon.json /etc/docker/daemon.json.kata
    mv /etc/docker/daemon.json.kata /etc/docker/daemon.json
    _ki_done+=("registered the kata runtime in /etc/docker/daemon.json")
  fi

  # 6. The vsock and vhost-net devices Kata's VMs use, and /run/kata-containers closed to others, now and after a reboot
  _ki_step="loading vhost_vsock and vhost_net"
  mkdir -p /etc/modules-load.d
  printf 'vhost_vsock\nvhost_net\n' > /etc/modules-load.d/kata.conf
  modprobe vhost_vsock
  modprobe vhost_net
  _ki_step="closing /run/kata-containers to other users"
  kata_private_run_dir

  if [ "${#restart[@]}" -gt 0 ]; then
    # 7. Docker stopped while its data root is remounted
    _ki_step="stopping Docker"
    echo "== stopping Docker"
    _ki_stopped=true
    for unit in docker.socket docker containerd; do
      systemctl stop "$unit" 2>/dev/null || true
    done

    # 8. setuid files and device nodes on the data root are inert on the host (virtiofsd writes as host root): a
    # nosuid,nodev self-bind, not noexec (Docker runs its layers from there)
    _ki_step="adding the self-binds to /etc/fstab"
    local line
    for d in "${dirs[@]}"; do
      mkdir -p "$d"
      line="$d $d none bind,nosuid,nodev 0 0"
      if ! grep -qxF "$line" /etc/fstab; then
        echo "$line" >> /etc/fstab
        _ki_done+=("added to /etc/fstab: $line")
      fi
    done

    # 9. Docker and containerd start only once the self-binds are mounted (at boot too)
    _ki_step="adding the RequiresMountsFor drop-ins"
    for unit in docker containerd; do
      mkdir -p "/etc/systemd/system/$unit.service.d"
      printf '%s\n' "$dropin" > "/etc/systemd/system/$unit.service.d/kata-data-root.conf"
    done
    _ki_done+=("wrote /etc/systemd/system/{docker,containerd}.service.d/kata-data-root.conf")
    systemctl daemon-reload

    # 10. The self-binds now (unless already in place), then Docker again
    for d in "${dirs[@]}"; do
      _ki_step="mounting $d nosuid,nodev"
      if ! mount_hardened "$d"; then
        mount --bind "$d" "$d"
        _ki_done+=("bind-mounted $d onto itself")
        mount -o remount,bind,nosuid,nodev "$d" "$d"
      fi
      mount_hardened "$d" || { echo "install-kata: $d is not mounted nosuid,nodev" >&2; exit 1; }
    done
    _ki_step="starting containerd and Docker"
    echo "== starting Docker"
    systemctl start containerd docker
    _ki_stopped=false
  else
    echo "== Docker's runtime, data root mounts and drop-ins are already in place: Docker keeps running"
  fi
  # Where they exist, volumes and overlay2 must be hardened too (a separate mount keeps its own flags)
  _ki_step="checking that volumes and overlay2 are nosuid,nodev"
  for d in "$data_root/volumes" "$data_root/overlay2"; do
    [ -d "$d" ] || continue
    mount_hardened "$d" || { echo "install-kata: $d is not mounted nosuid,nodev" >&2; exit 1; }
  done
  _ki_step="checking Docker's runtimes"
  docker info --format '{{json .Runtimes}}' | jq -e 'has("kata")' >/dev/null \
    || { echo "install-kata: Docker does not list the kata runtime" >&2; exit 1; }

  # 11. A first Kata container
  _ki_step="the test run (docker run --rm --runtime kata alpine true)"
  echo "== test run"
  timeout 300 docker run --rm --runtime kata alpine true
  echo "Kata $KATA_VERSION ($hypervisor) is installed: Docker runtime \"kata\". Check the host with ./check-host.sh"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
