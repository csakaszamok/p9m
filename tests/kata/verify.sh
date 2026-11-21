#!/bin/sh
# The Kata durability test's check (tests/kata-durability.sh), POSIX sh and busybox: every file <dir>/manifest lists
# must be there with its SHA-256. The last line may be torn (a kill cut its append short, so it was never committed)
# and is skipped if malformed; a malformed line before it is corruption. Prints LOST <file>, CORRUPT <file> or
# CORRUPT-MANIFEST <line> per problem, then OK <files checked>; exits 1 if there was a problem.
# Usage: sh verify.sh <dir>
set -u
d=$1 m=$1/manifest
[ -f "$m" ] || { echo "LOST manifest"; echo "OK 0"; exit 1; }
lines=$(awk 'END { print NR }' "$m")
ln=0 ok=0 bad=0
while IFS= read -r line || [ -n "$line" ]; do
  ln=$((ln + 1))
  if ! echo "$line" | grep -qE '^f[0-9]+ [0-9a-f]{64}$'; then
    [ "$ln" -eq "$lines" ] || { echo "CORRUPT-MANIFEST $ln"; bad=1; }
    continue
  fi
  f=${line%% *} h=${line#* }
  if [ ! -f "$d/$f" ]; then echo "LOST $f"; bad=1
  elif [ "$(sha256sum "$d/$f" | cut -d' ' -f1)" != "$h" ]; then echo "CORRUPT $f"; bad=1
  else ok=$((ok + 1)); fi
done <"$m"
echo "OK $ok"
exit $bad
