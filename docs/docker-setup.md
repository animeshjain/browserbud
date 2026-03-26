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
# One-time: authenticate Claude Code on host
claude /login

# Every time: start BrowserBud
docker compose up

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
~/.claude/.credentials.json    ──►    /home/bb/.claude/creds/       (bind mount, read-only)
~/.claude/settings.json        ──►    /home/bb/.claude/settings.json (bind mount, read-only)
                                      /home/bb/.claude/ide/          (container-local, tmpfs)
                                      /home/bb/.claude/projects/     (container-local)
~/browse/                      ──►    /home/bb/browse/               (bind mount, read-write)

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

---

## Authentication

### How it works

Claude Code stores OAuth credentials in `~/.claude/.credentials.json` after browser-based login. We mount only the credential file (and optionally settings) into the container — not the entire `~/.claude` directory.

### Auth flow

```
1. User runs `claude /login` on their host machine (one-time)
   → Browser opens, user authenticates with their Claude subscription
   → Token saved to ~/.claude/.credentials.json (lasts ~1 year)

2. User runs `docker compose up`
   → Container mounts credential file → /home/bb/.claude/.credentials.json
   → Claude Code inside container reads it, skips login wizard
   → No login needed, uses host's subscription
```

### Why not mount all of ~/.claude?

Mounting the entire `~/.claude` directory causes two problems:

1. **Project memory bleed**: `~/.claude/projects/` contains per-workspace state keyed by path. The host's Claude Code writes state for `~/browse/`, but the container's Claude Code writes state for `/home/bb/browse/`. These are different paths, so they'd create separate (confusing) project entries — or worse, the container could overwrite host project state.

2. **Lock file conflicts**: `~/.claude/ide/` contains MCP lock files. The container's MCP server and the host's IDE plugins (VS Code, JetBrains) would collide here.

**Solution**: Mount only the specific files needed:

| Host path | Container path | Mode | Purpose |
|-----------|---------------|------|---------|
| `~/.claude/.credentials.json` | `/home/bb/.claude/.credentials.json` | read-only | OAuth token |
| `~/.claude/settings.json` | `/home/bb/.claude/settings.json` | read-only | User preferences |
| (none — container-local) | `/home/bb/.claude/ide/` | tmpfs | MCP lock files (ephemeral) |
| (none — container-local) | `/home/bb/.claude/projects/` | volume | Container's own project memory |

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
    image: ghcr.io/browserbud/browserbud:latest  # pre-built image
    # Or build locally:
    # build:
    #   context: .
    #   dockerfile: Dockerfile
    ports:
      - "${BROWSERBUD_PORT:-8989}:8989"
    volumes:
      # Auth: credential file only (read-only, no project memory bleed)
      - ~/.claude/.credentials.json:/home/bb/.claude/.credentials.json:ro
      - ~/.claude/settings.json:/home/bb/.claude/settings.json:ro

      # Data: where Claude Code works (notes, cache, context)
      - ${BROWSERBUD_DATA_DIR:-~/browse}:/home/bb/browse

    # MCP lock files: container-local tmpfs (no host IDE conflicts)
    tmpfs:
      - /home/bb/.claude/ide:uid=1000,gid=1000

    environment:
      - BROWSERBUD_DATA_DIR=/home/bb/browse
      - BROWSERBUD_PORT=8989
      - BROWSERBUD_TTYD_PORT=7682
      - BROWSERBUD_LOG_LEVEL=${BROWSERBUD_LOG_LEVEL:-info}

      # Skill API keys (passed from host environment or .env file)
      - SUPADATA_API_KEY=${SUPADATA_API_KEY:-}
      - SCRAPECREATORS_API_KEY=${SCRAPECREATORS_API_KEY:-}

    # Match host user's UID/GID so files in ~/browse are owned correctly
    user: "${UID:-1000}:${GID:-1000}"

    # tini as PID 1 — forwards signals to start.sh's process tree
    init: true

    # Restart on crash (ttyd/server.js exit)
    restart: unless-stopped
