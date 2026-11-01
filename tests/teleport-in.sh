#!/usr/bin/env bash
# Unit test for plugins/p9m/scripts/teleport-in.sh (/p9m:teleport, inside the sandbox's claude container), run here
# with a temporary HOME: the project, its secrets, the conversation and the user's settings put in place.
# Needs jq. Usage: bash tests/teleport-in.sh
set -euo pipefail
cd "$(dirname "$0")/.."
RED='\033[0;31m'; GREEN='\033[0;32m'; RESET='\033[0m'
pass() { echo -e "${GREEN}PASS${RESET}: $*"; }
fail() { echo -e "${RED}FAIL${RESET}: $*"; exit 1; }
eq() { [ "$2" = "$3" ] && pass "$1" || fail "$1: expected [$3], got [$2]"; }

. plugins/p9m/scripts/teleport-lib.sh
script=$PWD/plugins/p9m/scripts/teleport-in.sh
tmp=$(mktemp -d); trap 'chmod -R u+w "$tmp" 2>/dev/null; rm -rf "$tmp"' EXIT

stage=$tmp/stage
mkdir -p "$stage/files/b c" "$stage/secrets/config" "$stage/user/skills/mine"
echo a > "$stage/files/a.txt"; echo u > "$stage/files/b c/ü.txt"; ln -s "b c" "$stage/files/cur"
echo 'API_KEY=x' > "$stage/secrets/.env"; echo 'DB=y' > "$stage/secrets/config/.env"
echo '{"type":"user"}' > "$stage/session.jsonl"; echo abc123 > "$stage/session.id"; : > "$stage/subdir"
printf 'Ann Example\nann@example.com\ntrue\n' > "$stage/user/git-identity"; echo '# mine' > "$stage/user/CLAUDE.md"; echo skill > "$stage/user/skills/mine/SKILL.md"
cat > "$stage/user/settings.json" <<'JSON'
{"permissions":{"allow":["Bash(npm test)"]},"hooks":{"Stop":[]},"env":{"X":"1"},"mcpServers":{"a":{}},
 "enabledPlugins":{"superpowers@market":true,"off@market":false,"local@here":true}}
JSON
echo '{"market":{"source":{"source":"github","repo":"o/market"}},"here":{"source":{"source":"directory","path":"/x"}}}' > "$stage/user/known_marketplaces.json"

home=$tmp/home; mkdir -p "$home/.claude"
echo '{"theme":"dark","permissions":{"allow":["old"]}}' > "$home/.claude/settings.json"
run() { HOME=$home PATH=/usr/bin:/bin bash "$script" "$@"; }

out=$(run "$stage" shop)
p=$home/workspace/shop
[ -f "$p/a.txt" ] && [ -f "$p/b c/ü.txt" ] && pass "the project's files" || fail "files missing"
[ -L "$p/cur" ] && [ "$(readlink "$p/cur")" = "b c" ] && pass "a symlink stays a symlink" || fail "symlink"
[ "$(readlink "$p/.env")" = "$home/.secrets/shop/.env" ] && [ "$(readlink "$p/config/.env")" = "$home/.secrets/shop/config/.env" ] \
  && pass "secrets: symlinks in their places" || fail "secret symlinks"
eq "~/.secrets is 700" "$(stat -c %a "$home/.secrets")" 700
eq "the project's secrets folder is 700" "$(stat -c %a "$home/.secrets/shop")" 700
eq "a nested secrets folder is 700" "$(stat -c %a "$home/.secrets/shop/config")" 700
eq "a secret file is 600" "$(stat -c %a "$home/.secrets/shop/.env")" 600
eq "the secret's content" "$(cat "$p/.env")" "API_KEY=x"
[ -f "$home/.claude/projects/$(tp_claude_key "$p")/abc123.jsonl" ] && pass "the conversation where --resume finds it" || fail "conversation"
eq "git identity: who commits in the sandbox" "$(HOME=$home git config --global user.name) <$(HOME=$home git config --global user.email)>" "Ann Example <ann@example.com>"
eq "git: core.autocrlf as on the machine (a Windows checkout's line endings)" "$(HOME=$home git config --global core.autocrlf)" "true"
eq "global CLAUDE.md" "$(cat "$home/.claude/CLAUDE.md")" "# mine"
eq "own skills" "$(cat "$home/.claude/skills/mine/SKILL.md")" "skill"
eq "settings: permissions from the machine, the rest as the container had it" \
  "$(jq -c . "$home/.claude/settings.json")" '{"theme":"dark","permissions":{"allow":["Bash(npm test)"]}}'
echo "$out" | grep -qx $'skipped-plugin\tsuperpowers@market' && pass "no claude here: an enabled plugin is reported skipped" || fail "plugin report: $out"
echo "$out" | grep -qx $'skipped-plugin\tlocal@here' && pass "a local marketplace's plugin is skipped" || fail "local plugin"
echo "$out" | grep -q 'off@market' && fail "a disabled plugin must not be mentioned" || pass "a disabled plugin is left alone"
eq "last line: what to resume, and where" "$(echo "$out" | tail -n 1)" $'resume\tabc123\t'"$p"

echo changed > "$p/a.txt"
set +e; out=$(run "$stage" shop); code=$?; set -e
eq "again without --replace: exit 3" "$code" 3
eq "again without --replace: nothing touched" "$(cat "$p/a.txt")" changed
run "$stage" shop --replace >/dev/null
eq "with --replace: replaced" "$(cat "$p/a.txt")" a
[ -z "$(ls -A "$home/workspace" | grep -v '^shop$')" ] && pass "no temporary folder left" || fail "leftovers: $(ls -A "$home/workspace")"

echo sub > "$stage/subdir"; mkdir -p "$stage/files/sub"
run "$stage" shop2 >/dev/null
[ -f "$home/.claude/projects/$(tp_claude_key "$home/workspace/shop2/sub")/abc123.jsonl" ] && pass "a conversation from a subfolder goes under that folder's name" || fail "subdir conversation"

chmod 555 "$home/workspace"
set +e; run "$stage" shop3 >/dev/null 2>&1; code=$?; set -e
chmod 755 "$home/workspace"
[ "$code" -ne 0 ] && [ ! -e "$home/workspace/shop3" ] && [ -z "$(ls -A "$home/workspace" | grep shop3)" ] \
  && pass "a copy that cannot finish: non-zero, nothing half-written" || fail "interrupted copy (exit $code)"
