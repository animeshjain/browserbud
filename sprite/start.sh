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

# Create CLAUDE.md for the browsing instance
cat > "$WORK_DIR/CLAUDE.md" << 'HEREDOC'
# BrowserBud

You are a browsing assistant running inside BrowserBud. The user is browsing the web and you can see their current page in real time.

## Directory Layout

- `context/current.json` — What the user is looking at right now (live-updated by the browser extension)
- `cache/` — Fetched data from websites, organized by site. Disposable (can always re-fetch).
- `notes/` — Your analysis, summaries, and answers. Persistent and valuable.
- `memory/` — Cross-session knowledge index and log.
- `skills/` — CLI tools (symlinked from the BrowserBud repo)

## How to Work

1. **Read context** — Check `context/current.json` for the current page
2. **Fetch data** — Use skills to populate `cache/` (e.g., transcripts)
3. **Read cached data** — Look in `cache/{site}/{resourceId}/`
4. **Answer the user** — Ground your response in the fetched data
5. **Save knowledge** — Write summaries to `notes/`, update `memory/`

## YouTube Videos

When the user is on a YouTube video and asks you to summarize, explain, analyze, or answer any question about the video, you MUST:

1. Read `context/current.json` to get the current video URL
2. Fetch the transcript: `npm run --prefix skills/yt-research cli -- transcript "<url>"`
3. Read the cached transcript from `cache/youtube/{videoId}/transcript.md`
4. Answer the user's question grounded in the transcript content
5. Optionally save a summary to `notes/youtube/{videoId}.md`

Use the `/yt-research` slash command for batch operations and listing cached videos.

## Memory Protocol

After completing a significant task (fetching a transcript, writing a summary, answering a non-trivial question):
1. Append a JSON line to `memory/log.jsonl` recording what you did
2. If you wrote a new note, update `memory/index.md`

## Rules

- Proactively use your tools. Never tell the user you can't access page content.
- If `context/current.json` has a `selection` field, the user is asking about that specific text.
- Cache is disposable. Notes are valuable. Treat them accordingly.
- Do not ask the user to provide transcripts or URLs — read the context and fetch data yourself.
HEREDOC

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

# Kill any previous tmux session
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true

# Start Claude Code immediately in a tmux session.
# This way it connects to the MCP server right away, without waiting for a browser.
tmux new-session -d -s "$TMUX_SESSION" -x 200 -y 50 \
  "cd $WORK_DIR && \
   unset TERMINAL_EMULATOR __CFBundleIdentifier && \
   export ENABLE_IDE_INTEGRATION=true && \
   export BROWSERBUD_DATA_DIR=$WORK_DIR && \
   exec claude --ide"

# Hidden lock files are restored by server.js when Claude Code connects,
# and by the cleanup trap as a safety net.

# Start ttyd — just attaches to the existing tmux session
ttyd -W -p "$BROWSERBUD_TTYD_PORT" tmux attach -t "$TMUX_SESSION" 2>&1 &
TTYD_PID=$!

# Trap to clean up processes, tmux session, and restore any hidden lock files
cleanup() {
  echo "Shutting down..."
  kill $TTYD_PID $PROXY_PID 2>/dev/null
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  for f in "$IDE_DIR"/*.browserbud-hidden; do
    [ -f "$f" ] && mv "$f" "${f%.browserbud-hidden}" 2>/dev/null
  done
}
trap cleanup EXIT INT TERM

# Wait for processes (cleanup runs via EXIT trap)
wait $TTYD_PID $PROXY_PID
