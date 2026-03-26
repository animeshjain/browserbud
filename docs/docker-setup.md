# BrowserBud Docker Setup — Design Document

**Status**: Draft v2 (post-review)
**Date**: 2026-03-26

## Goal

Replace the current multi-tool native install (`node + ttyd + tmux + bash`) with a single `docker compose up` command that works on macOS, Linux, and Windows. Ship the extension as an installable artifact so the full setup is two steps, not five.

## Current Setup (Native)

Today, running BrowserBud requires:

1. Node.js v20+
2. ttyd (web terminal — `brew install ttyd`)
3. tmux (terminal multiplexer — `brew install tmux`)
4. Claude Code CLI (`npm i -g @anthropic-ai/claude-code` or native installer)
5. Run `bash server/start.sh`
6. Manually load the extension in developer mode (`chrome://extensions`)

This only works on macOS/Linux. Windows has no native tmux, ttyd is less tested, and `start.sh` is deeply Unix-specific.

## Proposed Setup (Docker) — V1

```bash
# Every time: start BrowserBud
git clone https://github.com/animeshjain/browserbud.git
cd browserbud
docker compose up

# First run: Claude Code shows a login URL in the terminal.
# The extension detects it and shows a clickable banner.
# Authenticate once — credentials persist in ~/.browserbud/

# One-time: install browser extension
# Firefox: setup script installs signed .xpi silently
# Chrome: open CWS link, click "Add to Chrome"
```

V1 must include:
- **Pre-built multi-arch Docker image** (GHCR or Docker Hub) — so users don't need to clone the repo or build locally
- **Published browser extension** — Firefox (self-hosted signed .xpi, auto-installable) and Chrome Web Store (unlisted or listed)
- **One canonical Windows path** — documented explicitly

### Podman compatibility

`podman compose up` is a drop-in replacement. Podman Desktop (free, no licensing restrictions) works on macOS, Windows, and Linux. The `docker-compose.yml` file is fully compatible.

---

## Architecture

```
Host machine                          Docker container
─────────────────                     ──────────────────────────────
~/.browserbud/claude-config/   ──►    /home/bb/.claude/              (bind mount, read-write)
  .credentials.json                     credentials, settings, IDE port files
  .claude.json                          session config (via CLAUDE_CONFIG_DIR)
  settings.json
  ide/
~/.browserbud/data/            ──►    /home/bb/browse/               (bind mount, read-write)
  context/, cache/, notes/              Claude Code's working directory

browser → localhost:8989       ──►    server.js (:8989)
                                        ├── HTTP proxy → ttyd (:7682 internal)
                                        ├── MCP WebSocket → Claude Code
                                        └── /api/context endpoint

                                      tmux session "browserbud"
                                        └── claude --ide (persistent)

                                      ttyd (:7682)
                                        └── tmux attach (web terminal)
```

All three processes (server.js, tmux+claude, ttyd) run in a single container, managed by `start.sh` exactly as today.

All persistent state lives under `~/.browserbud/` on the host — works on macOS, Linux, and Windows (Docker Desktop expands `~` to `%USERPROFILE%`).

---

## Authentication

### How it works

Claude Code stores OAuth credentials differently per platform:
- **Linux** (inside the container): `~/.claude/.credentials.json` (a JSON file)
- **macOS**: macOS Keychain (no file on disk)
- **Windows**: `~/.claude/.credentials.json`

Since the container runs Linux, credentials are always stored as a file. We use `CLAUDE_CONFIG_DIR` (the official Anthropic pattern from their devcontainer) to keep all Claude config inside a single bind-mounted directory.

### Auth flow

```
1. User runs `docker compose up`
   → Claude Code starts in the terminal, shows an OAuth login URL
   → The terminal bridge detects the URL and posts it to the side panel
   → The extension shows a clickable "Open login page" banner
   → User clicks the link, authenticates in the browser, pastes the auth code

2. Credentials saved to ~/.browserbud/claude-config/.credentials.json
   → Persists across container restarts (bind mount)
   → Refresh token handles automatic renewal

3. Subsequent `docker compose up` — already logged in, no prompt
```

### Why ~/.browserbud instead of ~/.claude?

Using a separate directory avoids conflicts with the host's Claude Code installation:

1. **No project memory bleed**: `~/.claude/projects/` contains per-workspace state keyed by path. The container's paths (`/home/bb/browse/`) differ from the host's, which would create confusing duplicate entries.

2. **No lock file conflicts**: `~/.claude/ide/` contains MCP lock files. The container's MCP server and host IDE plugins (VS Code, JetBrains) would collide.

3. **Cross-platform**: `~/.browserbud/` works the same on all OSes. No need to worry about whether the host stores credentials in Keychain vs file.

### Volume layout

