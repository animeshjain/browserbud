#!/usr/bin/env bash
# (Re)create the browserbud tmux session with claude --ide running in it.
# Invoked by server.js at startup and whenever the session has died.
#
# Args:  $1 = WORK_DIR (claude's cwd, also BROWSERBUD_DATA_DIR)
# Env:   BROWSERBUD_TMUX_SOCKET (default: browserbud)
#        BROWSERBUD_TMUX_SESSION (default: browserbud)

set -e

WORK_DIR="${1:?usage: tmux-session.sh WORK_DIR}"
TMUX_SOCKET="${BROWSERBUD_TMUX_SOCKET:-browserbud}"
TMUX_SESSION="${BROWSERBUD_TMUX_SESSION:-browserbud}"

# Idempotent: kill any prior session on our dedicated socket.
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
