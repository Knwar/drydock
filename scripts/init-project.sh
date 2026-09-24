#!/bin/sh
# One-command kankan setup for a new OR existing project.
#   scripts/init-project.sh <target-dir> [project-name]
# Adapts to what's already there — appends and merges, never skips a
# needed piece and never overwrites user content. Idempotent.
#
# Update mode (KANKAN_UPDATE=1, via `kankan update`): re-sync kit-owned files
# into a project that's already set up — overwrites the files users don't edit
# (hooks, agents, statusline) and refreshes the CLAUDE.md protocol block.
set -e

KNWR_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$1"
NAME="${2:-$(basename "${TARGET:-}")}"
DAEMON_URL="${DAEMON_URL:-http://localhost:7890}"
UPDATE="${KANKAN_UPDATE:-}"

if [ -z "$TARGET" ]; then
  echo "usage: scripts/init-project.sh <target-dir> [project-name]" >&2
  exit 1
fi

mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd)"
if [ "$TARGET" = "$KNWR_ROOT" ]; then
  echo "refusing to bootstrap knwr into itself" >&2
  exit 1
fi

installed=""
merged=""
updated=""
kept=""

# 1. CLAUDE.md — install/refresh the protocol inside marker comments. Fresh
#    installs are always wrapped in markers so future updates can refresh in place.
if [ ! -f "$TARGET/CLAUDE.md" ]; then
  {
    printf '<!-- kankan:begin -->\n'
    cat "$KNWR_ROOT/CLAUDE.md"
    printf '<!-- kankan:end -->\n'
  } > "$TARGET/CLAUDE.md"
  installed="$installed CLAUDE.md"
elif grep -q 'kankan:begin' "$TARGET/CLAUDE.md"; then
  if [ -n "$UPDATE" ] && [ "$(node "$KNWR_ROOT/scripts/replace-block.js" "$TARGET/CLAUDE.md" "$KNWR_ROOT/CLAUDE.md")" = "updated" ]; then
    updated="$updated CLAUDE.md"
  else
    kept="$kept CLAUDE.md"
  fi
elif grep -q '# Kankan protocol' "$TARGET/CLAUDE.md"; then
  kept="$kept CLAUDE.md" # legacy unmarked protocol — left as-is to avoid duplication
else
  {
    printf '\n\n<!-- kankan:begin -->\n'
    cat "$KNWR_ROOT/CLAUDE.md"
    printf '<!-- kankan:end -->\n'
  } >> "$TARGET/CLAUDE.md"
  merged="$merged CLAUDE.md"
fi

# 2. .claude/ — kit-owned files (users don't edit these). Install if missing;
#    in update mode, overwrite. (settings.local.json is machine-local — never shipped.)
mkdir -p "$TARGET/.claude/hooks" "$TARGET/.claude/agents"
for f in "$KNWR_ROOT"/.claude/hooks/*.js "$KNWR_ROOT"/.claude/agents/*.md "$KNWR_ROOT/.claude/statusline.js"; do
  rel=".claude/${f#"$KNWR_ROOT"/.claude/}"
  if [ ! -e "$TARGET/$rel" ]; then
    cp "$f" "$TARGET/$rel"
    installed="$installed $rel"
  elif [ -n "$UPDATE" ]; then
    cp "$f" "$TARGET/$rel"
    updated="$updated $rel"
  else
    kept="$kept $rel"
  fi
done

# 3. .claude/settings.json — JSON-merge our hooks + statusline into theirs
case "$(node "$KNWR_ROOT/scripts/merge-config.js" settings "$KNWR_ROOT/.claude/settings.json" "$TARGET/.claude/settings.json")" in
  installed) installed="$installed .claude/settings.json" ;;
  merged)    merged="$merged .claude/settings.json" ;;
  *)         kept="$kept .claude/settings.json" ;;
esac

# 4. MCP server: build if missing, merge alongside any existing servers
if [ ! -f "$KNWR_ROOT/dist/mcp/server.js" ]; then
  echo "building MCP server (dist missing)..."
  (cd "$KNWR_ROOT" && npm run build > /dev/null)
fi
case "$(node "$KNWR_ROOT/scripts/merge-config.js" mcp "$TARGET/.mcp.json" "$KNWR_ROOT/dist/mcp/server.js" "$DAEMON_URL")" in
  installed) installed="$installed .mcp.json" ;;
  merged)    merged="$merged .mcp.json" ;;
  *)         kept="$kept .mcp.json" ;;
esac

# 5. git: worktrees and card branches need a repo with a HEAD
cd "$TARGET"
if [ ! -d .git ]; then
  git init -qb main
  installed="$installed .git"
  # never sweep secrets/deps/build output into the first commit
  if [ ! -e .gitignore ]; then
    printf '%s\n' 'node_modules/' '.env' '.env.*' 'dist/' 'build/' '.DS_Store' '.trees/' > .gitignore
    installed="$installed .gitignore"
  fi
fi
if ! git rev-parse HEAD > /dev/null 2>&1; then
  git add -A
  git commit -qm "Bootstrap kankan orchestration kit"
  installed="$installed (initial commit)"
fi

# 6. register with the daemon (best-effort)
PROJECT_LINE=""
urlenc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
if command -v curl > /dev/null; then
  RESP=$(curl -s --max-time 2 "$DAEMON_URL/project?root=$(urlenc "$TARGET")&name=$(urlenc "$NAME")" 2>/dev/null || true)
  PROJECT_ID=$(printf %s "$RESP" | sed -nE 's/.*"project_id":"([^"]+)".*/\1/p')
  if [ -n "$PROJECT_ID" ]; then
    PROJECT_LINE="overlay:   $DAEMON_URL/?project=$PROJECT_ID"
  else
    PROJECT_LINE="daemon not reachable — start it with: cd $KNWR_ROOT && ./scripts/dev.sh"
  fi
fi

[ -n "$UPDATE" ] && echo "kankan updated in $TARGET" || echo "kankan ready in $TARGET"
[ -n "$installed" ] && echo "  installed:$installed"
[ -n "$updated" ]   && echo "  updated:$updated"
[ -n "$merged" ]    && echo "  merged into existing:$merged"
[ -n "$kept" ]      && echo "  already in place:$kept"
echo "  $PROJECT_LINE"
if [ -n "$UPDATE" ]; then
  echo "  next:      restart Claude Code in $TARGET to load the refreshed hooks"
else
  echo "  next:      cd $TARGET && claude   (approve the kankan MCP server + hooks on first run)"
fi
