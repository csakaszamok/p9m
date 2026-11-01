#!/usr/bin/env bash
# Integration test: HTTPS with a copied-in wildcard certificate.
# Generates a self-signed *.lvh.me certificate into certs/, restarts the stack
# with PUBLIC_URL=https://p9m.lvh.me and strong secrets, checks redirect,
# login cookie and a sandbox app over HTTPS, then removes the certificate and
# restores plain HTTP.   Usage: bash tests/https.sh   (from the repo root)
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RESET='\033[0m'
pass() { echo -e "${GREEN}PASS${RESET}: $*"; }
fail() { echo -e "${RED}FAIL${RESET}: $*"; exit 1; }
info() { echo -e "${YELLOW}----${RESET} $*"; }

TOKEN="e2e-$(openssl rand -hex 16)"; SECRET=$(openssl rand -hex 32); PW="pw-$(openssl rand -hex 6)"
NAME="hs$(printf '%x' $RANDOM)"; FULL="p9m-$NAME"; TMP=$(mktemp -d)
H="$NAME-inner-http-echo-port5678.lvh.me"

restore() {
  echo ""; info "Restore: archive $FULL, remove certificate, restart on HTTP"
  curl -sk -m 600 -X DELETE -H "Authorization: Bearer $TOKEN" "https://localhost/sandboxes/$FULL" -H "Host: p9m.lvh.me" >/dev/null 2>&1 || true
  rm -f certs/tls.crt certs/tls.key
  docker compose up -d p9m >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap restore EXIT

info "[1/5] Self-signed wildcard certificate for *.lvh.me"
mkdir -p certs
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=*.lvh.me" \
  -addext "subjectAltName=DNS:*.lvh.me,DNS:lvh.me" -keyout certs/tls.key -out certs/tls.crt >/dev/null 2>&1
pass "certs/tls.crt + certs/tls.key"

info "[2/5] Restart p9m with PUBLIC_URL=https://p9m.lvh.me"
PUBLIC_URL=https://p9m.lvh.me ADMIN_TOKEN="$TOKEN" SESSION_SECRET="$SECRET" ADMIN_PASSWORD="$PW" ADMIN_LOGIN=on docker compose up -d p9m traefik >/dev/null
for i in $(seq 1 30); do [ "$(curl -sk -o /dev/null -w '%{http_code}' -H 'Host: p9m.lvh.me' https://localhost/login)" = 200 ] && break; sleep 1; done
[ "$(curl -sk -o /dev/null -w '%{http_code}' -H 'Host: p9m.lvh.me' https://localhost/login)" = 200 ] || fail "https login page not up"
pass "https://p9m.lvh.me/login → 200"

info "[3/5] HTTP redirects to HTTPS"
LOC=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H 'Host: p9m.lvh.me' http://localhost/login)
case "$LOC" in "308 https://p9m.lvh.me/login"|"301 https://p9m.lvh.me/login") pass "redirect: $LOC";; *) fail "no https redirect: $LOC";; esac

info "[4/5] Admin sign-in sets a Secure cookie"
curl -sk -D "$TMP/h" -o /dev/null -H 'Host: p9m.lvh.me' -H 'Origin: https://p9m.lvh.me' \
  --data-urlencode username=admin --data-urlencode "password=$PW" https://localhost/login
grep -i '^set-cookie: __Host-p9m_session=' "$TMP/h" | grep -qi 'secure' || fail "session cookie not Secure: $(grep -i set-cookie "$TMP/h")"
pass "__Host-p9m_session is Secure"

info "[5/5] A new sandbox's app answers over HTTPS"
curl -sk -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'Host: p9m.lvh.me' \
  -d "{\"name\":\"$NAME\"}" https://localhost/sandboxes >/dev/null
for i in $(seq 1 60); do [ "$(curl -sk -m 5 -H "Host: $H" https://localhost/ | head -c 5)" = hello ] && break; sleep 3; done
[ "$(curl -sk -m 5 -H "Host: $H" https://localhost/ | head -c 5)" = hello ] || fail "sandbox app not reachable over https"
pass "https://$H → hello"

echo ""; echo "=== All checks passed ==="
