#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK_DIR="$HOME/browse"
PORT_FILE="$HOME/.claude/ide/browserbud.port"

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

# Export data dir for server.js and skills
export BROWSERBUD_DATA_DIR="$WORK_DIR"

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

# Start ttyd with IDE integration env vars + data dir
ttyd -W -p 7681 bash -c "
  cd $WORK_DIR
  export CLAUDE_CODE_SSE_PORT=$MCP_PORT
  export ENABLE_IDE_INTEGRATION=true
  export BROWSERBUD_DATA_DIR=$WORK_DIR
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
