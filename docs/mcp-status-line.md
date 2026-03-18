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

### Competing lock files

If other IDEs (e.g., IntelliJ) have lock files in `~/.claude/ide/`, Claude Code may connect to them instead of (or in addition to) BrowserBud. BrowserBud's `start.sh` handles this by temporarily hiding other lock files during Claude Code startup, then restoring them after a few seconds.

## Connection flow

```
1. server.js starts MCP WebSocket server on a random localhost port
2. server.js writes lock file to ~/.claude/ide/<port>.lock
3. start.sh launches Claude Code in a tmux session
4. Claude Code scans ~/.claude/ide/*.lock, finds BrowserBud's lock file
5. Claude Code opens WebSocket to 127.0.0.1:<port> with auth token header
6. MCP handshake (initialize → initialized → tools/list)
7. Connection established — server can now push notifications
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

## Why tmux?

Claude Code only scans lock files at startup. If Claude Code starts *after* the lock file is written, it discovers and connects immediately. But ttyd only spawns its command when a browser client connects to the web terminal — meaning Claude Code wouldn't start (or connect to MCP) until the user opens the side panel.

Using tmux solves this: `start.sh` launches Claude Code in a detached tmux session immediately, so it discovers the lock file and connects to the MCP server right away. ttyd then just attaches to the existing tmux session when the user opens the side panel.

## Code references

- **MCP server**: `sprite/server.js` — `startMcpServer()`, `handleMcpMessage()`, `broadcastSelection()`
- **Lock file write/cleanup**: `sprite/server.js` — lock file in `startMcpServer()`, removal in `removeLockFile()`
- **Lock file hiding**: `sprite/start.sh` — hides competing IDE lock files during startup
- **Context source**: `extension/entrypoints/content.ts` → `background.ts` → `POST /api/context` → `broadcastSelection()`

## Debugging

Set `BROWSERBUD_LOG_LEVEL=debug` in `.env` to see MCP handshake messages, auth attempts, and broadcast details.

Check connection status:
```bash
# See if Claude Code is connected to the MCP server
lsof -a -i -P -n -p $(pgrep -f 'exec claude') 2>/dev/null | grep 127.0.0.1

# Check lock files
ls -la ~/.claude/ide/*.lock
cat ~/.claude/ide/<port>.lock | python3 -m json.tool

# Test context broadcast
curl -X POST http://localhost:8989/api/context \
  -H "Content-Type: application/json" \
  -d '{"site":"youtube","title":"Test","url":"https://youtube.com/watch?v=test"}'
```
