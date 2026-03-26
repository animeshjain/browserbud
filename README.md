# BrowserBud

A browser extension that puts Claude Code in your side panel, connected to what you're browsing.

## Why

I pay for Claude Code subscription. I use it for coding, but I am left with a lot of tokens every week that go unused.
I was doing some research on youtube, and wanted to summarize and ask questions about videos. That's how the idea of 
this extension came. 

BrowserBud puts Claude Code in a browser side panel and feeds it context about whatever page you're on. As you 
browse, the context of the page is automatically sent to claude code. No copy-pasting URLs, no tab-switching to a 
chat window.

Everything BrowserBud produces - summaries, notes, transcripts - goes to a local folder (`~/.browserbud/data/`) on
your machine. Since Claude Code runs in that same folder, it can reference past research. Ask it to compare things you
looked at last week, pull together notes from different sessions, or build on previous summaries. Your research
compounds instead of disappearing into a chat log.

Say you're researching marketing tools. You watch a few YouTube reviews, read some blog posts, check a Reddit thread.
For each one, you ask BrowserBud to summarize what matters. A few days later you ask "which of the tools I've looked
at would be best for a bootstrapped startup?" - it reads its own notes and gives you a real answer.

The first version has YouTube-specific features (transcript extraction, video frame capture, comment analysis) but
works on any page. More site-specific integrations are coming.

## What it does

- Runs Claude Code in a browser side panel via a terminal (ttyd)
- Pushes your current page context (title, URL, selected text) to Claude Code in real time
- Saves all output (summaries, notes, analysis) to `~/.browserbud/data/` - a local folder Claude Code can read back later
- Works on any page: ask about articles, docs, forum threads, whatever you're reading
- On YouTube: extracts transcripts, captures video frames, reads comments
- Skills system: domain-specific CLI tools Claude Code can call on its own (YouTube research is the first)

## How it works

```
Browser side panel <-- iframe --> ttyd (localhost:8989) --> Claude Code CLI
                                       ^
YouTube tab --> content script --> background worker --> server --> MCP --> Claude Code status line
                                                              \-> WebSocket --> extension (on-demand transcript extraction)
```

A local Node server (`server/server.js`) ties everything together. It proxies ttyd, receives page context from the
extension, broadcasts it to Claude Code via the MCP IDE integration protocol, and brokers commands between CLI skills
and the browser.

[CLAUDE.md](CLAUDE.md) has the full architecture. [docs/](docs/) has deep dives on specific subsystems.

## Quick Start (Docker)

Docker is the recommended setup — works on macOS, Linux, and Windows with a single command.

**Prerequisites:** [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or [Podman Desktop](https://podman-desktop.io/)).

```bash
# Clone and start
git clone https://github.com/animeshjain/browserbud.git
cd browserbud
docker compose up
```

On first run, Claude Code will show a login URL in the terminal. The extension detects it and shows a clickable banner — authenticate once and you're set. Credentials persist in `~/.browserbud/` across restarts.

Install the browser extension, open any webpage, click the BrowserBud icon — Claude Code appears in the side panel connected to `http://localhost:8989`.

All data lives in `~/.browserbud/` on your host machine:
- `~/.browserbud/claude-config/` — Claude Code credentials and settings
- `~/.browserbud/data/` — notes, cache, context (Claude Code's working directory)

See [docs/docker-setup.md](docs/docker-setup.md) for details on volumes, API keys, and platform-specific notes.

## Setup (Native)

If you prefer running without Docker:

### Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [ttyd](https://github.com/tsl0922/ttyd#installation)
- [tmux](https://github.com/tmux/tmux#installation)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/overview)
- Chrome or Firefox

```bash
git clone https://github.com/animeshjain/browserbud.git
cd browserbud

# Install all dependencies (server, extension, skills)
npm run setup

# Build the browser extension
npm run build:extension

# (Optional) Configure data directory and API keys for server-side transcript fallback
cp .env.example .env
# Edit .env - see .env.example for available options
```

### Load the extension

**Chrome:**

1. `chrome://extensions`
2. Enable "Developer mode"
3. "Load unpacked" -> select `extension/dist/chrome-mv3/`

**Firefox:**

1. `about:debugging#/runtime/this-firefox`
2. "Load Temporary Add-on" -> select `extension/dist/firefox-mv2/manifest.json`

### Start the server

```bash
npm start
```

This starts the proxy, waits for the MCP port, and launches ttyd with Claude Code. It creates a working directory at
`~/browse/` with folders for context, cache, and notes.

### Connect

1. Click the BrowserBud icon to open the side panel
2. Enter `http://localhost:8989` as the server URL
3. Claude Code appears in the side panel

Go to a YouTube video. Claude Code's status line updates with the video title. Ask it to summarize the video - it
fetches the transcript and responds.

## Project structure

```
server/           Local server (Node.js proxy + MCP + extension WebSocket)
extension/        WXT browser extension (Chrome MV3 / Firefox MV2)
skills/           CLI tools Claude Code can invoke
  yt-research/    YouTube transcript fetching and analysis
docs/             Dev guides
.claude/          Claude Code commands and settings
```

## Current state

Single-user personal tool, everything runs locally. YouTube is the first site integration. The architecture supports
adding more sites (GitHub, docs, etc.) by writing new content scripts.

Transcript extraction happens client-side from the browser extension first (free, using YouTube's own player APIs),
falling back to paid APIs only when that fails.
