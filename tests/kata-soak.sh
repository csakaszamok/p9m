#!/usr/bin/env bash
# Kata soak: SANDBOXES sandboxes are stopped and started through the API CYCLES times, and the host is sampled after
# every stop and every start (Kata's shims, hypervisors and virtiofsd, mounts, network interfaces and namespaces,
# memory, disk). It fails on a stop or start that hangs or does not come back (Kata runtime-rs #8583 would show here),
# a VM process left behind or missing, slow growth of what the host holds, start times degrading, or a host that does
# not return to its baseline once the sandboxes are deleted (tests/kata/soakRules.mjs). Findings listed in
# tests/kata-known-issues.txt are warnings. Metrics, durations and diagnostics go to OUT_DIR (an artifact in CI).
#
# On a Kata host with a running stack (DEFAULT_RUNTIME=kata; kata-soak.yml starts one), with docker access and sudo:
#   P9M_TOKEN=… [SANDBOXES=6] [CYCLES=200] [STEP_TIMEOUT=120] [OUT_DIR=./kata-soak-out] bash tests/kata-soak.sh
#
# Measured on ubuntu-24.04 runners with Kata 4.3.1, 6 sandboxes and 200 cycles (2026-11-21; clh / qemu): about 2h20 /
# 2h05; a start p50 31 / 28 s, p95 33-36 / 30-31 s (late against early 1.09x / 1.03x, tolerance 2x); a stop p95 6.3 /
# 6.1 s; with the sandboxes stopped the floor of mounts, links and netns flat (stopped samples 44-50, 22-26, 8-10;
# tolerances 10, 4, 2); available memory down 0.7 / 0.5 % (tolerance 10 %); disk use up 37 / 36 MiB, the sandboxes'
# own volumes (tolerance 500 MiB); the host back at its baseline after the delete. One soak.start-recreated (Kata
# #14014) in each run, about once in 1200 starts.
set -euo pipefail
: "${P9M_TOKEN:?set P9M_TOKEN to the ADMIN_TOKEN of the stack}"
API=${P9M_API:-http://localhost:8081}
SANDBOXES=${SANDBOXES:-6} CYCLES=${CYCLES:-200} STEP_TIMEOUT=${STEP_TIMEOUT:-120}
OUT_DIR=${OUT_DIR:-./kata-soak-out}
mkdir -p "$OUT_DIR"
OUT_DIR=$(cd "$OUT_DIR" && pwd)
export METRICS=$OUT_DIR/metrics.csv DURATIONS=$OUT_DIR/durations.csv KATA_SEEN=$OUT_DIR/seen.txt
# shellcheck source=tests/kata/lib.sh
. "$(dirname "$0")/kata/lib.sh"
node "$KATA_DIR/report.mjs" validate
echo "$METRICS_HEADER" >"$METRICS"; echo 'cycle,sandbox,op,ms' >"$DURATIONS"; : >"$KATA_SEEN"
work=$(mktemp -d)

run=$(head -c 2 /dev/urandom | od -An -tx1 | tr -d ' \n')
names=() raws=()
cleanup() { for n in "${names[@]}"; do remove_sandbox "$n"; done; rm -rf "$work"; }
trap cleanup EXIT

# What a failure does: diagnostics, then a known finding is a warning (once per ID) and an unknown one ends the run
declare -A reported=()
finding() { # finding <id> <name or -> <tag> <message>
  local id=$1 n=$2 tag=$3; shift 3
  [ "$n" = - ] || diagnose "$n" "$tag"
  if [ -n "${reported[$id]:-}" ]; then return 0; fi
  reported[$id]=1
  report "$id" "$*" || exit 1
}
# drop <name>: a sandbox that hung or did not come back (a known finding) leaves the run
drop() {
  local n=$1 i keep_n=() keep_r=()
  remove_sandbox "$n"
  for i in "${!names[@]}"; do [ "${names[$i]}" = "$n" ] || { keep_n+=("${names[$i]}"); keep_r+=("${raws[$i]}"); }; done
  names=("${keep_n[@]}") raws=("${keep_r[@]}")
  echo "::warning::$n left the run; $((SANDBOXES - ${#names[@]})) of $SANDBOXES sandboxes lost"
  [ "${#names[@]}" -gt 0 ] || { echo "::error::no sandbox left"; exit 1; }
}

# Images and caches in place before the baseline: one sandbox made and deleted
warm=$(make_sandbox "ksw$run") || { finding soak.create-failed - create "the warm-up sandbox could not be made"; }
[ -z "${warm:-}" ] || { wait_ready "$warm" 600 || true; remove_sandbox "$warm"; }
sleep 10
host_sample 0 baseline 0
disk_snapshot base

for i in $(seq 1 "$SANDBOXES"); do
  raw="ks$run$i"
  n=$(make_sandbox "$raw") || { finding soak.create-failed - create "sandbox $raw could not be made"; continue; }
  names+=("$n") raws+=("$raw")
done
[ "${#names[@]}" -gt 0 ] || { echo "::error::no sandbox could be made"; exit 1; }
for n in "${names[@]}"; do
  wait_ready "$n" 600 || finding soak.start-failed "$n" create "$n is not running with its inner Docker after it was made"
done
echo "soak: ${#names[@]} sandboxes, $CYCLES cycles, step timeout ${STEP_TIMEOUT}s"

# start_again <name> <tag>: after a failed start, what Kata left of that VM in /run/kata, then one more start: whether
# the sandbox can still be woken or stays broken (a stale shim-monitor.sock fails every later start, Kata #14014)
start_again() {
  local n=$1 id
  id=$(container_id "$n" 2>/dev/null || true)
  mkdir -p "$OUT_DIR/diagnostics"
  { echo "=== /run/kata/$id after the failed start"; sudo ls -la "/run/kata/$id" 2>&1; } >"$OUT_DIR/diagnostics/$n-$2-run-kata.txt"
  if api -X POST "$API/sandboxes/$n/start" >/dev/null 2>&1 && wait_ready "$n" "$STEP_TIMEOUT"; then
    echo "a second start worked"
  else echo "a second start failed too"; fi
}

# step <stop|start> <cycle>: every sandbox at once, one result file each (ok, hang, or failed: <why>)
step() {
  local op=$1 c=$2 n
  for n in "${names[@]}"; do
    (
      t0=$(now_ms) id0=$(container_id "$n" 2>/dev/null || true)
      rc=0; api -X POST "$API/sandboxes/$n/$op" >/dev/null 2>"$work/$n.err" || rc=$?
      if [ "$rc" = 28 ]; then echo hang >"$work/$n.res"; exit 0; fi
      if [ "$rc" != 0 ]; then echo "failed: the API answered with an error (curl $rc)" >"$work/$n.res"; exit 0; fi
      if [ "$op" = stop ]; then
        s=$(container_status "$n"); [ "$s" = exited ] || { echo "hang" >"$work/$n.res"; echo "still $s after the stop" >"$work/$n.err"; exit 0; }
      else
        left=$(( STEP_TIMEOUT - ($(now_ms) - t0) / 1000 )); [ "$left" -gt 0 ] || left=1
        wait_ready "$n" "$left" || { echo "failed: not running with its inner Docker within ${STEP_TIMEOUT}s" >"$work/$n.res"; exit 0; }
      fi
      echo "$c,$n,$op,$(( $(now_ms) - t0 ))" >>"$DURATIONS"
      # Started, but as new containers: Purgatorium recreated them after the start failed (a stale Kata socket)
      if [ "$op" = start ] && [ "$(container_id "$n" 2>/dev/null || true)" != "$id0" ]; then echo recreated >"$work/$n.res"; exit 0; fi
      echo ok >"$work/$n.res"
    ) &
  done
  wait
  for n in "${names[@]}"; do
    res=$(cat "$work/$n.res" 2>/dev/null || echo "failed: no result")
    case $res in
      ok) ;;
      recreated) finding soak.start-recreated "$n" "c$c-start" "cycle $c: the start of $n failed and Purgatorium recreated its containers (Kata's shim failed on a socket an earlier VM left, Kata #14014)" ;;
      hang) finding "soak.$op-hang" "$n" "c$c-$op" "cycle $c: $op of $n did not finish within ${STEP_TIMEOUT}s ($(cat "$work/$n.err" 2>/dev/null))"; drop "$n" ;;
      *) if [ "$op" = start ]; then
           again=$(start_again "$n" "c$c")
           finding soak.start-failed "$n" "c$c-start" "cycle $c: $n ${res#failed: }; $again"; drop "$n"
         else finding soak.stop-hang "$n" "c$c-stop" "cycle $c: stop of $n ${res#failed: }"; drop "$n"; fi ;;
    esac
  done
  rm -f "$work"/*.res "$work"/*.err
}

rules() {
  local id msg
  while IFS=$'\t' read -r id msg; do
    [ -n "$id" ] || continue
    if [ -z "${reported[$id]:-}" ]; then
      host_diagnose "${id#soak.}"
      # What grew on disk since the baseline, by directory
      [ "$id" != soak.disk-growth ] || { disk_snapshot disk-growth; disk_growth base disk-growth | tee -a "$OUT_DIR/diagnostics/host-disk-growth.txt"; }
    fi
    finding "$id" - rules "$msg"
  done < <(node "$KATA_DIR/soakRules.mjs" "$METRICS" "$DURATIONS")
}

ms_stats() { # ms_stats <cycle> <op>: p50/max of that cycle's durations, in seconds
  awk -F, -v c="$1" -v op="$2" '$1 == c && $3 == op { print $4 }' "$DURATIONS" | sort -n |
    awk '{ a[NR] = $1 } END { if (NR) printf "%.1f/%.1fs", a[int((NR + 1) / 2)] / 1000, a[NR] / 1000; else printf "-" }'
}

for c in $(seq 1 "$CYCLES"); do
  step stop "$c"
  settled=$(settle_stopped 30)
  if [ "$settled" -ge 30000 ]; then
    # A VM still there 30 s after Docker reported its container exited: what it is, then up to STEP_TIMEOUT more.
    # Gone by then is a slow exit; still there is an orphan, which the stopped sample shows
    host_diagnose "slow-exit-c$c" >/dev/null
    settled=$(( settled + $(settle_stopped "$STEP_TIMEOUT") ))
    [ "$settled" -ge $(( (30 + STEP_TIMEOUT) * 1000 )) ] ||
      finding soak.slow-vm-exit - "c$c" "cycle $c: a Kata VM took $((settled / 1000)) s to go after Docker reported its container exited (diagnostics/host-slow-exit-c$c.txt)"
  fi
  echo "$c,-,settle,$settled" >>"$DURATIONS"
  host_sample "$c" stopped "${#names[@]}"
  step start "$c"
  if [ $((c % 10)) = 0 ]; then
    for i in "${!names[@]}"; do
      app_answers "${raws[$i]}" || finding soak.app-down "${names[$i]}" "c$c-app" "cycle $c: the app in ${names[$i]} does not answer"
    done
  fi
  host_sample "$c" running "${#names[@]}"
  rules
  echo "cycle $c/$CYCLES: stop $(ms_stats "$c" stop), start $(ms_stats "$c" start); running: $(tail -1 "$METRICS" | cut -d, -f3-9)"
done

for n in "${names[@]}"; do remove_sandbox "$n"; done
names=() raws=()
sleep 10
host_sample $((CYCLES + 1)) final 0
disk_snapshot final
disk_growth base final >"$OUT_DIR/diagnostics/disk-final.txt"
rules
node "$KATA_DIR/report.mjs" unseen soak
echo "soak: done, $CYCLES cycles; known findings: $(paste -sd' ' "$KATA_SEEN")"
