#!/usr/bin/env bash
# Prepares the current directory for a first start: creates .env (from the release's env.example) if there
# is none, replaces the example secrets with random ones and creates the data directories. Safe to run
# again: values you already set are kept.
#
#   curl -fsSL https://github.com/csakaszamok/p9m/releases/latest/download/setup.sh | bash -s -- dev.example.com
#
# The domain (optional) becomes HOST_DOMAIN: every address is under it (the UI is p9m.<domain>, or UI_HOST).
set -euo pipefail

# Set in the release asset (e.g. v0.5.0); empty in a checkout, which uses its own .env.example
P9M_RELEASE=
P9M_RELEASE_BASE=${P9M_RELEASE_BASE:-https://github.com/csakaszamok/p9m/releases/download}

command -v docker >/dev/null || { echo "docker is not installed" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "the docker compose plugin is not installed" >&2; exit 1; }

if [ ! -f .env ]; then
  if [ -n "$P9M_RELEASE" ]; then
    curl -fsSL "$P9M_RELEASE_BASE/$P9M_RELEASE/env.example" -o .env.tmp       || { rm -f .env.tmp; echo "could not download env.example of $P9M_RELEASE" >&2; exit 1; }
    mv .env.tmp .env
  else
    cp "$(dirname "$0")/.env.example" .env
  fi
  echo "Created .env"
fi

# It holds the secrets: readable by its owner only
chmod 600 .env

mkdir -p data opt/sandboxes opt/archive certs dynamic

# random BYTES: that many random bytes as hex
random() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# get KEY: the value of KEY in .env (empty if missing)
get() { sed -n "s/^$1=//p" .env | tail -1; }

# set KEY VALUE: replace KEY's line in .env, or append it
set_value() {
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

# size_mb SIZE: 4g, 512m, 1024k → megabytes
size_mb() { awk -v s="$1" 'BEGIN { n = s + 0; u = tolower(substr(s, length(s))); print int(u == "g" ? n * 1024 : u == "m" ? n : u == "k" ? n / 1024 : n / 1048576) }'; }
# suggest CPUS MEMORY_MB DISK_GB PER_CPUS PER_MEMORY_MB PER_DISK_MB [OVERHEAD_MB] → "suggested ideal bottleneck" (DISK_GB empty: unknown).
# OVERHEAD_MB: what each sandbox takes beyond its limit (200 with Kata: the VM around it).
# As services/capacity.ts: how many can use their full CPU and memory at once (2 GB kept for the rest),
# twice that (most idle or sleep), at most as many as the disk holds at SANDBOX_DISK each.
suggest() {
  awk -v c="$1" -v m="$2" -v d="$3" -v pc="$4" -v pm="$5" -v pd="$6" -v oh="${7:-0}" 'BEGIN {
    cpu = pc > 0 ? int(c / pc) : 0; mem = pm > 0 ? int((m - 2048) / (pm + oh)) : 0; if (mem < 0) mem = 0
    ideal = cpu < mem ? cpu : mem; if (ideal < 1) ideal = 1
    s = ideal * 2; by = cpu <= mem ? "CPU" : "memory"
    if (d != "" && pd > 0) { disk = int(d * 1024 / pd); if (disk < s) { s = disk; by = "disk" } }
    if (s < 1) s = 1
    print s, ideal, by }'
}

generated=()
fill_secret() { # KEY BYTES placeholder...: set KEY to a random value if it is empty or a placeholder
  local key=$1 bytes=$2; shift 2
  local current
  current=$(get "$key")
  for placeholder in "" "$@"; do
    if [ "$current" = "$placeholder" ]; then
      set_value "$key" "$(random "$bytes")"
      generated+=("$key")
      return
    fi
  done
}

fill_secret ADMIN_TOKEN 32 change-me-to-a-strong-secret abc123
fill_secret SESSION_SECRET 32 change-me-to-a-long-random-string
fill_secret ADMIN_PASSWORD 12 change-me

if [ "$(get HOST_ADDRESS)" = "192.168.1.100" ]; then
  address=$(hostname -I 2>/dev/null | awk '{print $1}' || true)  # no -I (macOS, busybox): localhost
  set_value HOST_ADDRESS "${address:-localhost}"
fi

# SANDBOX_MAX_TOTAL: the example's 200 becomes the number suggested for this host; one of your own stays.
# P9M_HOST_*: the host's size, for the tests.
case "$(get SANDBOX_MAX_TOTAL)" in
  ""|200)
    host_mb=${P9M_HOST_MEMORY_MB:-$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo 2>/dev/null || true)}
    if [ -n "$host_mb" ]; then
      docker_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
      host_disk=${P9M_HOST_DISK_GB-$(df -BG --output=avail "${docker_root:-/nonexistent}" 2>/dev/null | tail -1 | tr -dc 0-9 || true)}
      per_cpus=$(get SANDBOX_CPUS) per_mem=$(get SANDBOX_MEMORY) per_disk=$(get SANDBOX_DISK)
      read -r max ideal by < <(suggest "${P9M_HOST_CPUS:-$(nproc 2>/dev/null || echo 1)}" "$host_mb" "$host_disk" \
        "${per_cpus:-2}" "$(size_mb "${per_mem:-4g}")" "$(size_mb "${per_disk:-20g}")" "$([ "$(get DEFAULT_RUNTIME)" = kata ] && echo 200 || echo 0)")
      set_value SANDBOX_MAX_TOTAL "$max"
      if [ "$by" = disk ]; then why="as many as the disk holds at ${per_disk:-20g} each"
      else why="$ideal can use their full CPU and memory at once ($by first), twice that since most idle or sleep"; fi
      echo "SANDBOX_MAX_TOTAL=$max running sandboxes, suggested for this host: $why"
    fi ;;