| Host path | Container path | Purpose |
|-----------|---------------|---------|
| `~/.browserbud/claude-config/` | `/home/bb/.claude/` | All Claude Code state (credentials, settings, IDE port files, projects) |
| `~/.browserbud/data/` | `/home/bb/browse/` | Claude Code working directory (notes, cache, context) |

### Future agents

The same pattern extends to other CLI agents:

| Agent | Host credential path | Container mount | Auth method |
|-------|---------------------|-----------------|-------------|
| Claude Code | `~/.claude/.credentials.json` | bind mount (read-only) | OAuth (browser login on host) |
| Codex (OpenAI) | env var `OPENAI_API_KEY` | `environment:` in compose | API key |
| Aider | env var `ANTHROPIC_API_KEY` | `environment:` in compose | API key |
| Gemini CLI | `~/.config/gemini/` | bind mount (read-only) | OAuth or API key |

Adding an agent = adding a volume mount or env var to `docker-compose.yml`.

---

## Container Design

### Single container, not multi-service

The three processes (server.js, tmux+claude, ttyd) are tightly coupled:
- server.js writes MCP lock files that Claude Code reads at startup
- ttyd attaches to Claude Code's tmux session
- server.js proxies HTTP/WebSocket to ttyd

Splitting them into separate containers would require shared volumes for lock files, shared network namespaces, and complex startup ordering. A single container with `start.sh` as the entrypoint is simpler and matches the current architecture.

### Dockerfile

```dockerfile
FROM node:20-bookworm-slim

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl tmux jq ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ttyd (static binary from GitHub releases)
ARG TARGETARCH
RUN TTYD_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "aarch64" || echo "x86_64") && \
    curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.${TTYD_ARCH}" \
    -o /usr/local/bin/ttyd && chmod +x /usr/local/bin/ttyd

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Non-root user (UID/GID set at build time, overridable at runtime)
ARG USER_UID=1000
ARG USER_GID=1000
RUN groupadd -g $USER_GID bb && useradd -m -s /bin/bash -u $USER_UID -g $USER_GID bb
USER bb
WORKDIR /home/bb

# Copy server (server.js, bridge, start script)
COPY --chown=bb:bb server/ /opt/browserbud/server/

# Copy .claude commands + settings (these get symlinked into ~/browse/.claude)
COPY --chown=bb:bb .claude/ /opt/browserbud/.claude/

# Copy skills (these get symlinked into ~/browse/skills)
COPY --chown=bb:bb skills/ /opt/browserbud/skills/

# Copy root .env if present (skills read API keys from repo-root .env)
COPY --chown=bb:bb .env* /opt/browserbud/

# Install ALL dependencies (not --production):
#   - server/ needs esbuild (devDep) for bridge build
#   - skills need tsx (devDep) as their CLI runtime
RUN cd /opt/browserbud/server && npm ci
RUN cd /opt/browserbud/skills/yt-research && npm ci
RUN cd /opt/browserbud/skills/page-reader && npm ci

# Pre-build the terminal bridge (esbuild is now available)
RUN cd /opt/browserbud/server && npm run build:bridge

# Ports: only the proxy port is exposed (ttyd is internal)
EXPOSE 8989

# start.sh manages all processes (server.js, tmux, ttyd)
CMD ["bash", "/opt/browserbud/server/start.sh"]
```

**Why `npm ci` instead of `npm ci --production`**: The skills use `tsx` (a devDependency) as their CLI runtime (`"cli": "tsx index.ts"`), and the server's bridge build requires `esbuild` (a devDependency). Using `--production` would skip these and break both the image build and runtime skill invocation.

### docker-compose.yml

```yaml
services:
  browserbud:
    build: .
    # Or use pre-built image:
    # image: ghcr.io/browserbud/browserbud:latest
    ports:
      - "${BROWSERBUD_PORT:-8989}:8989"
    volumes:
      # All BrowserBud state lives under ~/.browserbud on the host.
      # ~ expands correctly on macOS, Linux, and Windows (Docker Desktop).
      - ~/.browserbud/claude-config:/home/bb/.claude
      - ~/.browserbud/data:/home/bb/browse

    environment:
      - CLAUDE_CONFIG_DIR=/home/bb/.claude
      - BROWSERBUD_DATA_DIR=/home/bb/browse
      - BROWSERBUD_PORT=${BROWSERBUD_PORT:-8989}
      - BROWSERBUD_TTYD_PORT=${BROWSERBUD_TTYD_PORT:-7682}
      - BROWSERBUD_LOG_LEVEL=${BROWSERBUD_LOG_LEVEL:-info}
      - SUPADATA_API_KEY=${SUPADATA_API_KEY:-}
      - SCRAPECREATORS_API_KEY=${SCRAPECREATORS_API_KEY:-}

    init: true
    restart: unless-stopped

    # Linux only: uncomment and set to your host UID/GID for correct file ownership
    # user: "${UID:-1000}:${GID:-1000}"
```

