#!/usr/bin/env bash
# Integration test: scripts/clone-sandbox.mjs copies a sandbox to a new one under another name. The copy has the
# app's data, its volumes' attributes and its own address; the source goes on running; another user's sandbox is not
# copied without its owner's permission.
#
# Usage: bash tests/clone-sandbox.sh   (from the root of the checkout the stack runs from)
#
# Env vars (all optional): P9M_API (http://localhost:8081), P9M_TOKEN (abc123), HOST_DOMAIN (lvh.me),
# TRAEFIK_URL (http://localhost)

set -euo pipefail
P9M_API="${P9M_API:-http://localhost:8081}"
P9M_TOKEN="${P9M_TOKEN:-abc123}"
HOST_DOMAIN="${HOST_DOMAIN:-lvh.me}"
TRAEFIK_URL="${TRAEFIK_URL:-http://localhost}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RESET='\033[0m'
pass() { echo -e "${GREEN}PASS${RESET}: $*"; }
fail() { echo -e "${RED}FAIL${RESET}: $*"; exit 1; }
info() { echo -e "${YELLOW}----${RESET} $*"; }

ID=$(printf '%x' $((RANDOM * RANDOM)) | tail -c 6)
SRC_RAW="cs$ID"; DST_RAW="cd$ID"; OTHER_RAW="co$ID"
MARKER="copied-$RANDOM"
A="Authorization: Bearer $P9M_TOKEN"
clone() { docker compose exec -T p9m node /app/scripts/clone-sandbox.mjs "$@"; }
create() { curl -sf -X POST -H "Content-Type: application/json" -H "$A" -d "$1" "$P9M_API/sandboxes" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4; }
status() { curl -sf -H "$A" "$P9M_API/sandboxes/$1" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4; }
del() { [ -n "${1:-}" ] && curl -sf -X DELETE -H "$A" "$P9M_API/sandboxes/$1" >/dev/null 2>&1 || true; }
fetch() { curl -s -m 10 -H "Host: $1" "$TRAEFIK_URL/" 2>/dev/null || true; }
wait_docker() { for _ in $(seq 1 40); do docker exec "$1" docker info >/dev/null 2>&1 && return; sleep 3; done; fail "$1: its Docker did not start"; }
wait_app() { for _ in $(seq 1 40); do [ "$(fetch "$1")" = "$2" ] && return 0; sleep 3; done; return 1; }

SRC=""; DST=""; OTHER=""; COPY=""
cleanup() {
  info "Cleanup"
  del "$SRC"; del "$OTHER"; del "$DST"
  [ -n "$COPY" ] && docker compose exec -T p9m rm -rf "/app/data/copies/$COPY" || true
}
trap cleanup EXIT

info "A sandbox with an app, a volume and an image whose later layer replaces a folder..."
SRC=$(create "{\"name\":\"$SRC_RAW\",\"create_inner_stack\":false}"); [ -n "$SRC" ] || fail "create"
wait_docker "$SRC"
docker exec "$SRC" docker volume create appdata >/dev/null
docker exec "$SRC" docker run --rm -v appdata:/d alpine sh -c "echo $MARKER > /d/index.html" >/dev/null 2>&1
printf 'FROM alpine\nRUN mkdir /o && touch /o/old\nRUN rm -rf /o && mkdir /o && touch /o/new\n' | docker exec -i "$SRC" docker build -q -t layered - >/dev/null 2>&1 || fail "build"
docker exec "$SRC" docker run -d --restart unless-stopped --name web -l p9m.access=public -p 8080:8080 -v appdata:/www python:3-alpine python3 -m http.server 8080 -d /www >/dev/null 2>&1
docker exec "$SRC" docker volume create claude_secrets >/dev/null
docker exec "$SRC" docker run --rm -v claude_secrets:/d alpine sh -c 'echo secret > /d/key' >/dev/null 2>&1
docker exec "$SRC" sh -c "echo $MARKER > /root/marker"
docker run --rm --cap-add SYS_ADMIN -v "${SRC}_sandbox_srv:/d" alpine sh -c 'apk add -q attr >/dev/null 2>&1; mkdir /d/opaque; setfattr -n trusted.overlay.opaque -v y /d/opaque' || fail "setfattr"
wait_app "$SRC_RAW-web-port8080.$HOST_DOMAIN" "$MARKER" || fail "the source's app never answered"
pass "Source ready"

