#!/usr/bin/env bash
# Unit test for plugins/p9m/scripts/teleport-lib.sh (/p9m:teleport, the user's machine side): project names, Claude's
# projects folder names, the file list, the secret candidates and the current conversation.
# Usage: bash tests/teleport-lib.sh
set -euo pipefail
cd "$(dirname "$0")/.."
RED='\033[0;31m'; GREEN='\033[0;32m'; RESET='\033[0m'
pass() { echo -e "${GREEN}PASS${RESET}: $*"; }
fail() { echo -e "${RED}FAIL${RESET}: $*"; exit 1; }
eq() { [ "$2" = "$3" ] && pass "$1" || fail "$1: expected [$3], got [$2]"; }

. plugins/p9m/scripts/teleport-lib.sh

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

eq "project name: lowercase, odd characters to -" "$(tp_project_name "/tmp/x/My Shop!")" "my-shop-"
eq "project name: dots and digits kept" "$(tp_project_name /tmp/x/api.v2)" "api.v2"
eq "claude key: a Linux path" "$(tp_claude_key /home/agent/workspace/shop)" "-home-agent-workspace-shop"
eq "claude key: a Windows path" "$(tp_claude_key 'C:\Users\Ann\My Shop')" "C--Users-Ann-My-Shop"

# A project with everything that matters
make_tree() {
  local d=$1
  mkdir -p "$d/b c" "$d/config" "$d/node_modules" "$d/.p9m"
  echo a > "$d/a.txt"; echo u > "$d/b c/ü.txt"; echo d > "$d/-dash.txt"
  echo s > "$d/.env"; echo s > "$d/.env.local"; echo e > "$d/.env.example"; echo s > "$d/config/.env"
  echo k > "$d/key.pem"; echo p > "$d/id_ed25519.pub"; echo n > "$d/node_modules/x.js"; echo t > "$d/.p9m/p9m.env"
  ln -s "b c" "$d/cur"
}
list() { tp_file_list "$1" | tr '\0' '\n'; }

g=$tmp/git; make_tree "$g"
printf 'node_modules/\n.env\n.env.local\n*.pem\n' > "$g/.gitignore"
( cd "$g" && git init -q && git add a.txt "b c" .gitignore cur && git add -f config/.env \
  && git -c user.email=t@t -c user.name=t commit -qm init && echo new > new.txt )

eq "secret candidates (tracked config/.env too; not .env.example, not .pub, not .p9m)" \
  "$(tp_secret_candidates "$g" | tr '\n' ' ')" ".env .env.local config/.env key.pem "
eq "git: the file list (uncommitted in, ignored and secrets and .p9m out, symlink as itself)" \
  "$(list "$g" | grep -vE '^\.git(/|$)' | tr '\n' '|')" "-dash.txt|.env.example|.gitignore|a.txt|b c/ü.txt|cur|id_ed25519.pub|new.txt|"
eq "git: the repository itself (.git) goes along, for the way back" "$(list "$g" | grep -c '^\.git/HEAD$' || true)" "1"
# #1: an untracked nested repository: its files under its own .gitignore, its secrets only as candidates
mkdir -p "$g/nested/node_modules"; echo app > "$g/nested/app.js"; echo s > "$g/nested/.env"; echo x > "$g/nested/node_modules/x.js"
printf 'node_modules/\n' > "$g/nested/.gitignore"; ( cd "$g/nested" && git init -q )
nl=$(list "$g")
grep -qx 'nested/app.js' <<<"$nl" && grep -qx 'nested/.git/HEAD' <<<"$nl" && pass "a nested repository's files go" || fail "nested files: $nl"
grep -qx 'nested/' <<<"$nl" && fail "a bare folder entry would make tar copy everything in it" || pass "no bare folder entry for a nested repository"
grep -q '^nested/\.env$\|^nested/node_modules' <<<"$nl" && fail "nested .env or node_modules in the list" || pass "a nested repository's .env and ignored folders stay out"
grep -qx 'nested/.env' <<<"$(tp_secret_candidates "$g")" && pass "a nested repository's .env is a candidate" || fail "nested .env not a candidate"
rm -rf "$g/nested"

# #11: certificates inside dependency folders are not asked about
mkdir -p "$g/.venv/lib/certifi" "$g/node_modules/x"; echo c > "$g/.venv/lib/certifi/cacert.pem"; echo k > "$g/node_modules/x/server.key"
grep -q 'cacert.pem\|server.key' <<<"$(tp_secret_candidates "$g")" && fail "dependency certificates asked about" || pass "no candidates inside .venv or node_modules"
rm -rf "$g/.venv" "$g/node_modules/x"

# #7: after git gc the refs folders are empty: the copy must still be a repository
( cd "$g" && git gc -q && git pack-refs --all )
out=$tmp/copy; mkdir -p "$out"
( cd "$g" && tp_file_list . | tar -c --null --no-recursion -T - -f - ) | tar -x -C "$out" -f -
git -C "$out" rev-parse HEAD >/dev/null 2>&1 && pass "after git gc the copied .git is still a repository" || fail "copied .git after gc is not a repository"
rm "$g/a.txt"
eq "git: a file deleted in the working folder is not listed" "$(list "$g" | grep -c '^a.txt$' || true)" "0"

n=$tmp/plain; make_tree "$n"; mkdir -p "$n/.git" "$n/dist"; echo x > "$n/dist/app.js"
eq "no git: the built-in excludes" \
  "$(list "$n" | tr '\n' '|')" "-dash.txt|.env.example|a.txt|b c/ü.txt|cur|id_ed25519.pub|"

# The current conversation
ch=$tmp/claude; cwd=/home/ann/shop; pd=$ch/projects/$(tp_claude_key "$cwd"); mkdir -p "$pd"
echo '{}' > "$pd/older.jsonl"; touch -d '2026-10-30 10:00' "$pd/older.jsonl"
echo '{}' > "$pd/newer.jsonl"; touch -d '2026-10-31 10:00' "$pd/newer.jsonl"
eq "session: the newest" "$(CLAUDE_SESSION_ID= tp_current_session "$ch" "$cwd")" "newer"
eq "session: the one Claude Code names" "$(CLAUDE_SESSION_ID=older tp_current_session "$ch" "$cwd")" "older"
eq "session: a named one that is not there falls back to the newest" "$(CLAUDE_SESSION_ID=gone tp_current_session "$ch" "$cwd")" "newer"
# #4: Claude Code's folder name differs from ours (locale, Windows): found by the cwd the conversation carries
mkdir -p "$ch/projects/-home-ann-Caf-"; printf '{"type":"user","cwd":"/home/ann/Café"}\n' > "$ch/projects/-home-ann-Caf-/cafe1.jsonl"
eq "session: found by its cwd when the folder name differs" "$(LC_ALL=C CLAUDE_SESSION_ID= tp_current_session "$ch" /home/ann/Café)" "cafe1"
mkdir -p "$ch/projects/C--Users-Ann-My-Shop"; printf '{"cwd":"C:\\\\Users\\\\Ann\\\\My Shop"}\n' > "$ch/projects/C--Users-Ann-My-Shop/win1.jsonl"
eq "session: a Windows path" "$(CLAUDE_SESSION_ID= tp_current_session "$ch" 'C:\Users\Ann\My Shop')" "win1"
if CLAUDE_SESSION_ID= tp_current_session "$ch" /home/ann/other >/dev/null 2>&1; then fail "no conversation must fail"; else pass "no conversation: exit non-zero"; fi
