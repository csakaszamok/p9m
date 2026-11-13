#!/usr/bin/env bash
# Test for scripts/install-kata.sh: kata_edit_config hardens a Kata config, and a second run changes nothing.
# The real install (root, systemd, KVM) runs in the kata CI workflow.
# Usage: bash tests/install-kata.sh
set -euo pipefail
cd "$(dirname "$0")/.."
RED='\033[0;31m'; GREEN='\033[0;32m'; RESET='\033[0m'
pass() { echo -e "${GREEN}PASS${RESET}: $*"; }
fail() { echo -e "${RED}FAIL${RESET}: $*"; exit 1; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

# shellcheck source=../scripts/install-kata.sh
. scripts/install-kata.sh
pass "sourcing does not run the installer"

# A minimal stand-in for the shipped configuration-clh-runtime-rs.toml
cfg=$tmp/configuration-clh-runtime-rs.toml
cat > "$cfg" <<'EOF'
[hypervisor.cloud-hypervisor]
path = "/opt/kata/bin/cloud-hypervisor"
enable_annotations = ["enable_iommu", "virtio_fs_extra_args"]
default_memory = 2048
virtio_fs_extra_args = ["--thread-pool-size=1", "-o", "announce_submounts"]

[runtime]
#static_sandbox_resource_mgmt = true
sandbox_cgroup_only = false
EOF

kata_edit_config "$cfg" >/dev/null
cp "$cfg" "$tmp/first"
kata_edit_config "$cfg" >/dev/null
cmp -s "$cfg" "$tmp/first" && pass "second run changes nothing" || fail "second run changed the file: $(diff "$tmp/first" "$cfg")"

[ "$(grep -c -- '--modcaps' "$cfg")" -eq 1 ] || fail "--modcaps count: $(grep -c -- '--modcaps' "$cfg")"
grep -q -- '"--modcaps=-mknod:-setfcap"' "$cfg" && pass "one --modcaps=-mknod:-setfcap" || fail "no --modcaps=-mknod:-setfcap"
[ "$(grep -c -- '--xattrmap=:map::user.virtiofs.:' "$cfg")" -eq 1 ] && pass "one --xattrmap" || fail "--xattrmap count"
grep -qx 'virtio_fs_extra_args = \["--xattr", "--xattrmap=:map::user.virtiofs.:", "--modcaps=-mknod:-setfcap", "--thread-pool-size=1", "-o", "announce_submounts"\]' "$cfg" \
  && pass "virtio_fs_extra_args: the three hardening args first, the shipped ones kept" || fail "virtio_fs_extra_args: $(grep '^virtio_fs_extra_args' "$cfg")"
grep -qx 'default_memory = 512' "$cfg" && pass "default_memory = 512" || fail "default_memory"
grep -qx 'static_sandbox_resource_mgmt = false' "$cfg" && pass "static_sandbox_resource_mgmt = false" || fail "static_sandbox_resource_mgmt"
grep -qx 'sandbox_cgroup_only = true' "$cfg" && pass "sandbox_cgroup_only = true" || fail "sandbox_cgroup_only"
grep -qx 'enable_annotations = \["enable_iommu"\]' "$cfg" && pass 'enable_annotations = ["enable_iommu"]' || fail "enable_annotations: $(grep '^enable_annotations' "$cfg")"

# Older hardening args (another --modcaps, a different xattrmap) are replaced, not added to; virtio_fs_daemon goes too
cat > "$cfg" <<'EOF'
[hypervisor.cloud-hypervisor]
enable_annotations = ["virtio_fs_daemon", "enable_iommu", "virtio_fs_extra_args"]
default_memory = 2048
virtio_fs_extra_args = ["--modcaps=+sys_admin", "--xattr", "--thread-pool-size=1", "--xattrmap=:prefix:all::user.x.:"]

[runtime]
sandbox_cgroup_only = true
EOF
kata_edit_config "$cfg" >/dev/null
grep -qx 'virtio_fs_extra_args = \["--xattr", "--xattrmap=:map::user.virtiofs.:", "--modcaps=-mknod:-setfcap", "--thread-pool-size=1"\]' "$cfg" \
  && pass "earlier --xattr, --xattrmap and --modcaps entries replaced" || fail "virtio_fs_extra_args: $(grep '^virtio_fs_extra_args' "$cfg")"
grep -qx 'enable_annotations = \["enable_iommu"\]' "$cfg" && pass "virtio_fs_daemon dropped from enable_annotations" || fail "enable_annotations: $(grep '^enable_annotations' "$cfg")"
# No static_sandbox_resource_mgmt line at all: added under [runtime]
sed -n '/^\[runtime\]/,$p' "$cfg" | grep -qx 'static_sandbox_resource_mgmt = false' && pass "static_sandbox_resource_mgmt added under [runtime]" || fail "static_sandbox_resource_mgmt not added"

# A config the edits cannot complete (no virtio_fs_extra_args) fails instead of passing silently
printf '[hypervisor.cloud-hypervisor]\ndefault_memory = 2048\n[runtime]\nsandbox_cgroup_only = true\n' > "$cfg"
if kata_edit_config "$cfg" >/dev/null 2>&1; then fail "a config without virtio_fs_extra_args must fail"; fi
pass "a config the edits cannot complete fails"
