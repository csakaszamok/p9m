#!/usr/bin/env bash
# Installs Kata Containers (static release) on this host and registers it with Docker as the runtime "kata", with
# the hardened configuration Purgatorium's Kata sandboxes rely on. Run as root; safe to run again.
#
#   sudo scripts/install-kata.sh [--hypervisor clh|qemu]     # default clh (Cloud Hypervisor)
#   KATA_VERSION=4.3.1 sudo scripts/install-kata.sh          # another Kata release
#
# Needs KVM (/dev/kvm): a dedicated server, or a VM whose provider offers nested virtualization.
# Docker is stopped for a moment: the data root gets a nosuid,nodev self-bind (in /etc/fstab, so it stays).
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
  local bad=""
  grep -qx 'static_sandbox_resource_mgmt = false' "$f" || bad="$bad static_sandbox_resource_mgmt"
  grep -qx 'default_memory = 512' "$f" || bad="$bad default_memory"
  grep -qx 'sandbox_cgroup_only = true' "$f" || bad="$bad sandbox_cgroup_only"
  grep -qF -- "$KATA_VIRTIOFS_ARGS" "$f" || bad="$bad virtio_fs_extra_args"
  [ "$(grep -c -- '--modcaps' "$f")" -eq 1 ] || bad="$bad --modcaps(count)"
  ! grep -E '^enable_annotations\s*=' "$f" | grep -qE '"virtio_fs_(extra_args|daemon)"' || bad="$bad enable_annotations"
  if [ -n "$bad" ]; then
    echo "install-kata: could not set in $f:$bad" >&2
    return 1
  fi
  grep -nE '^\s*(static_sandbox_resource_mgmt|default_memory|sandbox_cgroup_only|virtio_fs_extra_args|enable_annotations)\s*=' "$f"
}

# mount_hardened DIR: DIR's mount has nosuid and nodev
mount_hardened() {
  local opts
  opts=$(findmnt -no OPTIONS --target "$1" 2>/dev/null | tr , '\n')
  grep -qx nosuid <<< "$opts" && grep -qx nodev <<< "$opts"
}

