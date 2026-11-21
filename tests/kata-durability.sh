#!/usr/bin/env bash
# Kata durability: a sandbox writes all the time, in two places (its own /srv, and an inner container's volume, in
# docker_data), each file fsynced and committed by a synced manifest line (tests/kata/writer.sh). KILLS times its
# Kata shim is killed with SIGKILL mid-write. Each time: the VM's hypervisor and virtiofsd must go with it, Docker's
# restart policy must bring the sandbox back (no API start: that would hide the defect), its inner Docker and the inner
# writer must run again, and every committed file must be there, intact (tests/kata/verify.sh). Findings listed in
# tests/kata-known-issues.txt are warnings. Diagnostics go to OUT_DIR (an artifact in CI).
#
# On a Kata host with a running stack (DEFAULT_RUNTIME=kata; kata-soak.yml starts one), with docker access and sudo:
#   P9M_TOKEN=… [KILLS=20] [STEP_TIMEOUT=120] [RESTART_WAIT=180] [OUT_DIR=./kata-durability-out] bash tests/kata-durability.sh
set -euo pipefail
: "${P9M_TOKEN:?set P9M_TOKEN to the ADMIN_TOKEN of the stack}"
API=${P9M_API:-http://localhost:8081}
KILLS=${KILLS:-20} STEP_TIMEOUT=${STEP_TIMEOUT:-120} RESTART_WAIT=${RESTART_WAIT:-180}
OUT_DIR=${OUT_DIR:-./kata-durability-out}
mkdir -p "$OUT_DIR"
OUT_DIR=$(cd "$OUT_DIR" && pwd)
export KATA_SEEN=$OUT_DIR/seen.txt
# shellcheck source=tests/kata/lib.sh
. "$(dirname "$0")/kata/lib.sh"
node "$KATA_DIR/report.mjs" validate
: >"$KATA_SEEN"

n=
trap '[ -z "$n" ] || remove_sandbox "$n"' EXIT
finding() { # finding <id> <round> <message>: diagnostics, then a warning if known, else the run ends
  local id=$1 r=$2; shift 2
  diagnose "$n" "r$r-${id#durability.}"
  report "$id" "$*" || exit 1
}

raw="kd$(head -c 2 /dev/urandom | od -An -tx1 | tr -d ' \n')"
n=$(make_sandbox "$raw") || { n=; report durability.create-failed "the sandbox could not be made"; exit 1; }
wait_ready "$n" 600 || finding durability.inner-docker-down 0 "$n is not running with its inner Docker after it was made"
for f in writer.sh verify.sh; do
  timeout 30 docker exec -i "$n" sh -c "mkdir -p /srv/kata && cat > /srv/kata/$f" <"$KATA_DIR/$f"
done
inner_writer() { timeout 300 docker exec "$n" docker run -d --name writer --restart unless-stopped -v durdata:/data -v /srv/kata:/k:ro alpine sh /k/writer.sh /data >/dev/null; }
inner_writer
timeout 30 docker exec -d "$n" sh /srv/kata/writer.sh /srv/dur
echo "durability: $n, $KILLS kills"

# check <round> <where> <verify output>: LOST and CORRUPT lines become findings; sets checked to the committed count
# (in this shell, not a $(...), so an unknown finding ends the run)
check() {
  local r=$1 where=$2 out=$3 line
  while read -r line; do
    case $line in
      LOST*) finding durability.lost-file "$r" "round $r: $where: ${line#LOST } is gone, though it was committed" ;;
      CORRUPT*) finding durability.corrupt-file "$r" "round $r: $where: ${line#CORRUPT* } does not match its checksum" ;;
    esac
  done <<<"$out"
  checked=$(sed -n 's/^OK //p' <<<"$out")
}

