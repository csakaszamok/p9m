#!/usr/bin/env bash
# The UI in a real browser (tests/browser/*.mjs, Playwright's image), against a running stack. The browser runs in a
# container of its own on traefik-net: on the Docker host itself, every network a new sandbox makes would abort its
# requests (net::ERR_NETWORK_CHANGED).
# Usage: P9M_TOKEN=… P9M_PASSWORD=… (ADMIN_LOGIN=on) [P9M_UI=http://p9m.lvh.me] [P9M_API=http://localhost:8081] bash tests/browser.sh
set -euo pipefail
: "${P9M_TOKEN:?set P9M_TOKEN to the ADMIN_TOKEN of the stack}"
: "${P9M_PASSWORD:?set P9M_PASSWORD to the ADMIN_PASSWORD of the stack}"
API=${P9M_API:-http://localhost:8081}
PLAYWRIGHT=1.64.1
here=$(cd "$(dirname "$0")" && pwd)
traefik=$(docker ps -q --filter label=com.docker.compose.service=traefik | head -n 1)
[ -n "$traefik" ] || { echo "FAIL: no traefik container: start the stack first"; exit 1; }
ip=$(docker inspect -f '{{with index .NetworkSettings.Networks "traefik-net"}}{{.IPAddress}}{{end}}' "$traefik")
out=$(mktemp)
cleanup() {
  name=$(sed -n 's/^created //p' "$out" | head -n 1)
  [ -n "$name" ] && curl -sf -X DELETE -H "Authorization: Bearer $P9M_TOKEN" "$API/sandboxes/p9m-$name" >/dev/null 2>&1 || true
  rm -f "$out"
}
trap cleanup EXIT
status=0
docker run --rm --network traefik-net -e P9M_UI="${P9M_UI:-http://p9m.lvh.me}" -e P9M_PASSWORD -e TARGET_IP="$ip" \
  -v "$here/browser:/tests:ro" "mcr.microsoft.com/playwright:v$PLAYWRIGHT-noble" \
  sh -c "mkdir /run/t && cd /run/t && npm i --silent --no-save --no-audit --no-fund playwright@$PLAYWRIGHT >/dev/null && cp /tests/*.mjs . && for t in *.mjs; do node \$t || exit 1; done" \
  | tee "$out" || status=$?
exit $status
