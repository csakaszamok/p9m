#!/usr/bin/env bash
# Test for scripts/export-restore.sh: what it extracts from an export is the sandbox's, so untrusted. No setuid/setgid
# bit and no device node (other than the 0:0 whiteout) may come back armed, on the host's binds or in the volumes.
# Runs against a stub docker on PATH. Usage: bash tests/export-restore.sh (RESTORE_SH=<file> tests another restore.sh)
set -euo pipefail
cd "$(dirname "$0")/.."
RED='\033[0;31m'; GREEN='\033[0;32m'; RESET='\033[0m'
pass() { echo -e "${GREEN}PASS${RESET}: $*"; }
fail() { echo -e "${RED}FAIL${RESET}: $*"; exit 1; }
repo=$PWD
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

# A stub docker: records each call's arguments, one per line, and swallows its input
mkdir "$tmp/bin"
cat > "$tmp/bin/docker" <<'EOF'
#!/bin/sh
{ echo "--- call"; for a; do printf '%s\n' "$a"; done; } >> "$DOCKER_LOG"
case "$1 ${2:-}" in
  "version "*) echo amd64 ;;
  "volume inspect") exit 1 ;;
  "load "*|"run "*) cat >/dev/null ;;
esac
exit 0
EOF
chmod +x "$tmp/bin/docker"
# A tar that keeps setuid/setgid as root's does by default (-p): a non-root GNU tar drops them on its own, which would
# make the bind checks below pass without the restore's strip
real_tar=$(command -v tar)
printf '#!/bin/sh\nexec "%s" "$@" -p\n' "$real_tar" > "$tmp/bin/tar" && chmod +x "$tmp/bin/tar"

# An export as scripts/export-app.mjs makes it: one bind with a setuid file, one volume
fixture() {
  local e=$1
  mkdir -p "$e/binds" "$e/volumes" "$tmp/src"
  sed 's/^PROJECT=$/PROJECT=shop/' "${RESTORE_SH:-$repo/scripts/export-restore.sh}" > "$e/restore.sh"
  rm -rf "$tmp/src" && mkdir "$tmp/src"
  printf '#!/bin/sh\n' > "$tmp/src/suid" && chmod 4755 "$tmp/src/suid"
  printf 'plain\n' > "$tmp/src/plain" && chmod 2755 "$tmp/src/plain"
  tar czf "$e/binds/web_data.tar.gz" -C "$tmp/src" .
  tar czf "$e/volumes/shop_db.tar.gz" -C "$tmp/src" .
  printf '' | gzip > "$e/images.tar.gz"
  (cd "$e" && sha256sum binds/*.tar.gz volumes/*.tar.gz images.tar.gz > SHA256SUMS)
}

fixture "$tmp/a"
DOCKER_LOG="$tmp/a.log" PATH="$tmp/bin:$PATH" sh "$tmp/a/restore.sh" >/dev/null 2>"$tmp/a.err" || fail "restore: $(cat "$tmp/a.err")"
[ -f "$tmp/a/binds/web_data/suid" ] || fail "the bind was not extracted"
[ "$(stat -c %a "$tmp/a/binds/web_data/suid")" = 755 ] && pass "bind: setuid stripped" || fail "bind: suid is $(stat -c %a "$tmp/a/binds/web_data/suid")"
[ "$(stat -c %a "$tmp/a/binds/web_data/plain")" = 755 ] && pass "bind: setgid stripped" || fail "bind: plain is $(stat -c %a "$tmp/a/binds/web_data/plain")"

# The volume's script: extract, then the same strip and device sweep, inside the container
script=$(awk '/^--- call/{if(c==3)exit; c=0} /^alpine$/{c=1; next} c==1&&/^sh$/{c=2; next} c==2&&/^-c$/{c=3; next} c==3&&/^_$/{exit} c==3{print}' "$tmp/a.log")
echo "$script" | grep -q 'tar xzf - -C /data' || fail "no extract in the volume's script: $script"
echo "$script" | grep -q 'ug-s' && pass "volume: the script strips setuid/setgid" || fail "no ug-s strip in the volume's script: $script"
echo "$script" | grep -q '0:0' && pass "volume: the script drops device nodes other than 0:0" || fail "no device sweep in the volume's script: $script"

# Root, or not: a root user gets the warning, others do not
if [ "$(id -u)" = 0 ]; then
  grep -q 'warning: running as root' "$tmp/a.err" && pass "as root: warned" || fail "as root, no warning: $(cat "$tmp/a.err")"
else
  grep -q 'warning: running as root' "$tmp/a.err" && fail "warned a non-root user" || pass "not root: no warning"
  # As root (a stub id says so)
  printf '#!/bin/sh\n[ "${1:-}" = -u ] && echo 0 || exec /usr/bin/id "$@"\n' > "$tmp/bin/id" && chmod +x "$tmp/bin/id"
  fixture "$tmp/b"
  DOCKER_LOG="$tmp/b.log" PATH="$tmp/bin:$PATH" sh "$tmp/b/restore.sh" >/dev/null 2>"$tmp/b.err" || fail "restore as root: $(cat "$tmp/b.err")"
  grep -q 'warning: running as root; restored files are stripped of setuid/setgid and device nodes' "$tmp/b.err" && pass "as root: warned" || fail "as root, no warning: $(cat "$tmp/b.err")"
fi
