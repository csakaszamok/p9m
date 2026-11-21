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
  local ids; ids=$(timeout 30 docker ps -aq --filter "name=^$n(-dns|-frps|-socat)?\$" 2>/dev/null || true)
  [ -z "$ids" ] || timeout 60 docker rm -f $ids >/dev/null 2>&1 || true
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

METRICS_HEADER='cycle,phase,sandboxes,shims,hypervisors,virtiofsd,mounts,links,netns,mem_avail_kb,disk_used_kb'
DOCKER_ROOT=

# host_sample <cycle> <phase> <sandboxes>: one row of $METRICS, host-wide
host_sample() {
  [ -n "$DOCKER_ROOT" ] || DOCKER_ROOT=$(timeout 30 docker info -f '{{.DockerRootDir}}')
  local all; all=$(_procs)
  local netns=$(( $(ip netns list 2>/dev/null | wc -l) + $(sudo ls /var/run/docker/netns 2>/dev/null | wc -l) ))
  echo "$1,$2,$3,$(_count "$RE_SHIM" <<<"$all"),$(_count "$RE_HV" <<<"$all"),$(_count "$RE_FS" <<<"$all"),$(wc -l </proc/mounts),$(ip -o link | wc -l),$netns,$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo),$(df -k --output=used "$DOCKER_ROOT" | tail -1 | tr -d ' ')" >>"$METRICS"
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
  local i
  for i in $(seq 1 12); do
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
    [ -z "$id" ] || { echo "--- its VM's processes"; ps -eo pid,etimes,args | grep -F -- "$id" | grep -v grep || true; }
    echo "--- docker ps"; timeout 30 docker ps -a --filter "name=$n" || echo "(docker ps did not answer)"
    echo "--- docker inspect"; timeout 30 docker inspect "$n" || echo "(docker inspect did not answer)"
    echo "--- containerd and docker journal"; sudo journalctl -u containerd -u docker --no-pager 2>/dev/null | tail -200
  } 2>&1 | tee "$OUT_DIR/diagnostics/$n-$tag.txt"
}