for r in $(seq 1 "$KILLS"); do
  wait_s=$(( 10 + (r * 7919) % 21 ))
  sleep "$wait_s"
  id=$(container_id "$n")
  shim=$(vm_pids "$id" "$RE_SHIM" | head -1)
  vm=$(vm_pids "$id" "$RE_HV"; vm_pids "$id" "$RE_FS")
  [ -n "$shim" ] || { finding durability.kill-hang "$r" "round $r: no Kata shim found for $n"; continue; }
  # Without the VM's own processes the orphan check below would check nothing
  if [ -z "$(vm_pids "$id" "$RE_HV")" ] || [ -z "$(vm_pids "$id" "$RE_FS")" ]; then
    finding durability.vm-not-found "$r" "round $r: no hypervisor or virtiofsd found with $n's container ID"; continue
  fi
  t0=$(date +%s)
  sudo kill -9 "$shim" || true
  for _ in $(seq 1 10); do [ -d "/proc/$shim" ] || break; sleep 1; done
  [ ! -d "/proc/$shim" ] || finding durability.kill-hang "$r" "round $r: the shim (pid $shim) is still there 10 s after SIGKILL"

  # The killed VM's own processes (by PID: the restarted VM has the same ID) must go within 30 s
  left_hv='' left_fs=''
  for _ in $(seq 1 30); do
    left_hv='' left_fs=''
    for p in $vm; do
      [ -d "/proc/$p" ] || continue
      case $(ps -o args= -p "$p" | awk '{ n = split($1, a, "/"); print a[n] }') in
        virtiofsd) left_fs="$left_fs $p" ;;
        *) left_hv="$left_hv $p" ;;
      esac
    done
    [ -n "$left_hv$left_fs" ] || break
    sleep 1
  done
  [ -z "$left_hv" ] || finding durability.orphan-hypervisor "$r" "round $r: the killed VM's hypervisor is still running (pid$left_hv)"
  [ -z "$left_fs" ] || finding durability.orphan-virtiofsd "$r" "round $r: the killed VM's virtiofsd is still running (pid$left_fs)"

  # Docker's restart policy, nothing else, brings it back
  back=
  for _ in $(seq 1 "$RESTART_WAIT"); do [ "$(container_status "$n")" = running ] && { back=1; break; }; sleep 1; done
  if [ -z "$back" ]; then
    finding durability.no-restart "$r" "round $r: Docker did not restart $n within ${RESTART_WAIT}s of its shim being killed ($(container_status "$n"))"
    # Known: started through the API so the remaining rounds can run (the finding stands)
    api -X POST "$API/sandboxes/$n/start" >/dev/null || { echo "::error::$n could not be started again"; exit 1; }
  fi
  wait_ready "$n" "$STEP_TIMEOUT" || { finding durability.inner-docker-down "$r" "round $r: $n's inner Docker does not answer after the restart"; continue; }
  restart_s=$(( $(date +%s) - t0 ))

  sb=$(timeout 600 docker exec "$n" sh /srv/kata/verify.sh /srv/dur || true)
  inner=$(timeout 600 docker exec "$n" docker run --rm -v durdata:/data -v /srv/kata:/k:ro alpine sh /k/verify.sh /data || true)
  if [ -z "$sb" ] || [ -z "$inner" ]; then finding durability.inner-docker-down "$r" "round $r: the check could not run in $n (sandbox: [$sb], inner: [$inner])"; fi
  check "$r" "the sandbox's /srv" "$sb"; c_sb=$checked
  check "$r" "the inner volume" "$inner"; c_in=$checked

  running=
  for _ in $(seq 1 60); do
    [ "$(timeout 20 docker exec "$n" docker inspect -f '{{.State.Running}}' writer 2>/dev/null)" = true ] && { running=1; break; }
    sleep 1
  done
  [ -n "$running" ] || { finding durability.writer-not-restarted "$r" "round $r: the inner writer container did not start again"; timeout 30 docker exec "$n" docker rm -f writer >/dev/null 2>&1 || true; inner_writer; }
  timeout 30 docker exec -d "$n" sh /srv/kata/writer.sh /srv/dur
  echo "round $r/$KILLS: killed after ${wait_s}s, back in ${restart_s}s; committed files intact: sandbox ${c_sb:-?}, inner ${c_in:-?}"
done

node "$KATA_DIR/report.mjs" unseen durability
echo "durability: done, $KILLS kills; known findings: $(paste -sd' ' "$KATA_SEEN")"
