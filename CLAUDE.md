# BrowserBud

## What is this?

BrowserBud is a browser extension that gives you a contextual AI terminal when browsing any website. It runs Claude Code in a full terminal locally via ttyd, exposed in the browser side panel. When you browse sites (currently YouTube), the page context is pushed to Claude Code's status line in real-time using the IDE integration protocol. The extension can also type directly into the Claude Code terminal input via a postMessage bridge.

## Architecture

### Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Browser                                                    │
│  ┌───────────────┐   ┌───────────────────────────────────┐  │
│  │ YouTube tab   │   │ Side Panel                        │  │
│  │               │   │  ┌─────────────────────────────┐  │  │
│  │ content.ts ───┼───┤  │ iframe → ttyd → Claude Code │  │  │
│  │ (captures     │   │  │                             │  │  │
│  │  page context)│   │  │ Status: youtube:<title>     │  │  │
│  └───────────────┘   │  └──────────▲──────────────────┘  │  │
│         │            │             │ postMessage          │  │
│         │            │       main.ts (typeInTerminal)     │  │
│         │            └───────────────────────────────────┘  │
│         │ runtime.sendMessage                               │
│         ▼                                                   │
│  ┌─────────────────┐                                        │
│  │ background.ts   │                                        │
│  │ (service worker) │                                       │
│  └────────┬────────┘                                        │
└───────────┼─────────────────────────────────────────────────┘
            │ POST /api/context
            ▼
