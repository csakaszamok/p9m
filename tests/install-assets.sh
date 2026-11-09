#!/usr/bin/env bash
# Unit test for scripts/install-assets.sh (what p9m-init runs): copies the release's assets, replaces what was
# there, writes dynamic/errors.yml atomically and leaves the rest of dynamic/ alone.
# Usage: bash tests/install-assets.sh
set -euo pipefail
cd "$(dirname "$0")/.."
RED='\033[0;31m'; GREEN='\033[0;32m'; RESET='\033[0m'
pass() { echo -e "${GREEN}PASS${RESET}: $*"; }
fail() { echo -e "${RED}FAIL${RESET}: $*"; exit 1; }

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
src=$tmp/src out=$tmp/out
mkdir -p "$src"
cp -R sablier-themes sablier-plugin registry traefik "$src/"
mkdir -p "$out/sablier-themes" "$out/dynamic"
echo old > "$out/sablier-themes/removed-theme.html"
echo keep > "$out/dynamic/tls.yml"
echo keep > "$out/dynamic/sandbox-p9m-a.yml"

ASSETS_SRC=$src ASSETS_OUT=$out sh scripts/install-assets.sh >/dev/null || fail "exit code $?"

[ -f "$out/sablier-themes/p9m.html" ] && pass "themes copied" || fail "themes not copied"
[ ! -e "$out/sablier-themes/removed-theme.html" ] && pass "a theme no longer released is gone" || fail "old theme lingers"
cmp -s sablier-plugin/main.go "$out/sablier-plugin/main.go" && cmp -s sablier-plugin/.traefik.yml "$out/sablier-plugin/.traefik.yml" && pass "Sablier plugin copied, with its dot file" || fail "Sablier plugin"
cmp -s registry/config.yml "$out/registry/config.yml" && pass "registry config copied" || fail "registry config"
cmp -s traefik/errors.yml "$out/dynamic/errors.yml" && pass "dynamic/errors.yml written" || fail "errors.yml"
[ "$(cat "$out/dynamic/tls.yml")" = keep ] && [ "$(cat "$out/dynamic/sandbox-p9m-a.yml")" = keep ] && pass "rest of dynamic/ untouched" || fail "dynamic/ touched"
[ -z "$(ls -A "$out/dynamic" | grep -v -e '^errors.yml$' -e '^tls.yml$' -e '^sandbox-p9m-a.yml$')" ] && pass "no temporary file left" || fail "leftovers in dynamic/"

rm "$src/registry/config.yml"
if ASSETS_SRC=$src ASSETS_OUT=$out sh scripts/install-assets.sh >/dev/null 2>&1; then fail "a missing asset must fail"; else pass "a missing asset fails"; fi

# A failing run (a release without one of its files) leaves what is there as it is: nothing emptied half way
fresh=$tmp/fresh; mkdir -p "$fresh"; cp -R sablier-themes sablier-plugin registry traefik "$fresh/"
ASSETS_SRC=$fresh ASSETS_OUT=$out sh scripts/install-assets.sh >/dev/null
rm "$fresh/registry/config.yml"
ASSETS_SRC=$fresh ASSETS_OUT=$out sh scripts/install-assets.sh >/dev/null 2>&1 || true
[ -f "$out/sablier-themes/p9m.html" ] && [ -f "$out/registry/config.yml" ] \
  && pass "a failing run leaves every volume as it was" || fail "a failing run emptied something: $(ls "$out"/*)"