esac

if [ ${#generated[@]} -gt 0 ]; then
  echo "Generated in .env: ${generated[*]}"
fi

domain=${1:-}
if [ -n "$domain" ]; then
  previous=$(get HOST_DOMAIN)
  set_value HOST_DOMAIN "$domain"
  # PUBLIC_URL follows while it is the example's or the one made from the previous domain; one of your own stays
  case "$(get PUBLIC_URL)" in
    ""|http://p9m.lvh.me|https://p9m.lvh.me|"http://p9m.$previous"|"https://p9m.$previous")
      if [ -f certs/tls.crt ] && [ -f certs/tls.key ]; then scheme=https; else scheme=http; fi
      ui=$(get UI_HOST)
      set_value PUBLIC_URL "$scheme://${ui:-p9m.$domain}" ;;
  esac
fi

public_url=$(get PUBLIC_URL)
cat <<EOF

Next:
  docker compose up -d

Then sign in at ${public_url:-http://p9m.lvh.me}
  user:     $(get ADMIN_USER)
  password: $(get ADMIN_PASSWORD)
  (only with ADMIN_LOGIN=on in .env: it is off by default, for an emergency;
   the everyday way in is OIDC, with your address in OIDC_ADMIN_EMAILS)
API token (Authorization: Bearer ...): $(get ADMIN_TOKEN)
EOF

case "$(get HOST_DOMAIN)" in
  ""|lvh.me) cat <<'EOF'

Note: HOST_DOMAIN is lvh.me, which points to this machine (127.0.0.1): fine for
trying Purgatorium here, not for a server. Run setup.sh again with your domain
(e.g. `bash setup.sh dev.example.com`); it needs a wildcard DNS record *.<domain>.
EOF
  ;;
esac

if ! grep -qs default-address-pools /etc/docker/daemon.json; then
  cat <<'EOF'

Note: /etc/docker/daemon.json has no default-address-pools. Docker's default
pools allow about 30 networks, and every sandbox needs one. See "Give the Docker
daemon a larger address pool" in https://csakaszamok.github.io/p9m/latest/install/
EOF
fi
