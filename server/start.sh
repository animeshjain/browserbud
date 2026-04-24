#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Source root .env for all config (API keys, data dir, etc.)
if [ -f "$REPO_DIR/.env" ]; then
  set -a
  source "$REPO_DIR/.env"
  set +a
fi

# Expand ~ to $HOME (shell doesn't expand ~ in quoted variable values)
WORK_DIR="${BROWSERBUD_DATA_DIR:-$HOME/browse}"
WORK_DIR="${WORK_DIR/#\~/$HOME}"
PORT_FILE="$HOME/.claude/ide/browserbud.port"
TMUX_SESSION="browserbud"
TMUX_SOCKET="browserbud"

# Resolve symlinks so Claude's cwd matches the lock file workspace path.
mkdir -p "$WORK_DIR"
WORK_DIR="$(cd "$WORK_DIR" && pwd -P)"

# Create userland directory structure
mkdir -p "$WORK_DIR/context" "$WORK_DIR/cache/youtube" \
         "$WORK_DIR/notes/youtube" "$WORK_DIR/notes/topics" \
         "$WORK_DIR/memory"

# Symlink .claude dir so the instance gets commands + settings
ln -sfn "$REPO_DIR/.claude" "$WORK_DIR/.claude"

# Symlink skills dir so CLI invocations work
ln -sfn "$REPO_DIR/skills" "$WORK_DIR/skills"

# Seed memory files if they don't exist
[ -f "$WORK_DIR/memory/index.md" ] || cat > "$WORK_DIR/memory/index.md" << 'EOF'
# BrowserBud Memory

## YouTube Videos Analyzed

(none yet)

## Topics

(none yet)
EOF

[ -f "$WORK_DIR/memory/log.jsonl" ] || touch "$WORK_DIR/memory/log.jsonl"

# Copy CLAUDE.md for the browsing instance
cp "$SCRIPT_DIR/CLAUDE.browse.md" "$WORK_DIR/CLAUDE.md"

# Export config for server.js and skills
export BROWSERBUD_DATA_DIR="$WORK_DIR"
BROWSERBUD_PORT="${BROWSERBUD_PORT:-8989}"
BROWSERBUD_TTYD_PORT="${BROWSERBUD_TTYD_PORT:-7682}"
export BROWSERBUD_PORT
export BROWSERBUD_TTYD_PORT

# Build the terminal bridge (requires esbuild devDependency in server/)
node "$SCRIPT_DIR/bridge/build.mjs"

# Remove stale port file so we wait for the fresh one
rm -f "$PORT_FILE"

# Start proxy server (logs flow to stdout)
node "$SCRIPT_DIR/server.js" 2>&1 &
PROXY_PID=$!

# Wait for MCP port file to appear
for i in $(seq 1 30); do
  [ -f "$PORT_FILE" ] && break
  sleep 0.2
done

if [ ! -f "$PORT_FILE" ]; then
  echo "Warning: server.js didn't signal ready in time — ttyd may fail to attach"
fi

# By the time the port file appears, server.js has already:
#   • written the MCP lock file
#   • hidden sibling IDE lock files (restored on Claude Code connect)
#   • (re)created the tmux session with claude --ide running in it
# So ttyd can attach immediately. See server.js: ensureTerminalSession.

IDE_DIR="$HOME/.claude/ide"

# Start ttyd — just attaches to the existing tmux session. server.js respawns
# the session on /ws upgrade if it has died since startup.
ttyd -W -p "$BROWSERBUD_TTYD_PORT" tmux -L "$TMUX_SOCKET" attach -t "$TMUX_SESSION" 2>&1 &
TTYD_PID=$!

# Safety-net cleanup. server.js owns session/lockfile teardown via its own
# SIGTERM handler, so this only runs if server.js failed to start.
cleanup() {
  echo "Shutting down..."
  kill $TTYD_PID $PROXY_PID 2>/dev/null
  tmux -L "$TMUX_SOCKET" kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  for f in "$IDE_DIR"/*.browserbud-hidden; do
    [ -f "$f" ] && mv "$f" "${f%.browserbud-hidden}" 2>/dev/null
  done
}
trap cleanup EXIT INT TERM

# Wait for processes (cleanup runs via EXIT trap)
wait $TTYD_PID $PROXY_PID