┌───────────────────────────────────────────────────────────┐
│  Local Server                                             │
│                                                           │
│  server.js (single Node process)                          │
│  ├── HTTP proxy (:8989) ──────────► ttyd (:7682)          │
│  │   ├── /api/context endpoint                            │
│  │   │    writes context.json                             │
│  │   │    broadcasts selection_changed ──┐                │
│  │   ├── / (root) injects bridge script  │                │
│  │   └── /browserbud-bridge.js           │                │
│  │        (postMessage → ttyd WebSocket) │                │
│  │                                       ▼                │
│  └── MCP WebSocket server (:random) ──► Claude Code CLI   │
│       (IDE integration protocol)         (reads status)   │
└───────────────────────────────────────────────────────────┘
```

### Local Server

`server.js` runs a single Node.js process with two servers:

1. **HTTP Proxy** (port 8989, configurable via `BROWSERBUD_PORT`) — the entry point for the browser extension:
   - `POST /api/context` — receives browser context from the extension, writes to `~/browse/context/current.json`, and broadcasts to Claude Code via MCP
   - `GET /api/context` — reads current context
   - `GET /` — fetches ttyd's root HTML and injects the terminal bridge script (`browserbud-bridge.js`) before serving
   - `GET /browserbud-bridge.js` — serves the bridge script that captures ttyd's WebSocket and listens for `postMessage` input
   - Everything else proxied to ttyd (HTTP + WebSocket)
   - CORS headers for the browser extension (`*` for now)

2. **MCP WebSocket Server** (random localhost port, internal only) — implements the Claude Code IDE integration protocol:
   - Writes port to `~/.claude/ide/browserbud.port` so `start.sh` can pass it to ttyd
   - Handles the MCP handshake (`initialize`, `notifications/initialized`, `tools/list`)
   - Broadcasts `selection_changed` notifications when browser context changes
   - This is the same protocol used by the VS Code and JetBrains plugins

3. **ttyd** (port 7682, configurable via `BROWSERBUD_TTYD_PORT`, internal only) — serves Claude Code in a web terminal

4. **Terminal Bridge** — injected into the ttyd page by the proxy:
   - Monkey-patches `WebSocket` to capture ttyd's connection
   - Listens for `postMessage` events with type `browserbud:type-text`
   - Writes text to ttyd's WebSocket using its binary protocol (byte 0 = CMD_INPUT + text bytes)
   - Enables the extension to programmatically type into Claude Code's input (similar to how IDE extensions like VS Code/JetBrains inject file references)

### Browser Extension

Built with **WXT** (wxt.dev), Chrome MV3 only for now.

- **Side panel** (`entrypoints/sidepanel/`) — full-viewport iframe pointing to the server URL (user-configured). `main.ts` exposes `typeInTerminal(text)` which uses `postMessage` to the ttyd iframe via the bridge script. Listens for `typeInTerminal` messages from other extension components via `browser.runtime.onMessage`.
- **Content script** (`entrypoints/content.ts`) — runs on YouTube, captures page title and URL. Listens for `yt-navigate-finish` events (YouTube SPA navigation). Responds to `getContext` messages from the background worker.
- **Background worker** (`entrypoints/background.ts`) — forwards context from content scripts to `POST /api/context`. Queries content scripts on tab switch. Clears context when switching to tabs without content scripts.

### Context Flow

1. User navigates to a YouTube video
2. Content script captures `{ site: "youtube", title: "<video title>", url: "<url>" }`
3. Content script sends message to background worker
4. Background worker POSTs to the configured server URL `/api/context`
5. Server writes context to `~/browse/context/current.json` and broadcasts `selection_changed` via MCP WebSocket
6. Claude Code receives the notification and updates its status line in real-time

### Terminal Input Flow

The extension can type text directly into the Claude Code terminal input:

1. Any extension component calls `browser.runtime.sendMessage({ type: "typeInTerminal", text: "..." })`
2. Side panel's `main.ts` receives the message
3. Side panel calls `postMessage({ type: "browserbud:type-text", text })` on the ttyd iframe
4. Bridge script (injected into ttyd's page by the proxy) receives the message
5. Bridge writes the text to ttyd's WebSocket as terminal input
6. Text appears in Claude Code's input as if the user typed it

### Startup Sequence

`start.sh` manages the startup order:

1. Starts `server.js` (proxy + MCP server)
2. Waits for MCP port file to appear (`~/.claude/ide/browserbud.port`)
3. Starts ttyd with `CLAUDE_CODE_SSE_PORT` and `ENABLE_IDE_INTEGRATION=true` env vars so Claude Code auto-connects to the MCP server

## Project Structure

```
browserbud/                   # Code repo (development only)
├── CLAUDE.md                 # This file
├── sprite/
│   ├── server.js             # Proxy + MCP server (main process)
│   ├── start.sh              # Startup script (server → ttyd)
│   ├── package.json          # Deps: http-proxy, ws, uuid
│   └── .gitignore
├── skills/                   # Skills = CLI tools + Claude Code command definitions
│   └── yt-research/          # YouTube transcript fetching & analysis
│       ├── index.ts          # CLI entry point
│       ├── transcript.ts     # Transcript fetching (Supadata + ScrapeCreators)
│       ├── video_meta.ts     # Video metadata fetching
│       ├── cache.ts          # File-based caching
│       ├── formatter.ts      # Output formatting
│       ├── url_parser.ts     # YouTube URL parsing
│       ├── types.ts          # TypeScript interfaces
│       ├── config.ts         # Env config (reads BROWSERBUD_DATA_DIR)
│       ├── package.json
│       └── .env              # API keys (gitignored)
├── .claude/
│   ├── commands/
│   │   └── yt-research.md    # Skill definition → exposes /yt-research command
│   └── settings.local.json
├── extension/                # WXT browser extension
│   ├── wxt.config.ts         # WXT config, manifest permissions
│   ├── tsconfig.json
│   ├── package.json          # Dep: wxt
│   ├── .gitignore
│   └── entrypoints/
│       ├── sidepanel/
│       │   ├── index.html    # iframe to server URL
│       │   └── main.ts       # typeInTerminal(), message listener
│       ├── background.ts     # Service worker, context forwarding
│       ├── content.ts        # YouTube page context capture
│       └── youtube-player.ts # MAIN world script, transcript extraction
└── ~/.claude/
    ├── settings.json          # Status line config (statusline.sh)
    └── ide/
        ├── <port>.lock        # MCP server lock file (auto-generated)
        └── browserbud.port    # Port number for start.sh (auto-generated)

~/browse/                     # Userland directory (where Claude Code runs)
├── CLAUDE.md                 # AI instructions (generated by start.sh)
├── .claude/                  # Symlink → ~/browserbud/.claude
├── skills/                   # Symlink → ~/browserbud/skills
├── context/
│   └── current.json          # Live browser context (written by server.js)
├── cache/
│   └── youtube/
│       └── {videoId}/        # Cached transcripts, metadata
├── notes/
│   ├── youtube/
│   │   └── {videoId}.md      # Per-video summaries, analysis
│   └── topics/
│       └── {topic-slug}.md   # Cross-video topic notes
└── memory/
    ├── index.md              # Curated knowledge index
    └── log.jsonl             # Append-only event log
```

## Server Details

- **Runtime**: Node.js (local machine)
- **HTTP proxy port**: 8989 (configurable via `BROWSERBUD_PORT` env var)
- **ttyd port**: 7682 (configurable via `BROWSERBUD_TTYD_PORT`, internal, proxied through the server port)
- **Server URL**: Configurable in the extension (defaults to `http://localhost:8989`)

## Development Workflow

