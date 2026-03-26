# MCP IDE Integration & Status Line

How BrowserBud connects to Claude Code's IDE integration protocol to push browser context onto the status line in real time.

## Background

Claude Code has an IDE integration protocol (used by VS Code and JetBrains plugins) that lets external tools push contextual information — like the currently open file or selected text — into the Claude Code UI. BrowserBud uses this same protocol to show the current browser page (site + title) on the status line and pass the URL as the "file path".

The protocol is MCP (Model Context Protocol) over WebSocket, using JSON-RPC 2.0 messages.

## Discovery: lock files

Claude Code discovers IDE integrations by scanning `~/.claude/ide/*.lock` files at startup. Each lock file is named `<port>.lock` and contains:

```json
{
  "workspaceFolders": ["/path/to/workspace"],
  "pid": 12345,
  "ideName": "BrowserBud",
  "transport": "ws",
  "runningInWindows": false,
  "authToken": "<uuid>"
}
```

Key fields:
- **`workspaceFolders`** — directories the IDE has open; Claude Code uses this for matching
- **`transport`** — must be `"ws"` for WebSocket
- **`authToken`** — shared secret; Claude Code sends this as `x-claude-code-ide-authorization` header on the WebSocket upgrade request
- **`pid`** — process ID of the server (for stale lock file detection)

On startup, Claude Code reads all lock files, connects to each server's WebSocket on `127.0.0.1:<port>`, and authenticates using the token from the lock file.

### `--ide` flag

Claude Code accepts `--ide` which auto-connects to an IDE server on startup **if exactly one valid lock file exists**. BrowserBud launches Claude Code with this flag to trigger automatic connection.

### `CLAUDE_CODE_SSE_PORT` (does not work)

There is a `CLAUDE_CODE_SSE_PORT` env var. Despite its name, setting it to our MCP port does not cause Claude Code to connect. Lock file discovery is the only reliable mechanism.

### Competing lock files

If other IDEs (e.g., IntelliJ) also have lock files in `~/.claude/ide/`, Claude Code may connect to them instead of BrowserBud. Even with `--ide` and correct workspace matching, multiple lock files cause unreliable behavior.

BrowserBud handles this with a hide-and-restore strategy:

1. **On startup** (`start.sh`): rename competing `*.lock` files to `*.lock.browserbud-hidden` so Claude Code only discovers BrowserBud's lock file
2. **On MCP connect** (`server.js`): as soon as Claude Code connects to BrowserBud's MCP server, immediately restore the hidden lock files
3. **On shutdown** (cleanup trap): restore any remaining hidden lock files as a safety net

This means other IDE integrations are disrupted only for the few seconds between BrowserBud starting and Claude Code connecting — typically 1-2 seconds.

### Workspace path matching

The lock file's `workspaceFolders` must match Claude Code's working directory. BrowserBud resolves the data directory with `pwd -P` in `start.sh` to eliminate symlink ambiguity (e.g., `~/data-browse/.claude` symlinks to `~/Projects/browserbud/.claude`, which could confuse matching).

## Connection flow

```
1. start.sh hides competing IDE lock files
2. server.js starts MCP WebSocket server on a random localhost port
3. server.js writes lock file to ~/.claude/ide/<port>.lock
4. start.sh launches Claude Code in a tmux session with --ide flag
5. Claude Code scans ~/.claude/ide/*.lock, finds only BrowserBud's lock file
6. Claude Code opens WebSocket to 127.0.0.1:<port> with auth token header
7. MCP handshake (initialize → initialized → tools/list)
8. server.js detects connection → restores hidden IDE lock files
9. After 500ms delay, server replays the current browser context
10. Status line updates — connection fully established
```

## MCP handshake

After the WebSocket connects, Claude Code sends three messages:

### 1. `initialize`

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": { ... }
}
```

Server responds with capabilities:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": { "tools": { "listChanged": true } },
    "serverInfo": { "name": "browserbud", "version": "0.1.0" }
  }
}
```

### 2. `notifications/initialized`

No response needed.

