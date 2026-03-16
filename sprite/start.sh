#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Browser sessions live outside the plugin repo
WORK_DIR="$HOME/sessions"
mkdir -p "$WORK_DIR"

# Start ttyd serving Claude Code in the sessions directory
ttyd -W -p 7681 bash -c "cd $WORK_DIR && exec claude --dangerously-skip-permissions" &
TTYD_PID=$!
echo "Started ttyd (PID $TTYD_PID)"

# Wait briefly for ttyd to bind
sleep 1

# Start proxy server
node "$SCRIPT_DIR/server.js" &
PROXY_PID=$!
echo "Started proxy server (PID $PROXY_PID)"

# Trap to clean up both processes
cleanup() {
  echo "Shutting down..."
  kill $TTYD_PID $PROXY_PID 2>/dev/null
}
trap cleanup EXIT INT TERM

# Wait for either to exit
wait -n
cleanup
