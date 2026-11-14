#!/usr/bin/env bash
# Integration test: one sandbox's apps cannot reach another sandbox's apps.
# Creates sandbox A (no inner stack) and B (starter stack), then from a throwaway
# container inside A tries to reach a port B publishes on 127.0.0.1 only, B's
# inner containers, Sablier, B's frps and socat (where B's published ports, SSH
# and Docker are) and B's sandbox container by name — all must fail, while B's
# tunnel keeps working. Since 0.12.23 a sandbox is on its own network only.
#
# Usage: bash tests/isolation.sh   (stack running)
#
# Env vars (all optional):
#   P9M_API    - default http://localhost:8081
#   P9M_TOKEN  - default abc123
#   HOST_DOMAIN    - default lvh.me
#   TRAEFIK_URL    - default http://localhost (https://localhost with HTTPS on; its certificate is not checked)

set -euo pipefail
export MSYS_NO_PATHCONV=1

P9M_API="${P9M_API:-http://localhost:8081}"
P9M_TOKEN="${P9M_TOKEN:-abc123}"
HOST_DOMAIN="${HOST_DOMAIN:-lvh.me}"
TRAEFIK_URL="${TRAEFIK_URL:-http://localhost}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RESET='\033[0m'
pass() { echo -e "${GREEN}PASS${RESET}: $*"; }
fail() { echo -e "${RED}FAIL${RESET}: $*"; exit 1; }
info() { echo -e "${YELLOW}----${RESET} $*"; }

A="isa$(printf '%x' $((RANDOM * RANDOM)) | tail -c 6)"
B="isb$(printf '%x' $((RANDOM * RANDOM)) | tail -c 6)"
FA="p9m-$A"; FB="p9m-$B"

cleanup() {
  echo ""
  info "Cleanup: archiving $FA and $FB"
  for n in "$FA" "$FB"; do
    curl -sf -m 600 -X DELETE -H "Authorization: Bearer $P9M_TOKEN" "$P9M_API/sandboxes/$n" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

echo ""
echo "=== Sandbox isolation integration test ==="
info "[1/3] Creating $FA (no inner stack) and $FB (with inner stack)..."
curl -sf -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $P9M_TOKEN" -d "{\"name\":\"$A\",\"create_inner_stack\":false}" \
  "$P9M_API/sandboxes" >/dev/null || fail "create $FA failed"
# The starter's app (http-echo on 5678; a create takes no compose text any more). The checks open it without signing
# in: run the stack with APPS_ACCESS_DEFAULT=public (an app's default level is owner since 0.12.12)
curl -sf -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $P9M_TOKEN" -d "{\"name\":\"$B\"}" \
  "$P9M_API/sandboxes" >/dev/null || fail "create $FB failed"
ECHO_HOST="$B-inner-http-echo-port5678.$HOST_DOMAIN"
for i in $(seq 1 40); do
  [ "$(curl -sk -m 5 -H "Host: $ECHO_HOST" "$TRAEFIK_URL/" | head -c 5)" = "hello" ] && break; sleep 3
done
[ "$(curl -sk -m 5 -H "Host: $ECHO_HOST" "$TRAEFIK_URL/" | head -c 5)" = "hello" ] || fail "B's tunnel never served"
pass "Both created; B's app serves through its tunnel"

info "[2/3] Collecting B's addresses..."
# B's container is on no network A could share; its ports are on its frps (traefik-net), its web relay on its socat
[ -z "$(docker inspect -f '{{with index .NetworkSettings.Networks "traefik-net"}}{{.IPAddress}}{{end}}' "$FB")" ] || fail "$FB is on traefik-net"
B_FRPS_IP=$(docker inspect -f '{{(index .NetworkSettings.Networks "traefik-net").IPAddress}}' "$FB-frps")
B_SOCAT_IP=$(docker inspect -f '{{(index .NetworkSettings.Networks "traefik-net").IPAddress}}' "$FB-socat")
B_ECHO_IP=$(docker exec "$FB" docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' http-echo)
SABLIER_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $(docker compose ps -q sablier))
echo "  B frps: $B_FRPS_IP   B socat: $B_SOCAT_IP   B http-echo (inside B): $B_ECHO_IP   Sablier: $SABLIER_IP"

info "[3/3] Probing B and Sablier from an app inside $FA..."
# A port published on 127.0.0.1 only is the sandbox's own
docker exec "$FB" docker run -d --name iso-private -p 127.0.0.1:5681:5678 hashicorp/http-echo -text=private >/dev/null
OUT=$(docker exec "$FA" docker run --rm alpine sh -c "
  sleep 2
  for p in 5678 5681 22 2376 65075 65080; do nc -z -w3 $B_FRPS_IP \$p && echo LEAK:frps-\$p; done
  for p in 8080 7500 5000; do nc -z -w3 $B_SOCAT_IP \$p && echo LEAK:socat-\$p; done
  nc -z -w3 $FB 5678         && echo LEAK:by-name
  nc -z -w3 $B_ECHO_IP 5678  && echo LEAK:inner-private-ip
  nc -z -w3 $SABLIER_IP 10000 && echo LEAK:sablier
  nc -z -w3 sablier 10000    && echo LEAK:sablier-by-name
  echo probed
" 2>&1)
echo "$OUT" | grep -q probed || fail "probe container did not run: $OUT"
LEAKS=$(echo "$OUT" | grep LEAK || true)
[ -z "$LEAKS" ] || fail "reachable from $FA: $(echo "$LEAKS" | tr '
' ' ')"
pass "Nothing of B is reachable from $FA: its published ports, SSH, Docker, frps, socat, inner containers; nor Sablier"

[ "$(curl -sk -m 5 -H "Host: $ECHO_HOST" "$TRAEFIK_URL/" | head -c 5)" = "hello" ] || fail "B's tunnel stopped working"
pass "B's tunnel still serves"

echo ""
echo "=== All checks passed ==="