### 3. `tools/list`

Server returns an empty tools list (BrowserBud doesn't expose MCP tools):

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": { "tools": [] }
}
```

## Pushing context: `selection_changed`

After the handshake, the server can push `selection_changed` notifications at any time. This is how browser context reaches the status line.

```json
{
  "jsonrpc": "2.0",
  "method": "selection_changed",
  "params": {
    "text": "youtube: Never Gonna Give You Up",
    "filePath": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "fileUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "selection": {
      "start": { "line": 0, "character": 0 },
      "end": { "line": 0, "character": 0 },
      "isEmpty": true
    }
  }
}
```

What shows up on the status line:
- **Left side**: `text` field — BrowserBud formats this as `<site>: <title>`
- **Right side**: `filePath` field — the page URL

When context is cleared (user navigates away from a tracked site), the server sends an empty `text` and `filePath` to clear the status line.

### Context replay

A race condition exists on startup: the browser extension sends page context before Claude Code has finished its MCP handshake, so the broadcast reaches zero clients. To handle this:

1. The server keeps the latest context in memory (`lastContext`), loaded from `context/current.json` on startup
2. The extension re-sends the active tab's context when its WebSocket connects to the server
3. After `tools/list` completes (final handshake step), the server waits 500ms then pushes the current context to the newly connected client
4. The 500ms delay is necessary because Claude Code doesn't process incoming notifications until it has fully consumed the handshake responses

Only "ready" clients (those that have completed the handshake) receive ongoing context broadcasts.

## Why tmux?

Claude Code only scans lock files at startup. If Claude Code starts *after* the lock file is written, it discovers and connects immediately. But ttyd only spawns its command when a browser client connects to the web terminal — meaning Claude Code wouldn't start (or connect to MCP) until the user opens the side panel.

Using tmux solves this: `start.sh` launches Claude Code in a detached tmux session immediately, so it discovers the lock file and connects to the MCP server right away. ttyd then just attaches to the existing tmux session when the user opens the side panel.

## Code references

- **MCP server**: `server/server.js` — `startMcpServer()`, `handleMcpMessage()`, `broadcastSelection()`
- **Context replay**: `server/server.js` — `maybeSendCurrentContext()`, `lastContext`, `readyClients`
- **Lock file write/cleanup**: `server/server.js` — lock file in `startMcpServer()`, removal in `removeLockFile()`
- **Lock file hiding**: `server/start.sh` — hides competing IDE lock files before starting Claude Code
- **Lock file restore**: `server/server.js` — `restoreHiddenLockFiles()`, called on first MCP connection
- **Context source**: `extension/entrypoints/content.ts` → `background.ts` → `POST /api/context` → `broadcastSelection()`
- **Initial context send**: `extension/entrypoints/background.ts` — queries active tab on WebSocket connect

## Debugging

Set `BROWSERBUD_LOG_LEVEL=debug` in `.env` to see MCP handshake messages, auth attempts, broadcast details, and HTTP request timing.

Key things to look for in logs:
- **`"msg":"server ready"`** — all services listening, with startup duration (`ms`)
- **`"msg":"Claude Code connected"`** — MCP WebSocket established
- **`"msg":"replaying context"`** — context being sent after handshake, shows what will appear on status line
- **`"clients":N`** in context broadcasts — if 0, Claude Code isn't connected
- **`"ms":N`** on HTTP requests — timing for proxy, bridge injection, and token endpoints

```bash
# Check lock files
ls -la ~/.claude/ide/*.lock ~/.claude/ide/*.browserbud-hidden 2>/dev/null

# Verify lock file contents
cat ~/.claude/ide/<port>.lock | python3 -m json.tool

# Test context broadcast
curl -X POST http://localhost:8989/api/context \
  -H "Content-Type: application/json" \
  -d '{"site":"youtube","title":"Test","url":"https://youtube.com/watch?v=test"}'

# Check Claude Code's network connections
lsof -a -i -P -n -p $(pgrep -f 'exec claude') 2>/dev/null | grep 127.0.0.1
```