1. **Server changes**: Edit `sprite/server.js`, restart with `start.sh`
2. **Extension changes**: `cd extension && npm install && npm run build`
3. **Load in Chrome**: `chrome://extensions` → Developer Mode → Load unpacked → `extension/dist/chrome-mv3/`
4. **Test**: Open YouTube, click BrowserBud icon for side panel, check status line updates

### Restarting the Server

```bash
# Kill existing processes
pkill -f 'ttyd|server.js'

# Option A: Use start.sh (manages startup order)
bash sprite/start.sh

# Option B: Manual (useful for debugging)
node sprite/server.js &
# Wait for MCP port, then:
MCP_PORT=$(cat ~/.claude/ide/browserbud.port)
BROWSERBUD_DATA_DIR=$HOME/browse CLAUDE_CODE_SSE_PORT=$MCP_PORT ENABLE_IDE_INTEGRATION=true \
  ttyd -W -p 7682 bash -c "cd ~/browse && exec claude --dangerously-skip-permissions"
```

### Debugging

- **Server logs**: Check stdout of `server.js` — logs all MCP connections, disconnections, and broadcasts
- **Extension logs**: Chrome DevTools → background service worker console, or the YouTube tab console
- **Test context API**: `curl -X POST http://localhost:8989/api/context -H "Content-Type: application/json" -d '{"site":"youtube","title":"Test"}'`

## Skills

Skills give the Claude Code instance domain-specific tools. Each skill is:

1. **A self-contained CLI** in `skills/<name>/` — a Node.js package with its own deps, invoked via `npm run --prefix skills/<name> cli -- <command>`
2. **A Claude Code command** in `.claude/commands/<name>.md` — documents the CLI and tells Claude when/how to use it. Exposes a `/name` slash command.

### How skills work at runtime

- The Claude Code instance (running in ttyd) sees `.claude/commands/*.md` and gains the `/skill-name` slash commands.
- When a skill is relevant (e.g. user is on YouTube → use yt-research), Claude invokes the CLI via bash.
- Skills cache their output to `~/browse/cache/<site>/` (controlled by `BROWSERBUD_DATA_DIR` env var).
- API keys live in `skills/<name>/.env` (gitignored).

### Adding a new skill

1. Create `skills/<new-skill>/` with a CLI entry point and `package.json`
2. Create `.claude/commands/<new-skill>.md` documenting the CLI and workflow
3. Run `npm install` in the skill directory
4. Add the `.env` with any required API keys
5. Add permission rules to `.claude/settings.local.json` if needed

### Available skills

| Skill | Description | Trigger |
|-------|-------------|---------|
| `yt-research` | Fetch YouTube transcripts & metadata | User is on a YouTube video page |

## Key Decisions

- Local server, single user (personal project)
- WXT for browser extension framework
- ttyd for terminal rendering in the browser
- MCP WebSocket protocol for real-time Claude Code status line updates (same protocol as VS Code/JetBrains plugins)
- `~/browse/context/current.json` as the context store (Claude Code reads it directly)
- Content scripts are per-site (YouTube first, more can be added)
- Skills are self-contained CLI packages, not MCP servers — simpler to develop and debug
- Terminal input injection via proxy-injected bridge script + postMessage (same pattern as IDE extensions using native terminal APIs)

## Adding a New Site Integration

To add context capture for a new site:

1. Create or update `extension/entrypoints/content.ts` (or add a new content script)
2. Add the site's URL pattern to `matches` in the content script definition
3. Implement `getContext()` to return `{ site: "<name>", title: "<relevant info>", url }`
4. The background worker, server, and MCP broadcast are generic — no changes needed

## Known Issues

- Claude Code may need `/ide` → select BrowserBud to connect if auto-connect doesn't trigger
- YouTube SPA navigation detection uses `yt-navigate-finish` event with a 1.5s delay for title update
- Status line only shows context after Claude Code connects to the MCP server (requires ttyd session restart if server restarts)

## TODO

- [x] Set up server (ttyd + proxy)
- [x] Scaffold WXT extension with side panel
- [x] Build content script for YouTube context capture
- [x] Build background worker to POST context
- [x] Implement MCP WebSocket server for real-time status line
- [x] Terminal bridge — extension can type into Claude Code input via postMessage
- [ ] Screenshot capture — capture YouTube video frame and send to Claude Code
- [ ] Investigate MCP disconnect issue (Claude Code disconnects after reading context)
- [ ] Add more site integrations (GitHub, docs sites, etc.)
- [ ] Add context to Claude Code's system prompt (not just status line)
- [ ] Persist MCP connection across page navigations
