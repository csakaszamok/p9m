#!/usr/bin/env bash
# Integration test: a sandbox app's streamed responses reach the client as they are written, through Traefik, the
# Sablier plugin and frp: Server-Sent Events and a plain chunked stream (what an LLM chat reads with fetch), over
# HTTP/1.1 and HTTP/2. A proxy that buffers holds a small event back until about 4 KB have gathered.
#
# Usage: bash tests/app-streaming.sh
#
# Env vars (all optional):
#   P9M_API     - default http://localhost:8081
#   P9M_TOKEN   - default abc123
#   HOST_DOMAIN - default lvh.me
#   TRAEFIK_TLS - default localhost:443

set -euo pipefail

P9M_API="${P9M_API:-http://localhost:8081}"
P9M_TOKEN="${P9M_TOKEN:-abc123}"
HOST_DOMAIN="${HOST_DOMAIN:-lvh.me}"
TRAEFIK_TLS="${TRAEFIK_TLS:-localhost:443}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RESET='\033[0m'
pass() { echo -e "${GREEN}PASS${RESET}: $*"; }
fail() { echo -e "${RED}FAIL${RESET}: $*"; exit 1; }
info() { echo -e "${YELLOW}----${RESET} $*"; }

NAME="st$(printf '%x' $((RANDOM * RANDOM)) | tail -c 6)"
APP_HOST="$NAME-stream-port8090.$HOST_DOMAIN"

read -r -d '' APP <<'PY' || true
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import time
class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def do_GET(self):
        if self.path == "/ready":
            self.send_response(200); self.send_header("Content-Length", "0"); self.end_headers(); return
        sse = self.path == "/events"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream" if sse else "text/plain")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        for i in range(30):
            line = (f"data: {i}\n\n" if sse else f"token {i}\n").encode()
            self.wfile.write(b"%x\r\n%s\r\n" % (len(line), line))
            self.wfile.flush()
            time.sleep(1)
        self.wfile.write(b"0\r\n\r\n")
ThreadingHTTPServer(("0.0.0.0", 8090), H).serve_forever()
PY

curl_app() { curl -sk --noproxy '*' --resolve "$APP_HOST:${TRAEFIK_TLS##*:}:${RESOLVE_IP:-127.0.0.1}" "$@"; }

# Lines a stream delivers within 5 s; the app writes one a second
lines_in_5s() {
  curl_app -N --max-time 5 "$@" 2>/dev/null | grep -c -E '^(data:|token) ' || true
}

info "Creating sandbox $NAME..."
RESPONSE=$(curl -sf -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $P9M_TOKEN" \
  -d "{\"name\":\"$NAME\"}" "$P9M_API/sandboxes") || fail "POST /sandboxes failed"
FULL_NAME=$(echo "$RESPONSE" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$FULL_NAME" ] || fail "Could not parse sandbox name from response"
cleanup() {
  info "Cleanup: deleting $FULL_NAME"
  curl -sf -X DELETE -H "Authorization: Bearer $P9M_TOKEN" "$P9M_API/sandboxes/$FULL_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

info "Starting the streaming app..."
for _ in $(seq 1 40); do
  docker exec "$FULL_NAME" docker info >/dev/null 2>&1 && break; sleep 3
done
docker exec "$FULL_NAME" docker run -d --name stream -p 8090:8090 -l p9m.access=public python:3-alpine python3 -u -c "$APP" >/dev/null \
  || fail "Could not start the app"
for _ in $(seq 1 40); do
  [ "$(curl_app -o /dev/null -m 3 -w '%{http_code}' "https://$APP_HOST:${TRAEFIK_TLS##*:}/ready" || true)" = 200 ] && break; sleep 3
done

url="https://$APP_HOST:${TRAEFIK_TLS##*:}"
check() { # <label> <path> <curl option>
  local n; n=$(lines_in_5s "$3" "$url$2")
  [ "$n" -ge 4 ] && pass "$1: $n lines in 5 s" || fail "$1: only $n lines in 5 s (the response is held back)"
}
check "Server-Sent Events, HTTP/2"   /events --http2
check "Server-Sent Events, HTTP/1.1" /events --http1.1
check "chunked stream, HTTP/2"       /stream --http2
check "chunked stream, HTTP/1.1"     /stream --http1.1

echo ""
echo "=== All checks passed ==="