Key design decisions:
- **`CLAUDE_CONFIG_DIR`**: Tells Claude Code to store `.claude.json` (session config) inside the mounted directory, so a single bind mount captures all state. This is the same pattern used by Anthropic's official devcontainer.
- **Bind mounts (not named volumes)**: Files live at `~/.browserbud/` on the host, visible and easy to back up.
- **No tmpfs**: The `ide/` subdirectory is pre-created in the Dockerfile and persists in the bind mount. Stale lock files are cleaned up by `start.sh`.

### Linux UID/GID handling

On Linux, files created by the container in `~/.browserbud/` will be owned by UID 1000 (the container's `bb` user). If your host user has a different UID, uncomment the `user:` directive in `docker-compose.yml`:

```bash
# .env (next to docker-compose.yml)
UID=1000
GID=1000
```

On macOS and Windows (Docker Desktop), file ownership is handled by the VM layer — the default UID 1000 works regardless of host UID.

### Skill API keys

Skills read API keys from environment variables, which are passed through from docker-compose.yml `environment:`. Users set keys in their host env or in a `.env` file next to `docker-compose.yml`.

Layering:
1. Compose `environment:` (highest priority — for users who set keys in their host env or `.env`)
2. Empty string (skills degrade gracefully or use alternative fetch methods)

### What changes in start.sh

| Current behavior | Change needed | Why |
|--|--|--|
| `REPO_DIR` resolved from script location | Works as-is — `/opt/browserbud` | Script is at `/opt/browserbud/server/start.sh` |
| `source "$REPO_DIR/.env"` | Works — `.env` is copied into image at `/opt/browserbud/.env` | No change needed |
| `ln -sfn "$REPO_DIR/.claude" "$WORK_DIR/.claude"` | Works — symlinks `/opt/browserbud/.claude` → `/home/bb/browse/.claude` | No change needed |
| `ln -sfn "$REPO_DIR/skills" "$WORK_DIR/skills"` | Works — same pattern | No change needed |
| `cp "$SCRIPT_DIR/CLAUDE.browse.md" "$WORK_DIR/CLAUDE.md"` | Works | No change needed |
| `$HOME/.claude/ide/browserbud.port` | Works — `$HOME` is `/home/bb`, `ide/` is in the bind mount | No change needed |
| Lock file hiding (lines 88-94) | Works — only BrowserBud's lock file exists in the container | No change needed |
| `node "$SCRIPT_DIR/bridge/build.mjs"` | Skip if pre-built | Optional: add `[ -f bridge/terminal_bridge.built.js ] && exit 0` guard in build.mjs |

**Verdict**: `start.sh` should work unchanged inside the container.

### server.js changes

One fix for cross-platform safety:

```javascript
// Line 29 — current:
const DATA_DIR = process.env.BROWSERBUD_DATA_DIR || path.join(process.env.HOME, "browse");

// Should be:
const DATA_DIR = process.env.BROWSERBUD_DATA_DIR || path.join(require("os").homedir(), "browse");
```

In Docker, `BROWSERBUD_DATA_DIR` is always set via compose `environment:`, so this is a safety net.

---

## Platform-Specific Notes

### macOS

- Docker Desktop or Podman Desktop — both work
- Bind mounts use VirtioFS (Docker) or virtiofsd (Podman) — good performance
- `~/.claude` expands correctly in compose files
- No special configuration needed

### Linux

- Docker Engine or Podman (rootless)
- **UID/GID**: Set `UID` and `GID` in the `.env` file next to `docker-compose.yml` to match your host user. The `user:` directive in compose runs the container as that UID/GID, so files in `~/browse` have correct ownership.
- Podman rootless: may need `:Z` volume labels on SELinux systems (Fedora, RHEL)
- Best performance (native filesystem, no VM)

### Windows

**Canonical path: run everything from PowerShell.**

On Windows, `~` means different things depending on the shell:

| Shell | `~` resolves to |
|-------|----------------|
| PowerShell | `C:\Users\<name>` |
| CMD | (no `~` expansion) |
| Git Bash | `/c/Users/<name>` |
| WSL | `/home/<name>` (different filesystem!) |

Since credentials are stored in `~/.browserbud/` (written by the container, not the host), there's no cross-shell credential mismatch issue. Just run `docker compose up` from whichever shell you prefer.

```powershell
# PowerShell (Docker Desktop must be running)
git clone https://github.com/animeshjain/browserbud.git
cd browserbud
docker compose up
# First run: authenticate via the login URL shown in the terminal
```

Docker Desktop on Windows translates paths correctly. `~/.browserbud/` resolves to `C:\Users\<name>\.browserbud\`.

**Alternative**: WSL end-to-end (clone and run from WSL). Also works — `~/.browserbud/` will be on the WSL filesystem.

---

## User-Facing Setup Flow

### First time

```bash
# 1. Install Docker Desktop (or Podman Desktop)
#    macOS: brew install --cask docker
#    Windows: Download from docker.com (includes WSL2 backend)
#    Linux: apt/dnf install docker.io docker-compose-v2

# 2. Clone and start
git clone https://github.com/animeshjain/browserbud.git
cd browserbud
docker compose up

# 3. First run: Claude Code shows a login URL in the terminal.
#    The extension detects it and shows a clickable banner.
#    Authenticate once — credentials persist in ~/.browserbud/

# 4. Install the browser extension
#    Firefox: setup script auto-installs signed .xpi (zero clicks)
#    Chrome: open https://chromewebstore.google.com/detail/browserbud/<id>
#            click "Add to Chrome" (one click, one time)

# 5. Open any webpage, click BrowserBud icon → side panel opens with Claude Code
```

### Every time after

```bash
docker compose up        # or: docker compose up -d (background)
```

### Updating

```bash
git pull                 # get latest compose + Dockerfile
docker compose build     # rebuild image
docker compose up
# Or with pre-built images:
# docker compose pull && docker compose up
```

---

## Extension Distribution (V1 requirement)

Docker solves the server stack, but the extension is the other half of the install experience. Without a published extension, users must clone the repo, `npm run build`, and load unpacked in developer mode. That is not "dead simple."

### Firefox (recommended path)

- Sign extension via `web-ext sign` (Mozilla's CLI, free, fully automated)
- Host signed `.xpi` on GitHub Releases
- Setup script drops `.xpi` into Firefox profile `extensions/` directory → **zero-click install**
- Auto-updates via `update_url` in manifest pointing to GitHub-hosted `updates.json`
- Fully automatable in CI (`web-ext sign --channel=unlisted --api-key=... --api-secret=...`)

### Chrome

- Publish to Chrome Web Store (unlisted or listed, $5 one-time fee)
- Setup script opens the CWS listing URL → **one click to "Add to Chrome"**
- Auto-updates via CWS (every ~5-6 hours)
- First submission takes 2-14 days for review; code-only updates are fast (minutes to hours)

### Both

- WXT already supports both build targets (`npm run build` produces `dist/chrome-mv3/` and `dist/firefox-mv2/`)
- CI pipeline: on tag push, build both targets, sign Firefox .xpi, upload Chrome zip to CWS API

---

## Image Size Estimate

| Layer | Size |
|-------|------|
| node:20-bookworm-slim base | ~200 MB |
| apt packages (git, tmux, curl, ripgrep, jq) | ~80 MB |
| ttyd binary | ~2 MB |
| Claude Code CLI (npm global) | ~50 MB |
| server/ + node_modules (including devDeps) | ~30 MB |
| skills/ + node_modules (including devDeps) | ~40 MB |
| **Total** | **~400-500 MB** |

Including devDependencies adds ~20-30 MB (esbuild, tsx, typescript). This is acceptable — the alternative (multi-stage build to strip devDeps after building) adds Dockerfile complexity for minimal size savings.

---

## Open Questions for Review

1. **Pre-built image registry**: GHCR (GitHub Container Registry) or Docker Hub? GHCR is free for public repos and integrates with GitHub Actions. Docker Hub has broader familiarity but rate limits anonymous pulls.

2. **Bridge build timing**: Pre-built in image (current plan) vs rebuilt at container start. Pre-build is faster; start-time build allows customization without image rebuild. Recommendation: pre-build, skip in `start.sh` if built file exists.

3. **Auto-restart behavior**: `restart: unless-stopped` means if Claude Code crashes or user Ctrl+C's inside tmux, the whole container restarts. Alternative: `restart: no` and let users manually restart. Recommendation: `unless-stopped` for now — a crash should self-heal; explicit stop (`docker compose down`) still works.

## Resolved Decisions

- **Authentication**: In-container OAuth flow with `CLAUDE_CONFIG_DIR` + bind mount to `~/.browserbud/claude-config/`. No host-side `claude /login` needed. Terminal bridge detects auth URLs and surfaces them in the extension's side panel.

- **Data directory**: `~/.browserbud/data/` replaces `~/browse/`. All BrowserBud state is consolidated under `~/.browserbud/`.

- **tmpfs removed**: Caused root-ownership permission issues. The `ide/` directory is pre-created in the Dockerfile and lives in the bind mount.

- **UID/GID**: Default UID 1000 works on macOS/Windows. Linux users uncomment `user:` directive in compose. No dynamic user creation needed.