main() {
  local hypervisor=clh
  while [ $# -gt 0 ]; do
    case "$1" in
      --hypervisor) hypervisor=${2:-}; shift 2 || { echo "--hypervisor needs a value: clh or qemu" >&2; exit 2; } ;;
      --hypervisor=*) hypervisor=${1#*=}; shift ;;
      -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
      *) echo "unknown argument: $1 (usage: install-kata.sh [--hypervisor clh|qemu])" >&2; exit 2 ;;
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

  local missing=""
  for c in curl jq zstd; do command -v "$c" >/dev/null || missing="$missing $c"; done
  if [ -n "$missing" ]; then
    if command -v apt-get >/dev/null; then
      # shellcheck disable=SC2086 # one word per package
      apt-get update -qq && apt-get install -y -qq $missing >/dev/null
    else
      echo "install-kata: install$missing first" >&2; exit 1
    fi
  fi

  # Docker's data root before Docker is stopped: that is the folder to harden
  local data_root
  data_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
  data_root=${data_root:-/var/lib/docker}

  # 1. The static release (skipped when this version is already in place)
  local shim
  shim=$(find /opt/kata -path '*runtime-rs*' -name containerd-shim-kata-v2 \( -type f -o -type l \) 2>/dev/null | head -1)
  if [ -n "$shim" ] && "$shim" --version 2>/dev/null | grep -qF "$KATA_VERSION"; then
    echo "== Kata $KATA_VERSION is already installed"
  else
    echo "== downloading Kata $KATA_VERSION ($arch)"
    local dl
    dl=$(mktemp -d)
    # shellcheck disable=SC2064
    trap "rm -rf '$dl'" EXIT
    curl -fsSL -o "$dl/kata.tar.zst" \
      "https://github.com/kata-containers/kata-containers/releases/download/$KATA_VERSION/kata-static-$KATA_VERSION-$arch.tar.zst"
    tar --zstd -xf "$dl/kata.tar.zst" -C /
    shim=$(find /opt/kata -path '*runtime-rs*' -name containerd-shim-kata-v2 \( -type f -o -type l \) | head -1)
  fi
  [ -n "$shim" ] || { echo "install-kata: no runtime-rs containerd-shim-kata-v2 under /opt/kata" >&2; exit 1; }

  # 2. The config, edited in place; Kata 4.3 rejects copies elsewhere, and an /etc copy would shadow the edits
  local cfg=$KATA_DEFAULTS/runtime-rs/configuration-$hypervisor-runtime-rs.toml
  [ -f "$cfg" ] || { echo "install-kata: $cfg is not in the release" >&2; exit 1; }
  rm -f /etc/kata-containers/configuration.toml /etc/kata-containers/runtime-rs/configuration.toml
  echo "== $cfg"
  kata_edit_config "$cfg"

  # 3. The default lookup name points at it; 4. the shim where containerd looks for it
  ln -sfn "$(basename "$cfg")" "$KATA_DEFAULTS/runtime-rs/configuration.toml"
  ln -sfn "$shim" /usr/local/bin/containerd-shim-kata-v2

  # 5. Docker's runtime "kata" (the rest of daemon.json kept)
  mkdir -p /etc/docker
  [ -s /etc/docker/daemon.json ] || echo '{}' > /etc/docker/daemon.json
  jq --arg shim "$shim" '.runtimes.kata = {runtimeType: $shim}' /etc/docker/daemon.json > /etc/docker/daemon.json.kata
  chmod --reference=/etc/docker/daemon.json /etc/docker/daemon.json.kata
  mv /etc/docker/daemon.json.kata /etc/docker/daemon.json

  # 6. The vsock and vhost-net devices Kata's VMs use, now and after a reboot
  printf 'vhost_vsock\nvhost_net\n' > /etc/modules-load.d/kata.conf
  modprobe vhost_vsock
  modprobe vhost_net

  # 7. Docker stopped while its data root is remounted
  echo "== stopping Docker"
  local unit
  for unit in docker.socket docker containerd; do
    systemctl stop "$unit" 2>/dev/null || true
  done

  # 8. setuid files and device nodes on the data root are inert on the host (virtiofsd writes as host root): a
  # nosuid,nodev self-bind, not noexec (Docker runs its layers from there)
  local dirs=("$data_root" /var/lib/containerd) d line
  for d in "${dirs[@]}"; do
    mkdir -p "$d"
    line="$d $d none bind,nosuid,nodev 0 0"
    grep -qxF "$line" /etc/fstab || echo "$line" >> /etc/fstab
  done

  # 9. Docker and containerd start only once the self-binds are mounted (at boot too)
  for unit in docker containerd; do
    mkdir -p "/etc/systemd/system/$unit.service.d"
    printf '[Unit]\nRequiresMountsFor=%s\n' "${dirs[*]}" > "/etc/systemd/system/$unit.service.d/kata-data-root.conf"
  done
  systemctl daemon-reload

  # 10. The self-binds now (unless already in place), then Docker again
  for d in "${dirs[@]}"; do
    if ! mount_hardened "$d"; then
      mount --bind "$d" "$d"
      mount -o remount,bind,nosuid,nodev "$d" "$d"
    fi
    mount_hardened "$d" || { echo "install-kata: $d is not mounted nosuid,nodev" >&2; exit 1; }
  done
  echo "== starting Docker"
  systemctl start containerd docker
  docker info --format '{{json .Runtimes}}' | jq -e 'has("kata")' >/dev/null \
    || { echo "install-kata: Docker does not list the kata runtime" >&2; exit 1; }

  # 11. A first Kata container
  echo "== test run"
  timeout 300 docker run --rm --runtime kata alpine true
  echo "Kata $KATA_VERSION ($hypervisor) is installed: Docker runtime \"kata\". Check the host with ./check-host.sh"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
