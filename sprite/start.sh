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

if [ -f "$PORT_FILE" ]; then
  MCP_PORT=$(cat "$PORT_FILE")
else
  echo "Warning: MCP port file not found, Claude Code won't auto-connect to browser"
  MCP_PORT=""
fi

# Hide other IDE lock files so Claude Code only discovers BrowserBud.
# --ide auto-connects when exactly one valid lock file exists.
# We restore them after 30s — Claude Code only scans at startup.
IDE_DIR="$HOME/.claude/ide"
for f in "$IDE_DIR"/*.lock; do
  [ -f "$f" ] || continue
  case "$(basename "$f")" in
    "$MCP_PORT.lock") continue ;;
  esac
  mv "$f" "$f.browserbud-hidden"
done

# Kill any previous tmux session on our dedicated socket
tmux -L "$TMUX_SOCKET" kill-session -t "$TMUX_SESSION" 2>/dev/null || true

# Create tmux session on a dedicated socket so our config (key bindings,
# mouse settings) doesn't leak into the user's other tmux sessions.
tmux -L "$TMUX_SOCKET" new-session -d -s "$TMUX_SESSION" -x 200 -y 50

# Disable alternate screen so all output stays in the normal buffer with
# scrollback history. Must be set before Claude starts — ink emits
# \e[?1049h very early and alt-screen has no scrollback.
tmux -L "$TMUX_SOCKET" set-window-option -t "$TMUX_SESSION" alternate-screen off

# Enable mouse so tmux handles wheel events for scrollback.
# Override WheelUpPane to always enter copy-mode instead of forwarding
# wheel events to the app (which causes Claude Code to cycle history).
# copy-mode -e auto-exits when the user scrolls back to the bottom.
# Low escape-time so the bridge's ESC-then-paste delay (50ms) works reliably.
# Default is 500ms which would require a much longer (sluggish) delay.
tmux -L "$TMUX_SOCKET" set-option -s escape-time 10
tmux -L "$TMUX_SOCKET" set-option -t "$TMUX_SESSION" mouse on
tmux -L "$TMUX_SOCKET" bind -T root WheelUpPane if-shell -Ft= '#{pane_in_mode}' 'send-keys -M' 'copy-mode -e'
tmux -L "$TMUX_SOCKET" bind -T root WheelDownPane if-shell -Ft= '#{pane_in_mode}' 'send-keys -M' ''

# Disable tmux's built-in right-click context menu (bridge script provides one).
tmux -L "$TMUX_SOCKET" unbind -T root MouseDown3Pane 2>/dev/null || true
tmux -L "$TMUX_SOCKET" unbind -T copy-mode MouseDown3Pane 2>/dev/null || true
tmux -L "$TMUX_SOCKET" unbind -T copy-mode-vi MouseDown3Pane 2>/dev/null || true

bind_copy_mode_passthrough_key() {
  local key="$1"
  tmux -L "$TMUX_SOCKET" bind -T copy-mode "$key" send-keys -X cancel \\\; send-keys
  tmux -L "$TMUX_SOCKET" bind -T copy-mode-vi "$key" send-keys -X cancel \\\; send-keys
}

# In copy-mode, normal typing should drop the selection and resume input in
# Claude Code instead of being interpreted as copy-mode navigation/search.
for key in {a..z} {A..Z} {0..9}; do
  bind_copy_mode_passthrough_key "$key"
done
bind_copy_mode_passthrough_key Space
bind_copy_mode_passthrough_key Enter
bind_copy_mode_passthrough_key Tab
bind_copy_mode_passthrough_key BSpace
bind_copy_mode_passthrough_key /
bind_copy_mode_passthrough_key '?'

# Mouse drag: keep selection visible after release but do NOT copy to clipboard.
# copy-selection-no-clear stays in copy-mode with highlight intact.
# Typed input exits copy-mode via the tmux key bindings above, so left-drag can
# start selections after scrolling through history without jumping back down.
tmux -L "$TMUX_SOCKET" bind -T copy-mode MouseDragEnd1Pane send-keys -X copy-selection-no-clear
tmux -L "$TMUX_SOCKET" bind -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-selection-no-clear

# Use the most recently active client's size instead of the smallest.
tmux -L "$TMUX_SOCKET" set-option -t "$TMUX_SESSION" -g window-size latest

# Launch Claude Code via respawn-pane (deterministic, no shell-prompt dependency).
tmux -L "$TMUX_SOCKET" respawn-pane -t "$TMUX_SESSION" -k \
  "cd $WORK_DIR && unset TERMINAL_EMULATOR __CFBundleIdentifier && ENABLE_IDE_INTEGRATION=true BROWSERBUD_DATA_DIR=$WORK_DIR exec claude --ide"

# Hidden lock files are restored by server.js when Claude Code connects,
# and by the cleanup trap as a safety net.

# Start ttyd — just attaches to the existing tmux session
ttyd -W -p "$BROWSERBUD_TTYD_PORT" tmux -L "$TMUX_SOCKET" attach -t "$TMUX_SESSION" 2>&1 &
TTYD_PID=$!

# Trap to clean up processes and tmux session. No need to unbind keys —
# the dedicated tmux server dies with its last session.
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
