#!/bin/sh
# The Kata durability test's check (tests/kata-durability.sh), POSIX sh and busybox: every file <dir>/manifest lists
# must be there with its SHA-256. The last line may be torn (a kill cut its append short, so it was never committed)
# and is skipped if malformed; a malformed line before it is corruption. Prints LOST <file>, CORRUPT <file> or
# CORRUPT-MANIFEST <line> per problem, then OK <files intact>; exits 1 if there was a problem. One sha256sum -c for
# all files: thousands of them are checked in seconds.
# Usage: sh verify.sh <dir>
set -u
d=$1 m=$1/manifest
[ -f "$m" ] || { echo "LOST manifest"; echo "OK 0"; exit 1; }
list=$(mktemp)
trap 'rm -f "$list"' EXIT
# Well-formed lines become sha256sum's check list; a malformed one before the last is reported
awk -v list="$list" '
  { lines[NR] = $0 }
  END {
    for (i = 1; i <= NR; i++) {
      if (lines[i] ~ /^f[0-9]+ [0-9a-f]+$/ && length(substr(lines[i], index(lines[i], " ") + 1)) == 64) {
        split(lines[i], f, " "); print f[2] "  " f[1] > list
      } else if (i < NR) print "CORRUPT-MANIFEST " i
    }
  }' "$m" >"$list.bad"
bad=0
[ ! -s "$list.bad" ] || { cat "$list.bad"; bad=1; }
rm -f "$list.bad"
ok=0
if [ -s "$list" ]; then
  out=$(cd "$d" && sha256sum -c "$list" 2>/dev/null)
  ok=$(printf '%s\n' "$out" | grep -c ': OK$')
  for f in $(printf '%s\n' "$out" | sed -n 's/: FAILED.*$//p'); do
    if [ -f "$d/$f" ]; then echo "CORRUPT $f"; else echo "LOST $f"; fi
    bad=1
  done
fi
echo "OK $ok"
exit $bad
