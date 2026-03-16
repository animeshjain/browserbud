# BrowserBud

## What is this?

BrowserBud is a browser extension that gives you a contextual AI terminal when browsing any website. It runs Claude Code in a full terminal on a Fly.io Sprite, exposed in the browser via ttyd. When you browse sites (currently YouTube), the page context is pushed to Claude Code's status line in real-time using the IDE integration protocol.

## Architecture

### Overview

```
┌─────────────────────────────────────────────────────────┐
│  Browser                                                │
│  ┌───────────────┐   ┌──────────────────────────────┐   │
│  │ YouTube tab   │   │ Side Panel (iframe)          │   │
│  │               │   │  ┌────────────────────────┐  │   │
│  │ content.ts ───┼───┤  │ ttyd → Claude Code     │  │   │
│  │ (captures     │   │  │                        │  │   │
│  │  page context)│   │  │ Status: youtube:<title>│  │   │
│  └───────────────┘   │  └────────────────────────┘  │   │
│         │            └──────────────────────────────┘   │
│         │ runtime.sendMessage                           │
│         ▼                                               │
│  ┌─────────────────┐                                    │
│  │ background.ts   │                                    │
│  │ (service worker) │                                   │
│  └────────┬────────┘                                    │
└───────────┼─────────────────────────────────────────────┘
            │ POST /api/context
            ▼
┌───────────────────────────────────────────────────────────┐
│  Sprite (aj-sprite)                                       │
│                                                           │
│  server.js (single Node process)                          │
│  ├── HTTP proxy (:8080) ──────────► ttyd (:7681)          │
│  │   └── /api/context endpoint                            │
│  │        writes context.json                             │
│  │        broadcasts selection_changed ──┐                │
│  │                                       ▼                │
│  └── MCP WebSocket server (:random) ──► Claude Code CLI   │
│       (IDE integration protocol)         (reads status)   │
└───────────────────────────────────────────────────────────┘
```

### Sprite Side (this machine)

`server.js` runs a single Node.js process with two servers:

1. **HTTP Proxy** (port 8080, externally accessible) — the only exposed port:
   - `POST /api/context` — receives browser context from the extension, writes to `~/browse/context/current.json`, and broadcasts to Claude Code via MCP
   - `GET /api/context` — reads current context
   - Everything else proxied to ttyd (HTTP + WebSocket)
   - CORS headers for the browser extension (`*` for now)

2. **MCP WebSocket Server** (random localhost port, internal only) — implements the Claude Code IDE integration protocol:
   - Writes a lock file to `~/.claude/ide/<port>.lock` so Claude Code discovers it
   - Handles the MCP handshake (`initialize`, `notifications/initialized`, `tools/list`)
   - Broadcasts `selection_changed` notifications when browser context changes
   - This is the same protocol used by the VS Code and JetBrains plugins

3. **ttyd** (port 7681, internal only) — serves Claude Code in a web terminal with `--dangerously-skip-permissions`

### Browser Extension

Built with **WXT** (wxt.dev), Chrome MV3 only for now.

- **Side panel** (`entrypoints/sidepanel/index.html`) — full-viewport iframe pointing to the sprite ttyd URL
- **Content script** (`entrypoints/content.ts`) — runs on YouTube, captures page title and URL. Listens for `yt-navigate-finish` events (YouTube SPA navigation). Responds to `getContext` messages from the background worker.
- **Background worker** (`entrypoints/background.ts`) — forwards context from content scripts to `POST /api/context`. Queries content scripts on tab switch. Clears context when switching to tabs without content scripts.

### Context Flow

1. User navigates to a YouTube video
2. Content script captures `{ site: "youtube", title: "<video title>", url: "<url>" }`
3. Content script sends message to background worker
4. Background worker POSTs to `https://aj-sprite-lgk.sprites.app/api/context`
5. Server writes context to `~/browse/context/current.json` and broadcasts `selection_changed` via MCP WebSocket
6. Claude Code receives the notification and updates its status line in real-time

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
│       │   └── index.html    # iframe to sprite URL
│       ├── background.ts     # Service worker, context forwarding
│       └── content.ts        # YouTube page context capture
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

## Sprite Details

