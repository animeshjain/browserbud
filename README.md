# BrowserBud

A browser extension that puts Claude Code in your side panel, connected to what you're browsing.

## Why

I pay for Claude Code subscription. I use it for coding, but I am left with a lot of tokens every week that go unused.
I was doing some research on youtube, and wanted to summarize and ask questions about videos. That's how the idea of 
this extension came. 

BrowserBud puts Claude Code in a browser side panel and feeds it context about whatever page you're on. As you 
browse, the context of the page is automatically sent to claude code. No copy-pasting URLs, no tab-switching to a 
chat window.

Plan is to make it work well for all sites, but handle some specific use cases well to make it more powerful. So the 
first version has some nice youtube integration. It can extract transcripts, easily take video frames into context 
for asking questions about infographics / charts in the video, and analyze comments (coming soon).

Will update here as I polish this a bit more.

## What it does

- Runs Claude Code in a browser side panel via a terminal (ttyd)
- Pushes your current page context (title, URL) to Claude Code's status line in real time
- On YouTube: extracts transcripts directly from the page so Claude can summarize, explain, or answer questions about
  videos
- Skills system: domain-specific CLI tools Claude Code can call on its own (YouTube research is the first)

## How it works

```
Browser side panel <-- iframe --> ttyd (localhost:8989) --> Claude Code CLI
                                       ^
YouTube tab --> content script --> background worker --> server --> MCP --> Claude Code status line
                                                              \-> WebSocket --> extension (on-demand transcript extraction)
```

A local Node server (`sprite/server.js`) ties everything together. It proxies ttyd, receives page context from the
extension, broadcasts it to Claude Code via the MCP IDE integration protocol, and brokers commands between CLI skills
and the browser.

[CLAUDE.md](CLAUDE.md) has the full architecture. [docs/](docs/) has deep dives on specific subsystems.

## Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [ttyd](https://github.com/tsl0922/ttyd#installation)
- [tmux](https://github.com/tmux/tmux#installation)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/overview)
- Chrome or Firefox

## Setup

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
3. "Load unpacked" -> select `extension/.output/chrome-mv3/`

**Firefox:**

1. `about:debugging#/runtime/this-firefox`
2. "Load Temporary Add-on" -> select any file in `extension/.output/firefox-mv2/`

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
sprite/           Local server (Node.js proxy + MCP + extension WebSocket)
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
