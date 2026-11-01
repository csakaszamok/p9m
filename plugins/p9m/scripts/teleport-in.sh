#!/usr/bin/env bash
# /p9m:teleport, inside the sandbox's claude container (as agent): puts a staged project in place.
#
# Usage: teleport-in.sh STAGE PROJECT [--replace]
#   STAGE/files/          the project                    → ~/workspace/PROJECT (replaced only with --replace)
#   STAGE/secrets/        its confirmed secrets          → ~/.secrets/PROJECT (700/600), symlinked into the project
#   STAGE/session.jsonl   the conversation, its id in STAGE/session.id, the folder it ran in (relative) in STAGE/subdir
#   STAGE/user/           CLAUDE.md, skills/, settings.json (permissions and enabledPlugins), known_marketplaces.json,
#                         git-identity (user.name, user.email, core.autocrlf: three lines)
# Prints `skipped-plugin<TAB>name` for a plugin it could not install, and last `resume<TAB>id<TAB>folder`.
# Exit 3, changing nothing, when the project is there already and --replace is not given.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/teleport-lib.sh"

stage=$1 project=$2 replace=${3:-}
ws=$HOME/workspace dest=$HOME/workspace/$project
mkdir -p "$ws"
if [ -e "$dest" ] && [ "$replace" != --replace ]; then
  printf 'exists\t%s\n' "$dest"
  exit 3
fi

# The files into a temporary folder first, renamed only when complete: never a half-written project
tmp=$ws/.$project.tmp-$$ old=$ws/.$project.old-$$
trap 'rm -rf "$tmp"' EXIT
cp -a "$stage/files" "$tmp"
if [ -e "$dest" ]; then mv "$dest" "$old"; fi
mv -T "$tmp" "$dest"
rm -rf "$old"
trap - EXIT

# Secrets: outside the project, readable by agent only, a symlink where each one was
if [ -d "$stage/secrets" ]; then
  sec=$HOME/.secrets/$project
  mkdir -p "$sec" && chmod 700 "$HOME/.secrets"
  ( cd "$stage/secrets" && find . -type f -print0 ) | tp_strip_dot | while IFS= read -r -d '' f; do
    mkdir -p "$(dirname "$sec/$f")" "$(dirname "$dest/$f")"
    install -m 600 "$stage/secrets/$f" "$sec/$f"
    ln -sfn "$sec/$f" "$dest/$f"
  done
  find "$sec" -type d -exec chmod 700 {} +
fi

# The conversation, where `claude --resume <id>` looks for it: under the name of the folder it ran in
cwd=$dest id=
if [ -f "$stage/session.id" ]; then
  id=$(cat "$stage/session.id")
  sub=$(cat "$stage/subdir" 2>/dev/null || true)
  [ -n "$sub" ] && cwd=$dest/$sub
  mkdir -p "$cwd" "$HOME/.claude/projects/$(tp_claude_key "$cwd")"
  cp "$stage/session.jsonl" "$HOME/.claude/projects/$(tp_claude_key "$cwd")/$id.jsonl"
fi

# The user's portable settings
u=$stage/user
mkdir -p "$HOME/.claude"
[ -f "$u/CLAUDE.md" ] && cp "$u/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
# Who commits, and core.autocrlf (a Windows checkout's CRLF files would all look changed without it): only these of
# the user's git settings
if [ -f "$u/git-identity" ]; then
  gname= gmail= gcrlf=
  { IFS= read -r gname; IFS= read -r gmail; IFS= read -r gcrlf; } < "$u/git-identity" || true
  [ -n "$gname" ] && git config --global user.name "$gname"
  [ -n "$gmail" ] && git config --global user.email "$gmail"
  case $gcrlf in true|input) git config --global core.autocrlf "$gcrlf" ;; esac
fi
if [ -d "$u/skills" ]; then mkdir -p "$HOME/.claude/skills" && cp -a "$u/skills/." "$HOME/.claude/skills/"; fi
if [ -f "$u/settings.json" ]; then
  mine=$HOME/.claude/settings.json
  [ -f "$mine" ] || echo '{}' > "$mine"
  # Only the permissions come from the machine: hooks, env and MCP servers point at things that are not here
  if jq -e 'has("permissions")' "$u/settings.json" >/dev/null; then
    jq -s '.[0] + {permissions: .[1].permissions}' "$mine" "$u/settings.json" > "$mine.new" && mv "$mine.new" "$mine"
  fi
  # Enabled plugins, from a marketplace that can be reached from here (GitHub or a git URL); others reported
  jq -r '(.enabledPlugins // {}) | to_entries[] | select(.value == true) | .key' "$u/settings.json" | while IFS= read -r plugin; do
    market=${plugin##*@}
    src=$(jq -r --arg m "$market" '.[$m].source // {} | if .source == "github" then .repo elif .source == "git" then .url else "" end' \
      "$u/known_marketplaces.json" 2>/dev/null || true)
    if [ -n "$src" ] && command -v claude >/dev/null \
      && claude plugin marketplace add "$src" >/dev/null 2>&1 && claude plugin install "$plugin" >/dev/null 2>&1; then
      continue
    fi
    printf 'skipped-plugin\t%s\n' "$plugin"
  done
fi

printf 'resume\t%s\t%s\n' "$id" "$cwd"