info "Copying someone else's sandbox..."
OTHER=$(create "{\"name\":\"$OTHER_RAW\",\"create_inner_stack\":false,\"owner\":\"alice@example.com\"}"); [ -n "$OTHER" ] || fail "create for another owner"
set +e; OUT=$(clone pack "$OTHER" 2>&1); CODE=$?; set -e
[ "$CODE" = 3 ] && echo "$OUT" | grep -q "/sandboxes/$OTHER/copy-consent" && pass "Refused without the owner's permission, with the link" || fail "got $CODE: $OUT"
set +e; OUT=$(clone pack "$OTHER" --no-consent 2>&1); CODE=$?; set -e
[ "$CODE" != 0 ] && echo "$OUT" | grep -q reason && pass "--no-consent needs a reason" || fail "got $CODE: $OUT"

info "Packing..."
OUT=$(clone pack "$SRC" 2>&1) || fail "pack: $OUT"
COPY=$(echo "$OUT" | sed -n 's/^Copy made: //p'); [ -n "$COPY" ] || fail "no copy's name in: $OUT"
pass "Packed: $COPY"
[ "$(status "$SRC")" = running ] && pass "The source runs again" || fail "source: $(status "$SRC")"
wait_app "$SRC_RAW-web-port8080.$HOST_DOMAIN" "$MARKER" && pass "The source's app answers again" || fail "the source's app is gone"

info "A damaged copy..."
docker compose exec -T p9m sh -c "cd /app/data/copies/$COPY && cp sandbox_srv.tar.gz /tmp/keep && echo x >> sandbox_srv.tar.gz"
set +e; OUT=$(clone unpack "$COPY" "$DST_RAW" 2>&1); CODE=$?; set -e
docker compose exec -T p9m sh -c "cd /app/data/copies/$COPY && mv /tmp/keep sandbox_srv.tar.gz"
[ "$CODE" != 0 ] && echo "$OUT" | grep -q damaged && pass "A damaged copy is refused" || fail "got $CODE: $OUT"

info "Unpacking under another name..."
OUT=$(clone unpack "$COPY" "$DST_RAW" 2>&1) || fail "unpack: $OUT"
DST=$(echo "$OUT" | sed -n 's/^Made \([^.]*\)\. .*/\1/p'); [ -n "$DST" ] || fail "no name in: $OUT"
[ "$(status "$DST")" != running ] && pass "The copy is left stopped" || fail "the copy runs"
set +e; OUT=$(clone unpack "$COPY" "$DST_RAW" 2>&1); CODE=$?; set -e
[ "$CODE" != 0 ] && pass "A name that exists is not overwritten" || fail "unpacked over an existing sandbox"

curl -sf -X POST -H "$A" "$P9M_API/sandboxes/$DST/start" >/dev/null || fail "start"
wait_docker "$DST"
wait_app "$DST_RAW-web-port8080.$HOST_DOMAIN" "$MARKER" && pass "The app answers at the copy's own address, with its data" || fail "the copy's app never answered: $(fetch "$DST_RAW-web-port8080.$HOST_DOMAIN" | head -c 200)"
[ "$(docker exec "$DST" cat /root/marker)" = "$MARKER" ] && pass "The sandbox's files came too" || fail "/root/marker"
LS=$(docker exec "$DST" docker run --rm layered ls /o); [ "$LS" = new ] && pass "An image built in layers still runs" || fail "/o holds: $LS"
# What an overlay layer's "opaque directory" mark is: a plain tar loses it, and an image's deleted files can come back
XATTR=$(docker run --rm --cap-add SYS_ADMIN -v "${DST}_sandbox_srv:/d" alpine sh -c 'apk add -q attr >/dev/null 2>&1; getfattr --only-values -n trusted.overlay.opaque /d/opaque 2>/dev/null')
[ "$XATTR" = y ] && pass "trusted.* attributes came too" || fail "trusted.overlay.opaque: '$XATTR'"
docker exec "$DST" sh -c 'test ! -e /var/lib/docker/volumes/claude_secrets/_data/key' && pass "The teleported secrets did not come" || fail "claude_secrets was copied"
docker exec "$DST" cat /etc/instance/name | grep -qx "$DST_RAW" && pass "The copy has its own identity" || fail "instance name: $(docker exec "$DST" cat /etc/instance/name)"

echo ""
echo "=== All checks passed ==="
