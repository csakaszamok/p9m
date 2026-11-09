#!/bin/sh
# p9m-init: puts this release's files where the other services read them (Sablier themes, Traefik's Sablier plugin, registry config,
# Traefik's error-page middleware). Runs on every `docker compose up`, so they always
# match the image; a file dropped from a release is removed.
set -eu
SRC=${ASSETS_SRC:-/app/assets}
OUT=${ASSETS_OUT:-/out}
DIRS="sablier-themes sablier-plugin registry"

# Everything there first: a failing run must leave what the services read as it is
for d in $DIRS; do
  [ -d "$SRC/$d" ] || { echo "[p9m-init] missing $SRC/$d" >&2; exit 1; }
done
for f in registry/config.yml traefik/errors.yml; do
  [ -f "$SRC/$f" ] || { echo "[p9m-init] missing $SRC/$f" >&2; exit 1; }
done

# Each file under a temporary name, then renamed over the old one: Sablier and the registry never see a file
# missing or half written. Then whatever this release no longer has goes.
for d in $DIRS; do
  mkdir -p "$OUT/$d"
  # Dot files too: Traefik needs the plugin's .traefik.yml
  for f in "$SRC/$d"/* "$SRC/$d"/.[!.]*; do
    [ -f "$f" ] || continue
    name=${f##*/}
    cp "$f" "$OUT/$d/.$name.tmp"
    mv "$OUT/$d/.$name.tmp" "$OUT/$d/$name"
  done
  for f in "$OUT/$d"/* "$OUT/$d"/.[!.]*; do
    [ -e "$f" ] || continue
    [ -e "$SRC/$d/${f##*/}" ] || rm -rf "$f"
  done
done

# Traefik watches dynamic/: same rename. Only errors.yml: tls.yml and the sandboxes' files there are Purgatorium's.
mkdir -p "$OUT/dynamic"
cp "$SRC/traefik/errors.yml" "$OUT/dynamic/.errors.yml.tmp"
mv "$OUT/dynamic/.errors.yml.tmp" "$OUT/dynamic/errors.yml"
echo "[p9m-init] assets installed"
