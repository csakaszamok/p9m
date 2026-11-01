#!/usr/bin/env bash
# /p9m:teleport on the user's machine: moves this project (run in its root, where .p9m is) into a claude container in
# its own sandbox, through the sandbox's Docker. Purgatorium's API is used only to wake the sandbox.
#
#   teleport.sh --plan [--ecc]                                    what would move, as tab-separated lines:
#       project NAME | files COUNT BYTES | secret PATH | session ID ISO-TIME | setting WHAT | exists yes|no | large yes|no
#   teleport.sh --run [--ecc] [--replace] [--secret PATH]...      moves it; the last line: resume ID FOLDER
#
# Exit 2 with `error<TAB>message` when it cannot; 3 when the project is in the sandbox already and --replace is not
# given. Never prints the token or a secret: secrets go only when named with --secret.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/teleport-lib.sh"

err() { printf 'error\t%s\n' "$1"; exit 2; }

# macOS tar would add AppleDouble ._ files for extended attributes
export COPYFILE_DISABLE=1

mode= image=ghcr.io/csakaszamok/p9m-claude-code-minimal:latest replace= secrets=()
while [ $# -gt 0 ]; do
  case $1 in
    --plan|--run) mode=${1#--} ;;
    --ecc) image=ghcr.io/csakaszamok/p9m-claude-code-ecc:latest ;;
    --replace) replace=--replace ;;
    --secret) secrets+=("$2"); shift ;;
    *) err "unknown argument: $1" ;;
  esac
  shift
done
[ -n "$mode" ] || err "usage: teleport.sh --plan|--run [--ecc] [--replace] [--secret PATH]..."

[ -f .p9m/p9m.env ] || err "run /p9m:init first"
P9M_URL= P9M_TOKEN= P9M_SANDBOX=
. ./.p9m/p9m.env
[ -n "$P9M_URL" ] && [ -n "$P9M_TOKEN" ] && [ -n "$P9M_SANDBOX" ] || err "run /p9m:init first"
ctx=$P9M_SANDBOX

# The sandbox's Docker. MSYS_NO_PATHCONV: in Git Bash a /path argument would be rewritten into a Windows path, and
# most of these are paths in the container; this machine's own files go through hostpath
dk() { MSYS_NO_PATHCONV=1 docker --context "$ctx" "$@"; }
hostpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s\n' "$1"; fi; }

# An http:// P9M_URL may be answered with a redirect to https://, and curl drops the token on a redirect to another
# port: ask once, without the token, where the address lands, and call the API there
landed=$(curl -s -o /dev/null -L -w '%{url_effective}' "$P9M_URL/" 2>/dev/null || true)
case $landed in http://*|https://*) P9M_URL=$(printf '%s\n' "$landed" | sed -E 's|^(https?://[^/]+).*|\1|') ;; esac

# The API, the token on stdin (never in the arguments, which other processes can see)
api() { printf 'Authorization: Bearer %s\n' "$P9M_TOKEN" | curl -sf "$@" -H @- 2>/dev/null; }
status() { api "$P9M_URL/sandboxes/$ctx" | grep -o '"status":"[a-z_]*"' | head -n 1 | cut -d'"' -f4; }

# Connecting to its Docker does not wake a sleeping sandbox: wake it first
if [ "$(status || true)" != running ]; then
  api -X POST "$P9M_URL/sandboxes/$ctx/start" >/dev/null || true
  deadline=$((SECONDS + ${TELEPORT_WAKE_TIMEOUT:-60}))
  until [ "$(status || true)" = running ]; do
    [ $SECONDS -lt $deadline ] || err "the sandbox did not wake up in time: try again"
    sleep 2
  done
fi
dk compose ls >/dev/null 2>&1 || err "turn Docker access on: Access → Enable in the sandbox panel"

project=$(tp_project_name "$PWD")
claude_home=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
has_claude=$(dk ps -q --filter 'name=^claude$' 2>/dev/null || true)
# Ours has the secrets volume; a claude-code* template's claude container has none: no secrets into that one
secrets_volume=no
if [ -n "$has_claude" ]; then
  case " $(dk inspect claude --format '{{range .Mounts}}{{.Destination}} {{end}}' 2>/dev/null || true) " in
    *" /home/agent/.secrets "*) secrets_volume=yes ;;
  esac
fi
exists=no
if [ -n "$has_claude" ] && dk exec claude test -e "/home/agent/workspace/$project" >/dev/null 2>&1; then exists=yes; fi
# The folder as Claude Code saw it: on Windows (Git Bash) C:\…, not /c/…
native=$(hostpath "$PWD")
session=$(tp_current_session "$claude_home" "$native" || true)
session_file=
[ -n "$session" ] && session_file=$(find "$claude_home/projects" -name "$session.jsonl" 2>/dev/null | head -n 1)

