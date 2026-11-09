#!/bin/sh
# Loads this export into a plain Docker and starts the app (see README.md). scripts/export-app.mjs fills in the two below.
PROJECT=
ARCH=
set -eu
cd "$(dirname "$0")"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c SHA256SUMS >/dev/null || { echo "The files are damaged: copy them over again." >&2; exit 1; }
fi

here=$(docker version --format '{{.Server.Arch}}')
if [ -n "$ARCH" ] && [ "$here" != "$ARCH" ]; then
  echo "Warning: the images are for $ARCH, this Docker is $here: they may not run." >&2
fi
if [ -n "${DOCKER_CONTEXT:-}" ] && [ -n "$(ls -A binds)" ]; then
  echo "This app bind-mounts folders, which a remote Docker cannot see: run this on that machine." >&2
  exit 1
fi

for f in volumes/*.tar.gz; do
  [ -e "$f" ] || continue
  v=$(basename "$f" .tar.gz)
  if docker volume inspect "$v" >/dev/null 2>&1 && [ "${FORCE:-}" != 1 ]; then
    echo "Volume $v exists already. FORCE=1 $0 replaces its contents." >&2
    exit 1
  fi
done

if [ -s WARNINGS.txt ]; then
  echo "Read this before you rely on it:"
  sed 's/^/  - /' WARNINGS.txt
fi

echo "Loading the images..."
gunzip -c images.tar.gz | docker load -q

for f in binds/*.tar.gz; do
  [ -e "$f" ] || continue
  d=binds/$(basename "$f" .tar.gz)
  mkdir -p "$d"
  tar xzf "$f" -C "$d"
done

docker compose -p "$PROJECT" create --pull never

for f in volumes/*.tar.gz; do
  [ -e "$f" ] || continue
  v=$(basename "$f" .tar.gz)
  echo "Loading volume $v..."
  docker run --rm -i --network none -v "$v":/data alpine sh -c 'find /data -mindepth 1 -delete; tar xzf - -C /data' < "$f"
done

docker compose -p "$PROJECT" up -d --pull never
echo
echo "Started. Nothing guards it here: its published ports are open, without HTTPS or a sign-in. See README.md."
