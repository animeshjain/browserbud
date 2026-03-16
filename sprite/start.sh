#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK_DIR="$HOME/sessions"
PORT_FILE="$HOME/.claude/ide/browserbud.port"

mkdir -p "$WORK_DIR"

# Start proxy server first (creates MCP WebSocket server + lock file)
node "$SCRIPT_DIR/server.js" &
PROXY_PID=$!
echo "Started proxy server (PID $PROXY_PID)"

# Wait for MCP port file to appear
for i in $(seq 1 30); do
  [ -f "$PORT_FILE" ] && break
  sleep 0.2
done

if [ -f "$PORT_FILE" ]; then
  MCP_PORT=$(cat "$PORT_FILE")
  echo "MCP server on port $MCP_PORT"
else
  echo "Warning: MCP port file not found, Claude Code won't auto-connect"
  MCP_PORT=""
fi

# Start ttyd with IDE integration env vars
ttyd -W -p 7681 bash -c "
  cd $WORK_DIR
  export CLAUDE_CODE_SSE_PORT=$MCP_PORT
  export ENABLE_IDE_INTEGRATION=true
  exec claude --dangerously-skip-permissions
" &
TTYD_PID=$!
echo "Started ttyd (PID $TTYD_PID)"

# Trap to clean up both processes
cleanup() {
  echo "Shutting down..."
  kill $TTYD_PID $PROXY_PID 2>/dev/null
}
trap cleanup EXIT INT TERM

# Wait for either to exit
wait -n
cleanup