```

### Linux UID/GID handling

The `user:` directive in docker-compose.yml runs the container process as the host user's UID/GID. This means files created in `~/browse` are owned by the host user, not by a container-internal uid. Users on Linux should export their UID/GID before running:

```bash
export UID=$(id -u) GID=$(id -g)
docker compose up
```

On macOS and Windows (Docker Desktop), file ownership is handled by the VM layer and this is not needed — the default `1000:1000` works.

To make this automatic, the compose file can use an `.env` file:

```bash
# .env (next to docker-compose.yml)
UID=1000
GID=1000
```

Users on Linux update these values to match their host user. On macOS/Windows, the defaults work.

### Skill API keys

Skills read API keys from the **repo-root `.env` file**, not from `skills/<name>/.env`. Specifically, `skills/yt-research/config.ts` loads `dotenv` with `path: join(__dirname, "..", "..", ".env")` — resolving to the repo root.

In the container, the `.env` file is copied into the image at `/opt/browserbud/.env`. The path resolution works because skills are symlinked from `/home/bb/browse/skills/` → `/opt/browserbud/skills/`, so `../../.env` resolves to `/opt/browserbud/.env`.

However, env vars set in docker-compose.yml `environment:` take precedence over `.env` file values (since `dotenv` doesn't overwrite existing env vars). This gives us the right layering:

1. Compose `environment:` (highest priority — for users who set keys in their host env)
2. `.env` baked into image (fallback — for keys set at build time)
3. Empty string (skills degrade gracefully or use alternative fetch methods)

### What changes in start.sh

| Current behavior | Change needed | Why |
|--|--|--|
| `REPO_DIR` resolved from script location | Works as-is — `/opt/browserbud` | Script is at `/opt/browserbud/server/start.sh` |
| `source "$REPO_DIR/.env"` | Works — `.env` is copied into image at `/opt/browserbud/.env` | No change needed |
| `ln -sfn "$REPO_DIR/.claude" "$WORK_DIR/.claude"` | Works — symlinks `/opt/browserbud/.claude` → `/home/bb/browse/.claude` | No change needed |
| `ln -sfn "$REPO_DIR/skills" "$WORK_DIR/skills"` | Works — same pattern | No change needed |
| `cp "$SCRIPT_DIR/CLAUDE.browse.md" "$WORK_DIR/CLAUDE.md"` | Works | No change needed |
| `$HOME/.claude/ide/browserbud.port` | Works — `$HOME` is `/home/bb`, `ide/` is a tmpfs | No change needed |
| Lock file hiding (lines 88-94) | Works — only BrowserBud's lock file exists in the tmpfs | No change needed |
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

Both `claude /login` and `docker compose up` must run in the **same environment** so `~/.claude` resolves to the same directory. On Windows, `~` means different things depending on the shell:

| Shell | `~` resolves to |
|-------|----------------|
| PowerShell | `C:\Users\<name>` |
| CMD | (no `~` expansion) |
| Git Bash | `/c/Users/<name>` |
| WSL | `/home/<name>` (different filesystem!) |

**If `claude /login` runs in PowerShell but `docker compose up` runs in WSL, the credential file is on a different filesystem and the container won't find it.**

Standardized Windows instructions:

```powershell
# All commands in PowerShell

# 1. Install Claude Code and authenticate
irm https://claude.ai/install.ps1 | iex
claude /login

# 2. Start BrowserBud (Docker Desktop must be running)
docker compose up
```

Docker Desktop on Windows translates PowerShell paths to container paths correctly. The `~/.claude/.credentials.json` mount resolves to `C:\Users\<name>\.claude\.credentials.json` → bind-mounted into the container.

**Alternative**: WSL end-to-end (install Claude Code in WSL, run `docker compose up` from WSL). This also works but is a different path — users must pick one and stick with it.

---

## User-Facing Setup Flow

### First time

```bash
# 1. Install Docker Desktop (or Podman Desktop)
#    macOS: brew install --cask docker
#    Windows: Download from docker.com (includes WSL2 backend)
#    Linux: apt/dnf install docker.io docker-compose-v2

# 2. Install Claude Code CLI and authenticate (one-time)
#    macOS/Linux:
curl -fsSL https://claude.ai/install.sh | bash
claude /login
#    Windows (PowerShell):
#    irm https://claude.ai/install.ps1 | iex
#    claude /login

# 3. Create a docker-compose.yml (or clone the repo)
curl -fsSL https://raw.githubusercontent.com/browserbud/browserbud/main/docker-compose.yml \
  -o docker-compose.yml
docker compose up

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
docker compose pull      # pull latest pre-built image
docker compose up
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

4. **`.env` file shipping**: The root `.env` contains API keys (gitignored). The Dockerfile `COPY .env* /opt/browserbud/` copies it if present. For the pre-built image, API keys should come from compose `environment:` only — the image should not bake in keys. Need a `.env.example` for documentation.

5. **`user:` directive and tmpfs**: The `user:` override in compose runs the process as the host UID, but the Dockerfile creates user `bb` with UID 1000. If the host UID differs, the container user won't match the homedir owner. Options: (a) use an entrypoint script that creates the user dynamically, (b) accept the mismatch (process runs as host UID, homedir owned by 1000 — most operations still work), (c) always run as 1000 and accept Linux file ownership quirks. Needs testing.
