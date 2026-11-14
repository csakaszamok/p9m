#!/usr/bin/env bash
# Integration test: DELETE archives a sandbox instead of destroying it.
# Writes a marker into the sandbox's Docker data volume, deletes the sandbox,
# then checks the archive holds the marker, the manifest and the config, and
# that the live sandbox (volume, directory, route) is gone.
#
# Usage: bash tests/archive.sh   (from the repo root, stack running)
#
# Env vars (all optional):
#   P9M_API    - default http://localhost:8081
#   P9M_TOKEN  - default abc123
#   HOST_DOMAIN    - default lvh.me
#   TRAEFIK_URL    - default http://localhost

set -euo pipefail

P9M_API="${P9M_API:-http://localhost:8081}"
P9M_TOKEN="${P9M_TOKEN:-abc123}"
HOST_DOMAIN="${HOST_DOMAIN:-lvh.me}"
TRAEFIK_URL="${TRAEFIK_URL:-http://localhost}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RESET='\033[0m'
pass() { echo -e "${GREEN}PASS${RESET}: $*"; }
fail() { echo -e "${RED}FAIL${RESET}: $*"; exit 1; }
info() { echo -e "${YELLOW}----${RESET} $*"; }

NAME="ar$(printf '%x' $((RANDOM * RANDOM)) | tail -c 6)"
ECHO_HOST="$NAME-inner-http-echo-port5678.$HOST_DOMAIN"
MARKER="archive-test-$RANDOM"

echo ""
echo "=== Archive-on-delete integration test ==="
info "Sandbox name : $NAME"

# ── 1. Create and wait until it serves ────────────────────────────────────────
info "[1/4] Creating sandbox..."
RESPONSE=$(curl -sf -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $P9M_TOKEN" \
  -d "{\"name\":\"$NAME\"}" "$P9M_API/sandboxes") || fail "POST /sandboxes failed"
FULL_NAME=$(echo "$RESPONSE" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$FULL_NAME" ] || fail "Could not parse sandbox name"
for i in $(seq 1 40); do
  [ "$(curl -s -m 5 -H "Host: $ECHO_HOST" "$TRAEFIK_URL/" | head -c 5)" = "hello" ] && break; sleep 3
done
pass "Created and serving: $FULL_NAME"

# ── 2. Put a marker into the sandbox's Docker data volume ─────────────────────
info "[2/4] Writing marker into /var/lib/docker (docker_data volume)..."
docker exec "$FULL_NAME" sh -c "echo $MARKER > /var/lib/docker/p9m-marker"
pass "Marker written: $MARKER"
# What root in a sandbox could plant in its directory (under Kata it is host root there): not archived
SBDIR=$(ls -d opt/sandboxes/*/"$FULL_NAME")
mkfifo "$SBDIR/ssh-host-keys/p9m-fifo"
cp /bin/true "$SBDIR/ssh-host-keys/p9m-suid" && chmod 4755 "$SBDIR/ssh-host-keys/p9m-suid"
pass "Planted a FIFO and a setuid file in ssh-host-keys"

# ── 3. Delete → archive ───────────────────────────────────────────────────────
info "[3/4] DELETE /sandboxes/$FULL_NAME..."
DEL=$(curl -sf -X DELETE -H "Authorization: Bearer $P9M_TOKEN" "$P9M_API/sandboxes/$FULL_NAME") \
  || fail "DELETE failed"
ARCHIVE=$(echo "$DEL" | grep -o '"archive":"[^"]*"' | cut -d'"' -f4)
[ -n "$ARCHIVE" ] || fail "No archive path in response: $DEL"
LOCAL="opt/archive/${ARCHIVE#/opt/archive/}"   # opt/archive/<owner>/<name>-<date>
pass "Archived to $ARCHIVE"

# ── 4. Verify archive contents and that the live sandbox is gone ──────────────
info "[4/4] Checking archive and cleanup..."
[ -f "$LOCAL/manifest.json" ] || fail "manifest.json missing in $LOCAL"
grep -q "\"name\": \"$FULL_NAME\"" "$LOCAL/manifest.json" || fail "manifest does not name $FULL_NAME"
[ -f "$LOCAL/config/docker-compose.yml" ] || fail "config/docker-compose.yml missing"
[ -d "$LOCAL/config/certs" ] || fail "config/certs missing"
TAR="$LOCAL/volumes/${FULL_NAME}_docker_data.tar.gz"
[ -f "$TAR" ] || fail "volume archive missing: $TAR"
[ "$(tar xzOf "$TAR" ./p9m-marker)" = "$MARKER" ] || fail "marker not found in volume archive"
pass "Archive has manifest, config, certs and the volume with the marker ($(du -h "$TAR" | cut -f1))"
[ ! -e "$LOCAL/config/ssh-host-keys" ] || fail "config/ssh-host-keys was archived"
[ "$(stat -c %a "$LOCAL")" = 700 ] || fail "archive dir is mode $(stat -c %a "$LOCAL"), expected 700"
pass "No ssh-host-keys in the archive, which only its owner can read"

docker volume inspect "${FULL_NAME}_docker_data" >/dev/null 2>&1 && fail "volume still exists"
ls -d opt/sandboxes/*/"$FULL_NAME" >/dev/null 2>&1 && fail "opt/sandboxes/*/$FULL_NAME still exists"
[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$FULL_NAME")" ] && fail "containers still exist"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $P9M_TOKEN" "$P9M_API/sandboxes/$FULL_NAME")
[ "$CODE" = "404" ] || fail "GET after archive returned $CODE, expected 404"
CODE=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Host: $ECHO_HOST" "$TRAEFIK_URL/")
[ "$CODE" = "404" ] || fail "sandbox URL returned $CODE, expected 404"
pass "Volume, directory, containers and route are gone"

echo ""
echo "=== All checks passed ==="
