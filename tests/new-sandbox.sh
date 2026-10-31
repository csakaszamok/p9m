#!/usr/bin/env bash
# A new sandbox, made as the UI makes it, must come up: running in the list and in its details (not deep_sleep), its
# container not restarting, every bind mount's source there on the host, its app answering.
# Against a running stack (sysbox.yml starts one; locally: docker compose up -d), as root or with docker access.
# Usage: P9M_TOKEN=… [P9M_API=http://localhost:8081] [APP_BASE=http://localhost] bash tests/new-sandbox.sh
set -euo pipefail
RED='\033[0;31m'; GREEN='\033[0;32m'; RESET='\033[0m'
pass() { echo -e "${GREEN}PASS${RESET}: $*"; }
fail() { echo -e "${RED}FAIL${RESET}: $*"; exit 1; }
: "${P9M_TOKEN:?set P9M_TOKEN to the ADMIN_TOKEN of the stack}"
API=${P9M_API:-http://localhost:8081} APP=${APP_BASE:-http://localhost} DOMAIN=${HOST_DOMAIN:-lvh.me}
api() { curl -sf -H "Authorization: Bearer $P9M_TOKEN" -H 'Content-Type: application/json' "$@"; }

raw="ns$(head -c 3 /dev/urandom | od -An -tx1 | tr -d ' \n')"
resp=$(curl -s -m 600 -w '\n%{http_code}' -H "Authorization: Bearer $P9M_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"name\":\"$raw\",\"template\":\"starter\",\"create_inner_stack\":true}" "$API/sandboxes")
code=${resp##*$'\n'} body=${resp%$'\n'*}
full=p9m-$raw
trap 'api -X DELETE "$API/sandboxes/$full" >/dev/null 2>&1 || true' EXIT
[ "$code" = 201 ] || fail "create answered $code: $body"
full=$(jq -r .name <<<"$body")
[ -n "$full" ] && [ "$full" != null ] || fail "create gave no name"
pass "created $full"

# Up, and staying up: a sandbox whose mounts point nowhere restarts every few seconds
sleep 30
restarts=$(docker inspect -f '{{.RestartCount}}' "$full")
[ "$restarts" = 0 ] && pass "the sandbox container has not restarted" || fail "the sandbox container restarted $restarts times: $(docker logs --tail 5 "$full" 2>&1)"
sources=$(docker inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}} {{end}}{{end}}' "$full")
missing=
for src in $sources; do
  test -e "$src" || sudo -n test -e "$src" 2>/dev/null || missing="$missing $src"
done
if [ -z "$missing" ]; then pass "every bind mount source is on the host"; else fail "bind mounts from nowhere:$missing"; fi

list=$(api "$API/sandboxes" | jq -r --arg n "$full" '.[] | select(.name == $n) | .status')
[ "$list" = running ] && pass "the list says running" || fail "the list says [$list]"
detail=$(api "$API/sandboxes/$full" | jq -r .status)
[ "$detail" = running ] && pass "its details say running" || fail "its details say [$detail]"

for i in $(seq 1 40); do
  if curl -sk -L --noproxy "*" -m 5 -H "Host: $raw-inner-http-echo-port5678.$DOMAIN" "$APP/" | grep -q hello; then pass "its app answers"; exit 0; fi
  sleep 3
done
fail "its app never answered"
