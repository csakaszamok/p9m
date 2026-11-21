#!/bin/sh
# The Kata durability test's writer (tests/kata-durability.sh): runs in a sandbox and in an inner container, POSIX sh
# and busybox. Writes 1 MiB files of random data into <dir>, each fsynced, then appends "f<n> <sha256>" to
# <dir>/manifest and runs sync: once that sync returns, the file is committed and must survive a killed VM.
# On start it drops a torn or malformed last manifest line (one a kill cut short: never committed), so it can append.
# Usage: sh writer.sh <dir>
set -eu
d=$1 m=$1/manifest
mkdir -p "$d"; touch "$m"
if [ -s "$m" ] && { [ -n "$(tail -c 1 "$m")" ] || ! tail -n 1 "$m" | grep -qE '^f[0-9]+ [0-9a-f]{64}$'; }; then
  sed -i '$d' "$m"; sync
fi
i=$(wc -l <"$m")
while :; do
  i=$((i + 1))
  dd if=/dev/urandom of="$d/f$i" bs=64k count=16 conv=fsync 2>/dev/null
  echo "f$i $(sha256sum "$d/f$i" | cut -d' ' -f1)" >>"$m"
  sync
done
