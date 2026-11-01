# /p9m:teleport's helpers, sourced by teleport.sh (on the user's machine) and teleport-in.sh (in the sandbox's claude
# container). Functions only. Paths are printed relative to the project; file lists are NUL-separated.

# Left out when the project is not a git repository (with git, .gitignore decides)
TP_EXCLUDES=(node_modules .venv venv __pycache__ dist build target .next .nuxt .cache .gradle .terraform .p9m .git)

# The project's name in the sandbox: the folder's name, lowercase, anything but a-z 0-9 . _ - turned into -
tp_project_name() {
  local base
  base=$(basename -- "$1" | tr '[:upper:]' '[:lower:]')
  printf '%s\n' "$base" | sed 's/[^a-z0-9._-]/-/g'
}

# The folder Claude Code keeps a project's conversations in, under ~/.claude/projects: its path, every character but
# letters and digits turned into -
tp_claude_key() {
  printf '%s\n' "$1" | sed 's/[^A-Za-z0-9]/-/g'
}

# Whether a file name (its last part) looks like a secret
tp_is_secret() {
  local name=${1##*/}
  case $name in
    .env.example|.env.sample|.env.template|.env.dist|*.pub) return 1 ;;
    .env|.env.*|*.pem|*.key|*.p12|*.pfx|credentials*.json|id_rsa*|id_ed25519*|id_ecdsa*|.npmrc|.netrc|.pypirc) return 0 ;;
  esac
  return 1
}

# find's ./paths without the ./ (sed -z is GNU only: macOS has BSD sed)
tp_strip_dot() {
  local f
  while IFS= read -r -d '' f; do printf '%s\0' "${f#./}"; done
}

# Every file in the project, ignored or not, as relative paths (NUL-separated); never .git or .p9m
tp_all_files() {
  ( cd -- "$1" && find . \( -name .git -o -name .p9m \) -prune -o \( -type f -o -type l \) -print0 ) | tp_strip_dot
}

# Whether a path is inside one of the dependency and build folders (TP_EXCLUDES)
tp_in_excluded() {
  local e
  for e in "${TP_EXCLUDES[@]}"; do
    case /$1 in */"$e"/*) return 0 ;; esac
  done
  return 1
}

# The files that look like secrets, one per line, sorted (tracked or not, ignored or not); not inside dependency
# folders (a .venv's cacert.pem, a package's test key)
tp_secret_candidates() {
  local f
  tp_all_files "$1" | while IFS= read -r -d '' f; do
    if tp_is_secret "$f" && ! tp_in_excluded "$f"; then printf '%s\n' "$f"; fi
  done | LC_ALL=C sort
}

# The files that go: with git the tracked and untracked ones .gitignore lets through, and the repository itself (.git,
# for the way back: commit and push in the sandbox), otherwise all but TP_EXCLUDES; never the secret candidates (they
# go only when confirmed) nor .p9m. NUL-separated, sorted; meant for tar --no-recursion (.git's folders are listed).
tp_file_list() {
  local dir=$1 f
  {
    if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      git -C "$dir" ls-files -z --cached --others --exclude-standard
      # Its folders too: after git gc refs/heads is empty, and git needs it to be there (tar --no-recursion)
      [ -d "$dir/.git" ] && ( cd -- "$dir" && find .git -print0 )
    else
      local prune=() e
      for e in "${TP_EXCLUDES[@]}"; do prune+=(-name "$e" -o); done
      ( cd -- "$dir" && find . \( "${prune[@]}" -false \) -prune -o \( -type f -o -type l \) -print0 ) | tp_strip_dot
    fi
  } | while IFS= read -r -d '' f; do
    case $f in .p9m/*) continue ;; esac
    # A nested repository or a submodule comes as a folder (nested/): its own files, by its own .gitignore; a bare
    # folder entry would make tar take everything in it, its secrets and dependencies too
    if [ -d "$dir/$f" ] && [ ! -L "$dir/$f" ]; then
      case $f in .git|.git/*) printf '%s\0' "$f"; continue ;; esac
      local sub=${f%/} g
      tp_file_list "$dir/$sub" | while IFS= read -r -d '' g; do printf '%s\0' "$sub/$g"; done
      continue
    fi
    case $f in .git/*) ;; *) tp_is_secret "$f" && continue ;; esac
    # Deleted in the working folder but still in git's index
    [ -e "$dir/$f" ] || [ -L "$dir/$f" ] || continue
    printf '%s\0' "$f"
  done | LC_ALL=C sort -z
}

# The current conversation's id: CLAUDE_SESSION_ID when Claude Code gives it and its file is there, otherwise the most
# recently written conversation of the project. CWD as Claude Code saw it (on Windows C:\…). Exit 1 when it has none.
tp_current_session() {
  local dir="$1/projects/$(tp_claude_key "$2")" newest esc hit
  # Claude Code's own name for the folder can differ from ours (a non-ASCII path under another locale): then the folder
  # whose conversations say they ran in this cwd
  if [ -z "$(ls -- "$dir"/*.jsonl 2>/dev/null)" ]; then
    esc=$(printf '%s' "$2" | sed 's/\\/\\\\/g; s/"/\\"/g')
    hit=$(grep -rlF --include='*.jsonl' "\"cwd\":\"$esc\"" "$1/projects" 2>/dev/null | head -n 1) || true
    [ -n "$hit" ] && dir=${hit%/*}
  fi
  if [ -n "${CLAUDE_SESSION_ID:-}" ] && [ -f "$dir/$CLAUDE_SESSION_ID.jsonl" ]; then
    printf '%s\n' "$CLAUDE_SESSION_ID"; return 0
  fi
  newest=$(ls -t -- "$dir"/*.jsonl 2>/dev/null | head -n 1) || true
  [ -n "$newest" ] || return 1
  newest=${newest##*/}
  printf '%s\n' "${newest%.jsonl}"
}
