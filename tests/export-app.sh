#!/usr/bin/env bash
# Integration test: scripts/export-app.mjs packs a compose project of a sandbox, and restore.sh runs it on a plain
# Docker without Purgatorium: with its data, settings, bind-mounted folder, dependency order and private port.
#
# Usage: bash tests/export-app.sh   (from the root of the checkout the stack runs from)
# Env vars (all optional): P9M_API (http://localhost:8081), P9M_TOKEN (abc123)
set -euo pipefail
P9M_API="${P9M_API:-http://localhost:8081}"
P9M_TOKEN="${P9M_TOKEN:-abc123}"
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RESET='\033[0m'
pass() { echo -e "${GREEN}PASS${RESET}: $*"; }
fail() { echo -e "${RED}FAIL${RESET}: $*"; exit 1; }
info() { echo -e "${YELLOW}----${RESET} $*"; }

ID=$(printf '%x' $((RANDOM * RANDOM)) | tail -c 6); RAW="ex$ID"; TARGET="p9m-export-target-$ID"; MARKER="exported-$RANDOM"
A="Authorization: Bearer $P9M_TOKEN"
exportapp() { docker compose exec -T p9m node /app/scripts/export-app.mjs "$@"; }
SB=""; EXPORT=""
cleanup() {
  info "Cleanup"
  [ -n "$SB" ] && curl -sf -X DELETE -H "$A" "$P9M_API/sandboxes/$SB" >/dev/null 2>&1 || true
  docker rm -f "$TARGET" >/dev/null 2>&1 || true
  [ -n "$EXPORT" ] && docker compose exec -T p9m rm -rf "/app/data/exports/$EXPORT" || true
}
trap cleanup EXIT

info "A sandbox with a compose project..."
SB=$(curl -sf -X POST -H "Content-Type: application/json" -H "$A" -d "{\"name\":\"$RAW\",\"create_inner_stack\":false}" "$P9M_API/sandboxes" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$SB" ] || fail "create"
for _ in $(seq 1 40); do docker exec "$SB" docker info >/dev/null 2>&1 && break; sleep 3; done
docker exec -i "$SB" sh -c 'mkdir -p /root/app/site && cat > /root/app/compose.yaml' <<'YAML'
services:
  web:
    image: python:3-alpine
    command: ["python3", "-m", "http.server", "8080", "-d", "/www"]
    working_dir: /www
    ports: ["8080:8080", "127.0.0.1:8081:8081"]
    restart: unless-stopped
    environment:
      NASTY: 'a$$b"c''d\e f'
      PLAIN: value
    volumes:
      - data:/www
      - ./site:/site:ro
    depends_on:
      prep: { condition: service_completed_successfully }
    labels:
      p9m.access: public
      mine: kept
  prep:
    image: alpine
    command: ["true"]
volumes:
  data:
YAML
docker exec "$SB" sh -c "echo bound-$MARKER > /root/app/site/note"
docker exec "$SB" sh -c 'cd /root/app && docker compose -p shop up -d --quiet-pull' >/dev/null 2>&1 || fail "compose up: $(docker exec "$SB" sh -c 'cd /root/app && docker compose -p shop up -d 2>&1' | tail -3)"
docker exec "$SB" docker run --rm -v shop_data:/d alpine sh -c "echo $MARKER > /d/index.html" >/dev/null 2>&1
pass "Project up"

info "Exporting..."
set +e; OUT=$(exportapp "$SB" nosuch 2>&1); CODE=$?; set -e
[ "$CODE" != 0 ] && echo "$OUT" | grep -q shop && pass "An unknown project is refused, and the real ones named" || fail "got $CODE: $OUT"
OUT=$(exportapp "$SB" shop --stop 2>&1) || fail "export: $OUT"
EXPORT=$(echo "$OUT" | sed -n 's/^Exported: //p'); [ -n "$EXPORT" ] || fail "no name in: $OUT"
pass "Exported: $EXPORT"
[ -n "$(docker exec "$SB" docker ps -q --filter name=shop-web)" ] && pass "The app runs again after --stop" || fail "the app did not start again"
C=$(docker compose exec -T p9m cat "/app/data/exports/$EXPORT/compose.yaml")
echo "$C" | grep -q 'p9m\.' && fail "p9m labels in compose.yaml" || pass "No p9m labels"
echo "$C" | grep -q 'mine: kept' && pass "The app's own labels are kept" || fail "own label lost"
echo "$C" | grep -q 'NASTY\|a\$b' && fail "a setting in compose.yaml" || pass "Settings are not in compose.yaml"

info "Restoring on a plain Docker..."
docker run -d --privileged --name "$TARGET" -e DOCKER_TLS_CERTDIR= docker:29-dind >/dev/null
for _ in $(seq 1 30); do docker exec "$TARGET" docker info >/dev/null 2>&1 && break; sleep 2; done
docker save alpine | docker exec -i "$TARGET" docker load -q >/dev/null
docker compose exec -T p9m tar cf - -C /app/data/exports "$EXPORT" | docker exec -i "$TARGET" tar xf - -C /root
OUT=$(docker exec "$TARGET" sh "/root/$EXPORT/restore.sh" 2>&1) || fail "restore: $OUT"
pass "restore.sh ran"
T() { docker exec "$TARGET" "$@"; }
for _ in $(seq 1 20); do R=$(T wget -qO- -T 3 http://127.0.0.1:8080/ 2>/dev/null || true); [ "$R" = "$MARKER" ] && break; sleep 2; done
[ "$R" = "$MARKER" ] && pass "The app answers with its data" || fail "answer: $R; $(T docker ps -a --format '{{.Names}} {{.Status}}')"
[ "$(T docker exec shop-web-1 cat /site/note)" = "bound-$MARKER" ] && pass "The bind-mounted folder came" || fail "bind"
[ "$(T docker exec shop-web-1 sh -c 'printf %s "$NASTY"')" = 'a$b"c'"'"'d\e f' ] && pass "A setting with quotes, \$ and a backslash is intact" || { printf 'FAIL: NASTY: %s\n' "$(T docker exec shop-web-1 sh -c 'printf %s "$NASTY"')"; exit 1; }
[ "$(T docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' shop-web-1)" = unless-stopped ] && pass "Restart policy kept" || fail "restart"
T docker port shop-web-1 8081 | grep -q '^127.0.0.1:8081' && pass "The private port stays private" || fail "port: $(T docker port shop-web-1 8081)"
T docker ps -a --format '{{.Names}} {{.Status}}' | grep -q 'shop-prep-1 Exited (0)' && pass "The dependency ran first" || fail "prep: $(T docker ps -a --format '{{.Names}} {{.Status}}')"
set +e; OUT=$(T sh "/root/$EXPORT/restore.sh" 2>&1); CODE=$?; set -e
[ "$CODE" != 0 ] && echo "$OUT" | grep -q 'exists already' && pass "A second restore does not overwrite the data" || fail "got $CODE: $OUT"

echo ""
echo "=== All checks passed ==="
