# shellcheck shell=bash
# Shared helpers of the Kata soak and durability tests (tests/kata-soak.sh, tests/kata-durability.sh), sourced by
# both. They run on the Kata host itself, next to a running stack (kata-soak.yml starts one), with sudo for the
# journal and Docker's netns directory. Every Docker and API call has a time limit: a dead shim can leave Docker
# hanging, and the test must say so instead of waiting for the job's limit.
#
# Expects: P9M_TOKEN, API (http://localhost:8081), STEP_TIMEOUT (seconds), OUT_DIR; optionally APP_BASE, HOST_DOMAIN.

KATA_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_BASE=${APP_BASE:-http://localhost} HOST_DOMAIN=${HOST_DOMAIN:-lvh.me}

api() { curl -sf -m "$STEP_TIMEOUT" -H "Authorization: Bearer $P9M_TOKEN" -H 'Content-Type: application/json' "$@"; }

now_ms() { date +%s%3N; }

# report <id> <message...>: 0 when the finding is on tests/kata-known-issues.txt (a warning), 1 when it fails the run
report() { node "$KATA_DIR/report.mjs" fail "$@"; }

# make_sandbox <raw name>: prints the full name. Small, never asleep, the starter template's app inside
make_sandbox() {
  local raw=$1 resp code body
  resp=$(curl -s -m 600 -w '\n%{http_code}' -H "Authorization: Bearer $P9M_TOKEN" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$raw\",\"template\":\"starter\",\"create_inner_stack\":true,\"idle_timeout\":\"off\",\"deep_sleep_after\":\"off\",\"cpus\":${CPUS:-0.5},\"memory\":\"${MEMORY:-512m}\"}" \
    "$API/sandboxes") || true
  code=${resp##*$'\n'} body=${resp%$'\n'*}
  [ "$code" = 201 ] || { echo "create $raw answered [$code]: $body" >&2; return 1; }
  jq -r .name <<<"$body"
}

# remove_sandbox <name>: through the API, then whatever Docker still has of it
remove_sandbox() {
  local n=$1
  api -m 300 -X DELETE "$API/sandboxes/$n" >/dev/null 2>&1 || true
  local ids=()
  mapfile -t ids < <(timeout 30 docker ps -aq --filter "name=^$n(-dns|-frps|-socat)?\$" 2>/dev/null || true)
  [ "${#ids[@]}" = 0 ] || timeout 60 docker rm -f "${ids[@]}" >/dev/null 2>&1 || true
}

container_id() { timeout 30 docker inspect -f '{{.Id}}' "$1"; }
container_status() { timeout 30 docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null || echo unknown; }

# The programs of every process: the base name of argv[0] and the rest of the command line
_procs() { ps -eo args= | awk '{ n = split($1, a, "/"); $1 = a[n]; print }'; }
_count() { local re=$1; awk -v re="$re" '{ split($0, f, " "); if (f[1] ~ re) c++ } END { print c + 0 }'; }
RE_SHIM='^containerd-shim-kata-v2$' RE_HV='^(cloud-hypervisor|qemu-system-.*)$' RE_FS='^virtiofsd$'

# vm_procs <container id>: "shims hypervisors virtiofsd" of that one VM (Kata names its VM after the container ID)
vm_procs() {
  local all; all=$(_procs | grep -F -- "$1" || true)
  echo "$(_count "$RE_SHIM" <<<"$all") $(_count "$RE_HV" <<<"$all") $(_count "$RE_FS" <<<"$all")"
}

# vm_pids <container id> <regex>: the PIDs of that VM's processes whose program matches
vm_pids() {
  ps -eo pid=,args= | awk -v id="$1" -v re="$2" 'index($0, id) { n = split($2, a, "/"); if (a[n] ~ re) print $1 }'
}

# shellcheck disable=SC2034 # used by kata-soak.sh
METRICS_HEADER='cycle,phase,sandboxes,shims,hypervisors,virtiofsd,mounts,links,netns,mem_avail_kb,disk_used_kb,netns_files'
DOCKER_ROOT=

# The network namespaces the kernel holds: those a process is in, and those kept by an nsfs bind mount (Docker's
# /var/run/docker/netns, ip netns), each counted once by its inode
net_namespaces() {
  {
    sudo find /proc/[0-9]*/ns/net -maxdepth 0 -printf '%l\n' 2>/dev/null | sed -n 's/^net:\[\([0-9]*\)\]$/\1/p'
    awk '$3 == "nsfs" { print $2 }' /proc/mounts | while read -r p; do sudo stat -L -c %i "$p" 2>/dev/null; done
  } | sort -u | wc -l
}

# The files under Docker's and ip's netns directories (a file whose namespace is gone counts here, not above)
netns_files() { echo $(( $(sudo ls /var/run/netns 2>/dev/null | wc -l) + $(sudo ls /var/run/docker/netns 2>/dev/null | wc -l) )); }

# host_sample <cycle> <phase> <sandboxes>: one row of $METRICS, host-wide
host_sample() {
  [ -n "$DOCKER_ROOT" ] || DOCKER_ROOT=$(timeout 30 docker info -f '{{.DockerRootDir}}')
  local all; all=$(_procs)
  echo "$1,$2,$3,$(_count "$RE_SHIM" <<<"$all"),$(_count "$RE_HV" <<<"$all"),$(_count "$RE_FS" <<<"$all"),$(wc -l </proc/mounts),$(ip -o link 2>/dev/null | wc -l),$(net_namespaces),$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo),$(df -k --output=used "$DOCKER_ROOT" | tail -1 | tr -d ' '),$(netns_files)" >>"$METRICS"
}

# host_diagnose <tag>: the host's namespaces, nsfs mounts, netns files and links, when a host-wide rule fails
host_diagnose() {
  mkdir -p "$OUT_DIR/diagnostics"
  {
    echo "=== host ($1)"
    echo "--- lsns -t net"; sudo lsns -t net 2>&1 || true
    echo "--- nsfs mounts"; awk '$3 == "nsfs"' /proc/mounts
    echo "--- /var/run/docker/netns"; sudo ls -la /var/run/docker/netns 2>&1 || true
    echo "--- /var/run/netns"; sudo ls -la /var/run/netns 2>&1 | tail -40 || true
    echo "--- ip -d link"; ip -d link 2>&1 | tail -150
  } 2>&1 | tee "$OUT_DIR/diagnostics/host-$1.txt"
}

# settle_stopped <seconds>: wait until no Kata process is left on the host (a VM may still be shutting down when
# Docker already reports its container exited); prints how long it took, in ms. A process still there afterwards
# is an orphan, and the next sample shows it
settle_stopped() {
  local t0; t0=$(now_ms)
  local until=$(( $(date +%s) + $1 )) all
  while [ "$(date +%s)" -lt "$until" ]; do
    all=$(_procs)
    [ "$(_count "$RE_SHIM" <<<"$all")$(_count "$RE_HV" <<<"$all")$(_count "$RE_FS" <<<"$all")" = 000 ] && break
    sleep 1
  done
  echo $(( $(now_ms) - t0 ))
}

# wait_ready <name> <seconds>: running, and its inner dockerd answers
wait_ready() {
  local n=$1 until=$(( $(date +%s) + $2 ))
  while [ "$(date +%s)" -lt "$until" ]; do
    [ "$(container_status "$n")" = running ] && timeout 20 docker exec "$n" docker info >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# app_answers <raw name>: the starter app says hello within a minute
app_answers() {
  local _
  for _ in $(seq 1 12); do
    curl -sk -L --noproxy '*' -m 5 -H "Host: $1-inner-http-echo-port5678.$HOST_DOMAIN" "$APP_BASE/" 2>/dev/null | grep -q hello && return 0
    sleep 5
  done
  return 1
}

# diagnose <name> <tag>: what is left of that sandbox's VM and what Docker and containerd said, to stdout and a file
diagnose() {
  local n=$1 tag=$2 id
  mkdir -p "$OUT_DIR/diagnostics"
  id=$(container_id "$n" 2>/dev/null || true)
  {
    echo "=== $n ($tag), container ${id:-unknown}"
    [ -z "$id" ] || { echo "--- its VM's processes"; pgrep -af -- "$id" || true; }
    echo "--- docker ps"; timeout 30 docker ps -a --filter "name=$n" || echo "(docker ps did not answer)"
    echo "--- docker inspect"; timeout 30 docker inspect "$n" || echo "(docker inspect did not answer)"
    echo "--- inner containers"; timeout 30 docker exec "$n" docker ps -a 2>&1 || echo "(the inner Docker did not answer)"
    # shellcheck disable=SC2016 # $FRPS_API_AUTH expands inside the socat container
    echo "--- frps proxies"; timeout 20 docker exec "$n-socat" sh -c 'for t in http tcp stcp; do wget -qO- "http://$FRPS_API_AUTH@127.0.0.1:7500/api/proxy/$t"; echo; done' 2>&1 || true
    echo "--- containerd and docker journal"; sudo journalctl -u containerd -u docker --no-pager 2>/dev/null | tail -200
  } 2>&1 | tee "$OUT_DIR/diagnostics/$n-$tag.txt"
}
