#!/usr/bin/env bash
# Integration test: a running sandbox on an older foxglove image moves to the runtime's image at Purgatorium's start,
# and its app comes back (on sysbox: the sandbox's dockerd and its data move to a new Docker).
#
# Usage: bash tests/image-migration.sh
#
# Env vars (all optional):
#   P9M_API     - default http://localhost:8081
#   P9M_TOKEN   - default abc123
#   HOST_DOMAIN - default lvh.me
#   TRAEFIK_URL - default http://localhost  (requests are sent here with a Host header)
#   OLD_TAG     - default 0.11.0  (the foxglove version the sandbox is put back on)
#   DEADLINE    - default 180  (seconds for each wait)

set -euo pipefail

P9M_API="${P9M_API:-http://localhost:8081}"
P9M_TOKEN="${P9M_TOKEN:-abc123}"
HOST_DOMAIN="${HOST_DOMAIN:-lvh.me}"
TRAEFIK_URL="${TRAEFIK_URL:-http://localhost}"
OLD_TAG="${OLD_TAG:-0.11.0}"
DEADLINE="${DEADLINE:-180}"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; exit 1; }

NAME="im$(printf '%x' $((RANDOM * RANDOM)) | tail -c 6)"
ECHO_HOST="$NAME-inner-http-echo-port5678.$HOST_DOMAIN"
FULL=""
cleanup() { [ -z "$FULL" ] || curl -sf -X DELETE -H "Authorization: Bearer $P9M_TOKEN" "$P9M_API/sandboxes/$FULL" >/dev/null || true; }
trap cleanup EXIT

# Waits until the command succeeds; $1 says what for
wait_for() {
  local what=$1; shift
  local end=$((SECONDS + DEADLINE))
  until "$@"; do
    [ "$SECONDS" -lt "$end" ] || fail "$what: not within ${DEADLINE}s"
    sleep 3
  done
  pass "$what"
}
app_answers() { curl -s -m 5 -H "Host: $ECHO_HOST" "$TRAEFIK_URL/" | grep -q hello; }
image() { docker inspect -f '{{.Config.Image}}' "$FULL" 2>/dev/null; }
api_up() { curl -sf -o /dev/null -H "Authorization: Bearer $P9M_TOKEN" "$P9M_API/sandboxes"; }
on_old_image() { [[ "$(image)" == *":$OLD_TAG-"* ]]; }
moved() { local i; i=$(image); [[ "$i" == *"/foxglove:"* && "$i" != *":$OLD_TAG-"* ]]; }

FULL=$(curl -sf -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $P9M_TOKEN" \
  -d "{\"name\":\"$NAME\"}" "$P9M_API/sandboxes" | jq -r .name)
[ -n "$FULL" ] && [ "$FULL" != null ] || fail "POST /sandboxes"
NEW_IMAGE=$(image)
wait_for "the app answers on $NEW_IMAGE" app_answers

# As a sandbox made by an older Purgatorium: the same files, the older image
docker compose exec -T p9m sh -c "f=\$(ls -d /opt/sandboxes/*/$FULL)/docker-compose.yml
  sed -i -E 's|(/foxglove:)[0-9.]+-|\1$OLD_TAG-|' \"\$f\" && docker compose -f \"\$f\" up -d --pull missing"
wait_for "the sandbox runs the older image" on_old_image
wait_for "the app answers on the older image" app_answers

docker compose restart p9m
wait_for "Purgatorium is back" api_up
wait_for "the sandbox moved to a newer image" moved
[ "$(image)" = "$NEW_IMAGE" ] || fail "moved to $(image), not $NEW_IMAGE"
wait_for "the app answers after the move" app_answers
docker exec "$FULL" docker ps --format '{{.Names}} {{.Status}}'
docker exec "$FULL" runc --version | head -1
pass "moved from $OLD_TAG to $NEW_IMAGE"