- **Sprite name**: aj-sprite
- **Sprite URL**: https://aj-sprite-lgk.sprites.app
- **OS**: Ubuntu 25.04
- **Available tools**: Node.js, npm, Claude Code, git, ttyd
- **HTTP proxy port**: 8080 (only port exposed externally)
- **Auth**: public (for personal use)

## Development Workflow

1. **Sprite-side changes**: Edit files on this sprite via Claude Code, restart server with `start.sh`
2. **Push to GitHub**: `git push` from the sprite
3. **Extension changes**: Pull on local machine, `cd extension && npm install && npm run build`
4. **Load in Chrome**: `chrome://extensions` → Developer Mode → Load unpacked → `extension/.output/chrome-mv3/`
5. **Test**: Open YouTube, click BrowserBud icon for side panel, check status line updates

### Restarting the Server

```bash
# Kill existing processes
pkill -f 'ttyd|server.js'

# Option A: Use start.sh (manages startup order)
bash ~/browserbud/sprite/start.sh

# Option B: Manual (useful for debugging)
node ~/browserbud/sprite/server.js &
# Wait for MCP port, then:
MCP_PORT=$(cat ~/.claude/ide/browserbud.port)
ttyd -W -p 7681 bash -c "cd ~/browse && export CLAUDE_CODE_SSE_PORT=$MCP_PORT && export ENABLE_IDE_INTEGRATION=true && export BROWSERBUD_DATA_DIR=$HOME/browse && exec claude --dangerously-skip-permissions"
```

### Debugging

- **Server logs**: Check stdout of `server.js` — logs all MCP connections, disconnections, and broadcasts
- **Extension logs**: Chrome DevTools → background service worker console, or the YouTube tab console
- **Test context API**: `curl -X POST http://localhost:8080/api/context -H "Content-Type: application/json" -d '{"site":"youtube","title":"Test"}'`

## Skills

Skills give the Claude Code instance on the sprite domain-specific tools. Each skill is:

1. **A self-contained CLI** in `skills/<name>/` — a Node.js package with its own deps, invoked via `npm run --prefix skills/<name> cli -- <command>`
2. **A Claude Code command** in `.claude/commands/<name>.md` — documents the CLI and tells Claude when/how to use it. Exposes a `/name` slash command.

### How skills work at runtime

- The Claude Code instance (running in ttyd on the sprite) sees `.claude/commands/*.md` and gains the `/skill-name` slash commands.
- When a skill is relevant (e.g. user is on YouTube → use yt-research), Claude invokes the CLI via bash.
- Skills cache their output to `~/browse/cache/<site>/` (controlled by `BROWSERBUD_DATA_DIR` env var).
- API keys live in `skills/<name>/.env` (gitignored).

### Adding a new skill

1. Create `skills/<new-skill>/` with a CLI entry point and `package.json`
2. Create `.claude/commands/<new-skill>.md` documenting the CLI and workflow
3. Run `npm install` in the skill directory on the sprite
4. Add the `.env` with any required API keys on the sprite
5. Add permission rules to `.claude/settings.local.json` if needed

### Available skills

| Skill | Description | Trigger |
|-------|-------------|---------|
| `yt-research` | Fetch YouTube transcripts & metadata | User is on a YouTube video page |

## Key Decisions

- Single sprite, single user (personal project)
- WXT for browser extension framework
- ttyd for terminal rendering in the browser
- MCP WebSocket protocol for real-time Claude Code status line updates (same protocol as VS Code/JetBrains plugins)
- `~/browse/context/current.json` as the context store (Claude Code reads it directly)
- Content scripts are per-site (YouTube first, more can be added)
- Skills are self-contained CLI packages, not MCP servers — simpler to develop and debug

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

- [x] Set up sprite server (ttyd + proxy)
- [x] Scaffold WXT extension with side panel
- [x] Build content script for YouTube context capture
- [x] Build background worker to POST context
- [x] Implement MCP WebSocket server for real-time status line
- [ ] Investigate MCP disconnect issue (Claude Code disconnects after reading context)
- [ ] Add more site integrations (GitHub, docs sites, etc.)
- [ ] Add context to Claude Code's system prompt (not just status line)
- [ ] Persist MCP connection across page navigations
