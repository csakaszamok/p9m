#!/bin/sh
# Runs the soak test (soak.mjs) in a throwaway Node container, so the server needs only Docker. Run it in the
# directory with Purgatorium's .env: SESSION_SECRET comes from there, P9M_URL from its PUBLIC_URL, USER_DOMAIN
# from its OIDC_ALLOWED_DOMAINS. A certificate from an internal CA needs INSECURE=1 (the container does not trust it).
#
#   sh soak.sh [USERS] [SANDBOXES] [MINUTES]        e.g. sh soak.sh 10 3 30
#
# The other settings as environment variables (see soak.mjs): RATE, SLEEP_EVERY, CPUS, MEMORY, USER_DOMAIN,
# MAX_ERRORS, KEEP, INSECURE, P9M_URL, TEMPLATE. soak.mjs and first-sign-in.mjs are taken from next to this script,
# else downloaded (SOAK_REF: the branch or tag, main).
set -eu
USERS=${1:-${USERS:-10}}
SANDBOXES=${2:-${SANDBOXES:-2}}
MINUTES=${3:-${MINUTES:-15}}
export USERS SANDBOXES MINUTES

env_value() { [ -f .env ] && sed -n "s/^$1=//p" .env | tail -1 | tr -d '\r"' || true; }
SESSION_SECRET=${SESSION_SECRET:-$(env_value SESSION_SECRET)}
P9M_URL=${P9M_URL:-$(env_value PUBLIC_URL)}
[ -n "$SESSION_SECRET" ] || { echo "no SESSION_SECRET: run it next to Purgatorium's .env, or set it" >&2; exit 2; }
[ -n "$P9M_URL" ] || { echo "no PUBLIC_URL in .env: set P9M_URL=https://p9m.<domain>" >&2; exit 2; }
export SESSION_SECRET P9M_URL
# The test users' e-mails must pass OIDC_ALLOWED_DOMAINS: its first domain, unless USER_DOMAIN is set
USER_DOMAIN=${USER_DOMAIN:-$(env_value OIDC_ALLOWED_DOMAINS | cut -d, -f1 | tr -d ' ')}
[ -n "$USER_DOMAIN" ] && export USER_DOMAIN || unset USER_DOMAIN

dir=$(cd "$(dirname "$0")" && pwd)
if [ ! -f "$dir/soak.mjs" ] || [ ! -f "$dir/first-sign-in.mjs" ]; then
  dir=$(mktemp -d)
  trap 'rm -rf "$dir"' EXIT
  for f in soak.mjs first-sign-in.mjs; do
    curl -fsSL "https://raw.githubusercontent.com/csakaszamok/p9m/${SOAK_REF:-main}/tests/load/$f" -o "$dir/$f"
  done
fi

# Where the images came from: the sandboxes pull Docker Hub images through Purgatorium's registry-cache, so a second
# run should download nothing. Its size before and after, and the server's own images (foxglove, frps, socat: these
# the server pulls itself, once). Only where docker is at hand (the server); otherwise reported as unknown.
APP_IMAGE=traefik/whoami # the app soak.mjs deploys
project=$(docker ps --filter label=com.docker.compose.service=p9m --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | head -1 || true)
cache=""
[ -n "$project" ] && cache=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=registry-cache 2>/dev/null | head -1 || true)
cache_kb() { docker exec "$cache" du -sk /var/lib/registry 2>/dev/null | cut -f1; }
host_images() { docker images -q --no-trunc 2>/dev/null | sort -u || true; }
if [ -n "$cache" ]; then
  cache_before=$(cache_kb)
  if docker exec "$cache" test -d "/var/lib/registry/docker/registry/v2/repositories/$APP_IMAGE"; then
    echo "images: $APP_IMAGE is in Purgatorium's registry cache already: the sandboxes take it from there, not from the internet"
  else
    echo "images: $APP_IMAGE is not in Purgatorium's registry cache yet: this run downloads it from Docker Hub once"
  fi
fi
# The test's own Node image first, so it is not counted as one the server pulled for Purgatorium
docker image inspect node:22.23.4-alpine >/dev/null 2>&1 || docker pull -q node:22.23.4-alpine >/dev/null
images_before=$(host_images)

# -t only with a terminal (Ctrl+C reaches the test, which then archives its sandboxes); not from cron or a pipe
tty=""; [ -t 0 ] && tty="-t"
trap ':' INT # Ctrl+C is the test's: this script still reports the images after it
status=0
docker run --rm -i $tty --network host --init -v "$dir:/load:ro" \
  -e SESSION_SECRET -e P9M_URL -e USERS -e SANDBOXES -e MINUTES \
  -e RATE -e SLEEP_EVERY -e CPUS -e MEMORY -e USER_DOMAIN -e MAX_ERRORS -e KEEP -e INSECURE -e TEMPLATE \
  node:22.23.4-alpine node /load/soak.mjs || status=$?

echo
if [ -n "$cache" ]; then
  grown=$(( $(cache_kb) - cache_before ))
  if [ "$grown" -le 0 ]; then
    echo "registry cache: nothing downloaded from Docker Hub, every image came from the cache"
  else
    echo "registry cache: $((grown / 1024)) MB downloaded from Docker Hub (cached now: the next run takes it from there)"
  fi
else
  echo "registry cache: not found (run this on the server, as a user who may use docker): the images' source is unknown"
fi
new=$(host_images | grep -vxF "$images_before" || true)
if [ -z "$images_before" ]; then
  echo "server images: unknown (docker is not at hand here)"
elif [ -z "$new" ]; then
  echo "server images: none pulled (foxglove, frps, socat were here already)"
else
  echo "server images: pulled from the internet: $(for id in $new; do docker image inspect -f '{{join .RepoTags ","}}' "$id"; done | tr '\n' ' ')"
fi
exit $status