if [ "$mode" = plan ]; then
  # One pass (a process per file would take minutes in a big repository, on Windows above all): the entries, and the
  # size of what would be sent
  count=$(tp_file_list . | tr -cd '\0' | wc -c | tr -d ' ')
  bytes=$(tp_file_list . | tar -c --null --no-recursion -T - -f - | wc -c | tr -d ' ')
  printf 'project\t%s\n' "$project"
  printf 'files\t%s\t%s\n' "$count" "$bytes"
  # A secret that is a symlink is never followed (it could point at ~/.ssh): listed apart, and refused
  tp_secret_candidates . | while IFS= read -r s; do
    if [ -L "$s" ]; then printf 'secret-link\t%s\n' "$s"; else printf 'secret\t%s\n' "$s"; fi
  done
  if [ -n "$session" ]; then
    printf 'session\t%s\t%s\n' "$session" "$(date -u -r "$session_file" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
  fi
  [ -f "$claude_home/CLAUDE.md" ] && printf 'setting\tCLAUDE.md\n'
  [ -n "$(ls -A "$claude_home/skills" 2>/dev/null)" ] && printf 'setting\tskills\n'
  if [ -f "$claude_home/settings.json" ]; then
    grep -q '"permissions"' "$claude_home/settings.json" && printf 'setting\tpermissions\n'
    n=$( { grep -o '"[^"]*@[^"]*" *: *true' "$claude_home/settings.json" || true; } | wc -l | tr -d ' ')
    [ "$n" -gt 0 ] && printf 'setting\tplugins:%s\n' "$n"
  fi
  printf 'exists\t%s\n' "$exists"
  [ "$bytes" -gt 524288000 ] && printf 'large\tyes\n' || printf 'large\tno\n'
  exit 0
fi

# --run: only confirmed secrets, and only real candidates
candidates=$(tp_secret_candidates .)
for s in ${secrets[@]+"${secrets[@]}"}; do
  grep -qxF -- "$s" <<<"$candidates" || err "not a secret file of this project: $s"
  if [ -L "$s" ]; then err "a secret that is a symlink is not taken: $s"; fi
done
if [ ${#secrets[@]} -gt 0 ] && [ -n "$has_claude" ] && [ "$secrets_volume" = no ]; then
  err "this sandbox's claude container has no secrets volume (it comes from a claude-code template): teleport without secrets, or remove that container first"
fi
if [ "$exists" = yes ] && [ -z "$replace" ]; then printf 'exists\t/home/agent/workspace/%s\n' "$project"; exit 3; fi

if [ -z "$has_claude" ]; then
  # From Purgatorium's ghcr.io cache when the sandbox has it (registry-cache:5001): the image comes from the server,
  # not from the internet, for every participant after the first. An older server or sandbox has none: compose then
  # pulls from ghcr.io itself, as before
  cached=registry-cache:5001/${image#ghcr.io/}
  if dk pull -q "$cached" >/dev/null 2>&1; then dk tag "$cached" "$image" >/dev/null 2>&1 || true; fi
  out=$(TELEPORT_IMAGE=$image dk compose -p claude -f "$(hostpath "$here/teleport-compose.yaml")" up -d 2>&1) \
    || err "the claude container did not start: $(printf '%s\n' "$out" | tail -n 1)"
  secrets_volume=yes
fi

# Stage everything locally, then one archive into the container
st=$(mktemp -d)
# In the container the stage holds the secrets too: on the secrets volume, which archives leave out
if [ "$secrets_volume" = yes ]; then remote=/home/agent/.secrets/.incoming-$RANDOM$RANDOM; else remote=/tmp/teleport-$RANDOM$RANDOM; fi
cleanup() { rm -rf "$st"; dk exec claude rm -rf "$remote" >/dev/null 2>&1 || true; }
trap cleanup EXIT
stage=$st/stage
mkdir -p "$stage/files" "$stage/user"
tp_file_list . | tar -c --null --no-recursion -T - -f - | tar -x -C "$stage/files" -f -
for s in ${secrets[@]+"${secrets[@]}"}; do
  mkdir -p -- "$stage/secrets/$(dirname -- "$s")"
  cp -p -- "$s" "$stage/secrets/$s"
done
if [ -n "$session_file" ] && [ -f "$session_file" ]; then
  cp "$session_file" "$stage/session.jsonl"
  printf '%s\n' "$session" > "$stage/session.id"
  : > "$stage/subdir"
fi
[ -f "$claude_home/CLAUDE.md" ] && cp "$claude_home/CLAUDE.md" "$stage/user/"
gname=$(git config user.name 2>/dev/null || true) gmail=$(git config user.email 2>/dev/null || true)
gcrlf=$(git config core.autocrlf 2>/dev/null || true)
[ -n "$gname$gmail$gcrlf" ] && printf '%s\n%s\n%s\n' "$gname" "$gmail" "$gcrlf" > "$stage/user/git-identity"
[ -d "$claude_home/skills" ] && cp -R "$claude_home/skills" "$stage/user/"
[ -f "$claude_home/settings.json" ] && cp "$claude_home/settings.json" "$stage/user/"
[ -f "$claude_home/plugins/known_marketplaces.json" ] && cp "$claude_home/plugins/known_marketplaces.json" "$stage/user/"
tar -C "$st" -czf "$st/stage.tgz" stage

dk exec claude mkdir -p "$remote"
dk cp "$(hostpath "$st/stage.tgz")" "claude:$remote/stage.tgz"
dk cp "$(hostpath "$here/teleport-in.sh")" "claude:$remote/teleport-in.sh"
dk cp "$(hostpath "$here/teleport-lib.sh")" "claude:$remote/teleport-lib.sh"
dk exec claude tar -xzf "$remote/stage.tgz" -C "$remote"
dk exec -u agent claude bash "$remote/teleport-in.sh" "$remote/stage" "$project" $replace
