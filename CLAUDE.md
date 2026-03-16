# BrowserBud

## What is this?

BrowserBud is a browser extension that gives you a contextual AI terminal when browsing any website. It runs Claude Code in a full terminal on a Fly.io Sprite, exposed in the browser via ttyd.

## Architecture

### Sprite Side (this machine)
Two processes behind a single proxy on port 8080 (the Sprites HTTP proxy port):

1. **Proxy server** (port 8080) — Node.js HTTP server that:
   - Routes `/api/context` POST/GET to a context handler (writes/reads browser context to a file)
   - Proxies everything else (HTTP + WebSocket) to ttyd
   - Handles CORS for the browser extension

2. **ttyd** (port 7681) — serves Claude Code in a web terminal

### Browser Extension
Built with **WXT** (wxt.dev) for cross-browser support (Chrome + Firefox).

- **Side panel**: iframe pointing to the sprite ttyd URL
- **Content script**: captures page context (URL, title, selected text, console errors)
- **Background worker**: sends context to the sprite `/api/context` endpoint

### Context Flow
1. User browses a site
2. Extension captures page context (URL, title, selection)
3. Extension POSTs context to `https://aj-sprite-lgk.sprites.app/api/context`
4. Proxy server writes context to `/home/sprite/browserbud/context.json`
5. Claude Code (running in ttyd) can read `context.json` for awareness of what the user is looking at

## Project Structure

```
browserbud/
├── CLAUDE.md              # This file
├── sprite/
│   ├── server.js          # Proxy server (ttyd + context API)
│   ├── package.json       # Node deps (http-proxy)
│   └── start.sh           # Starts ttyd + proxy server
├── extension/             # WXT browser extension project
│   ├── wxt.config.ts
│   ├── entrypoints/
│   │   ├── sidepanel/     # Side panel with ttyd iframe
│   │   ├── background.ts  # Service worker — sends context to sprite
│   │   └── content.ts     # Content script — captures page context
│   └── package.json
└── package.json            # Monorepo root (if needed)
```

## Sprite Details

- **Sprite name**: aj-sprite
- **Sprite URL**: https://aj-sprite-lgk.sprites.app
- **OS**: Ubuntu 25.04
- **Available tools**: Node.js, npm, Claude Code, git
- **HTTP proxy port**: 8080 (only port exposed externally)
- **Auth**: sprite-level auth (can be toggled to public via `sprite url -s aj-sprite update --auth public`)

## Development Workflow

1. Develop on this sprite using Claude Code (with --dangerously-skip-permissions)
2. Push to GitHub: git@github.com:animeshjain/browserbud.git
3. Pull extension code on local machine
4. Load unpacked extension in browser for testing
5. Extension connects back to this sprite

## Key Decisions

- Single sprite (personal project, one user)
- WXT for cross-browser extension support
- Simple file-based context bridge (context.json) — can upgrade to MCP later
- ttyd for terminal rendering in the browser
- No auth complexity for now (personal use)

## TODO

- [ ] Set up sprite server (ttyd + proxy)
- [ ] Scaffold WXT extension
- [ ] Build side panel with ttyd iframe
- [ ] Build content script for context capture
- [ ] Build background worker to POST context
- [ ] Test end-to-end
