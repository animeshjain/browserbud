# BrowserBud Docker Setup — Design Document

**Status**: Draft for review
**Date**: 2026-03-26

## Goal

Replace the current multi-tool native install (`node + ttyd + tmux + bash`) with a single `docker compose up` command that works on macOS, Linux, and Windows.

## Current Setup (Native)

Today, running BrowserBud requires:

1. Node.js v20+
2. ttyd (web terminal — `brew install ttyd`)
3. tmux (terminal multiplexer — `brew install tmux`)
4. Claude Code CLI (`npm i -g @anthropic-ai/claude-code` or native installer)
5. Run `bash server/start.sh`

This only works on macOS/Linux. Windows has no native tmux, ttyd is less tested, and `start.sh` is deeply Unix-specific.

## Proposed Setup (Docker)

```bash
# One-time: authenticate Claude Code on host
claude /login

# Every time: start BrowserBud
docker compose up
```

That's it. Everything else — Node.js, ttyd, tmux, server.js, bridge build — lives inside the container.

### Podman compatibility

`podman compose up` is a drop-in replacement. Podman Desktop (free, no licensing restrictions) works on macOS, Windows, and Linux. The `docker-compose.yml` file is fully compatible. The only gotcha is rootless UID mapping on Linux (fixable with `:Z` volume labels on Fedora/RHEL).

---

## Architecture

```
Host machine                          Docker container
─────────────────                     ──────────────────────────────
~/.claude/                     ──►    /home/bb/.claude/        (bind mount, auth + settings)
~/browse/                      ──►    /home/bb/browse/         (bind mount, data dir)

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

Claude Code stores OAuth credentials in `~/.claude/.credentials.json` after browser-based login. By bind-mounting `~/.claude` into the container, Claude Code inside the container sees the existing credentials and skips the login wizard.

### Auth flow

```
1. User runs `claude /login` on their host machine (one-time)
   → Browser opens, user authenticates with their Claude subscription
   → Token saved to ~/.claude/.credentials.json (lasts ~1 year)

2. User runs `docker compose up`
   → Container mounts ~/.claude → /home/bb/.claude
   → Claude Code inside container reads .credentials.json
   → No login needed, uses host's subscription
```

### The ~/.claude/ide/ conflict

`~/.claude/ide/` is where MCP lock files go. Both the container's MCP server and the host's IDE plugins (VS Code, JetBrains) write here.

**Solution**: Mount `~/.claude` read-write, but `start.sh` already handles lock file conflicts — it hides other lock files at startup and restores them on exit. This works unchanged inside the container since the bind mount is bidirectional.

**Alternative** (if we want stricter isolation later): mount `~/.claude` read-only and overlay `~/.claude/ide/` with a tmpfs. This keeps the container from modifying host settings but requires an extra volume line.

### Future agents

The same pattern extends to other CLI agents:

| Agent | Host credential path | Container mount | Auth method |
|-------|---------------------|-----------------|-------------|
| Claude Code | `~/.claude/` | `/home/bb/.claude/` | OAuth (browser login on host) |
| Codex (OpenAI) | env var `OPENAI_API_KEY` | `environment:` in compose | API key |
| Aider | env var `ANTHROPIC_API_KEY` | `environment:` in compose | API key |
| Gemini CLI | `~/.config/gemini/` | `/home/bb/.config/gemini/` | OAuth or API key |

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

# Non-root user
RUN useradd -m -s /bin/bash bb
USER bb
WORKDIR /home/bb

# Copy server (server, bridge, start script)
COPY --chown=bb:bb server/ /opt/browserbud/server/

# Copy .claude commands + settings (these get symlinked into ~/browse/.claude)
COPY --chown=bb:bb .claude/ /opt/browserbud/.claude/

# Copy skills (these get symlinked into ~/browse/skills)
COPY --chown=bb:bb skills/ /opt/browserbud/skills/

# Install server dependencies
RUN cd /opt/browserbud/server && npm ci --production

# Install skill dependencies
RUN cd /opt/browserbud/skills/yt-research && npm ci --production
RUN cd /opt/browserbud/skills/page-reader && npm ci --production

# Build the terminal bridge
RUN cd /opt/browserbud/server && npm run build:bridge

# Ports: only the proxy port is exposed (ttyd is internal)
EXPOSE 8989

# start.sh manages all processes (server.js, tmux, ttyd)
CMD ["bash", "/opt/browserbud/server/start.sh"]
```

### docker-compose.yml

```yaml
services:
  browserbud:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "${BROWSERBUD_PORT:-8989}:8989"
    volumes:
      # Auth: Claude Code reads credentials from here
      - ~/.claude:/home/bb/.claude

      # Data: where Claude Code works (notes, cache, context)
      # This is the ~/browse/ equivalent inside the container
      - ${BROWSERBUD_DATA_DIR:-~/browse}:/home/bb/browse

    environment:
      - BROWSERBUD_DATA_DIR=/home/bb/browse
      - BROWSERBUD_PORT=8989
      - BROWSERBUD_TTYD_PORT=7682
      - BROWSERBUD_LOG_LEVEL=${BROWSERBUD_LOG_LEVEL:-info}

      # Skill API keys (optional — pass from host .env or environment)
      - SUPADATA_API_KEY=${SUPADATA_API_KEY:-}
      - SCRAPECREATORS_API_KEY=${SCRAPECREATORS_API_KEY:-}

    # tini as PID 1 — forwards signals to start.sh's process tree
    init: true

    # Restart on crash (ttyd/server.js exit)
    restart: unless-stopped
```

### What changes in start.sh

The existing `start.sh` needs minor adjustments for the container environment:

| Current behavior | Change needed | Why |
|--|--|--|
| `REPO_DIR` resolved from script location | Works as-is — `/opt/browserbud` | Script is at `/opt/browserbud/server/start.sh` |
| `source "$REPO_DIR/.env"` | Works — `.env` may not exist in container (env vars come from compose), but the `if [ -f ]` guard handles it | No change needed |
| `ln -sfn "$REPO_DIR/.claude" "$WORK_DIR/.claude"` | Works — symlinks `/opt/browserbud/.claude` → `/home/bb/browse/.claude` | No change needed |
| `ln -sfn "$REPO_DIR/skills" "$WORK_DIR/skills"` | Works — same pattern | No change needed |
| `cp "$SCRIPT_DIR/CLAUDE.browse.md" "$WORK_DIR/CLAUDE.md"` | Works | No change needed |
| `$HOME/.claude/ide/browserbud.port` | Works — `$HOME` is `/home/bb`, `~/.claude` is mounted | No change needed |
| Lock file hiding (lines 88-94) | Works — operates on mounted `~/.claude/ide/` | No change needed |
| `node "$SCRIPT_DIR/bridge/build.mjs"` | Could skip (pre-built in image), but running it is harmless | Optional optimization |

**Verdict**: `start.sh` should work unchanged inside the container. The paths all resolve correctly because the container's filesystem mirrors the expected layout.

### server.js changes

One fix needed:

```javascript
// Line 29 — current:
const DATA_DIR = process.env.BROWSERBUD_DATA_DIR || path.join(process.env.HOME, "browse");

// Should be (for cross-platform safety):
const DATA_DIR = process.env.BROWSERBUD_DATA_DIR || path.join(require("os").homedir(), "browse");
```

In the Docker context, `process.env.HOME` is always set so this isn't strictly needed, but it's good hygiene for future native Windows support.

---

## Volume Mounts Explained

### `~/.claude` → `/home/bb/.claude`

| What's in it | Read/Write | Purpose |
|--|--|--|
| `.credentials.json` | Read | OAuth token for Claude subscription |
| `settings.json` | Read | User's Claude Code settings (model, theme, etc.) |
| `ide/*.lock` | Read+Write | MCP lock files (server writes, Claude reads) |
| `ide/*.port` | Read+Write | MCP port file (server writes, start.sh reads) |
| `projects/` | Read+Write | Claude Code project memory |

Mount must be **read-write** because the MCP server writes lock/port files to `ide/`.

### `~/browse` → `/home/bb/browse`

| What's in it | Read/Write | Purpose |
|--|--|--|
| `context/current.json` | Write | Live browser context (written by server.js) |
| `cache/youtube/` | Write | Cached transcripts, metadata |
| `notes/` | Write | User's saved analysis and summaries |
| `memory/` | Write | Cross-session knowledge index |
| `.claude/` | Symlink | → `/opt/browserbud/.claude` (commands + settings) |
| `skills/` | Symlink | → `/opt/browserbud/skills` |
| `CLAUDE.md` | Write | Copied from `CLAUDE.browse.md` at startup |

This is the user's persistent data directory. Everything Claude Code produces lives here, fully accessible on the host filesystem.

---

## Platform-Specific Notes

### macOS

- Docker Desktop or Podman Desktop — both work
- Bind mounts use VirtioFS (Docker) or virtiofsd (Podman) — good performance
- `~/.claude` expands correctly in compose files
- No special configuration needed

### Linux

- Docker Engine or Podman (rootless)
- Podman rootless: may need `:Z` volume labels on SELinux systems (Fedora, RHEL)
- UID mapping: container user `bb` (uid 1000) should match host user's uid for clean file ownership. If not, use `userns: keep-id` in Podman or `--user $(id -u):$(id -g)` in Docker.
- Best performance (native filesystem, no VM)

### Windows

- Docker Desktop (uses WSL2 under the hood) or Podman Desktop (uses WSL2/Hyper-V)
- `~/.claude` path: Docker Desktop translates `C:\Users\<name>\.claude` → `/mnt/c/Users/<name>/.claude` inside WSL2
- **Performance tip**: If `~/browse` lives on the Windows NTFS filesystem (`/mnt/c/...`), I/O is slower due to the WSL2 cross-boundary. For better performance, keep it on the Linux filesystem inside WSL2 (e.g., `\\wsl$\Ubuntu\home\<user>\browse`). But NTFS works — just slower.
- The extension runs in Windows Chrome and connects to `localhost:8989` — Docker Desktop auto-forwards ports from WSL2 containers to the Windows host.

---

## User-Facing Setup Flow

### First time

```bash
# 1. Install Docker Desktop (or Podman Desktop)
#    macOS: brew install --cask docker
#    Windows: Download from docker.com
#    Linux: apt/dnf install docker.io docker-compose-v2

# 2. Install Claude Code CLI and authenticate (one-time)
#    This creates ~/.claude/.credentials.json
npm install -g @anthropic-ai/claude-code   # or: irm https://claude.ai/install.ps1 | iex
claude /login

# 3. Clone BrowserBud and start
git clone <repo-url> browserbud
cd browserbud
docker compose up

# 4. Install the browser extension
#    (See extension install docs — Chrome Web Store or Firefox self-hosted .xpi)

# 5. Open any webpage, click the BrowserBud icon → side panel opens with Claude Code
```

### Every time after

```bash
cd browserbud
docker compose up        # or: docker compose up -d (background)
```

### Updating

```bash
cd browserbud
git pull
docker compose build     # rebuild image with latest code
docker compose up
```

---

## Image Size Estimate

| Layer | Size |
|-------|------|
| node:20-bookworm-slim base | ~200 MB |
| apt packages (git, tmux, curl, ripgrep, jq) | ~80 MB |
| ttyd binary | ~2 MB |
| Claude Code CLI (npm global) | ~50 MB |
| server/ + node_modules | ~20 MB |
| skills/ + node_modules | ~30 MB |
| **Total** | **~400 MB** |

(Claude Code CLI is the main variable — if it pulls large dependencies, this could grow.)

---

## Open Questions for Review

1. **`.claude` mount: read-write vs read-only + ide overlay?**
   Read-write is simpler but means the container can modify host Claude settings. The lock file hiding in `start.sh` already writes to `~/.claude/ide/`. Recommendation: read-write for now, revisit if users report issues.

2. **Skill API keys: .env file vs environment variables?**
   Currently skills read from `skills/<name>/.env`. In Docker, we can either mount the `.env` files or pass keys via compose `environment:`. Compose environment is cleaner (single source of truth) but requires users to set env vars on their host. Could support both: compose env vars take precedence, fall back to mounted `.env` files.

3. **Bridge build: at image build time or container start time?**
   Currently `start.sh` runs `node bridge/build.mjs` every time. The Dockerfile can pre-build it. Running it at start is harmless (~200ms) but wasteful on every restart. Recommendation: pre-build in Dockerfile, skip in `start.sh` if the built file exists.

4. **Auto-restart behavior?**
   `restart: unless-stopped` means if Claude Code crashes or the user Ctrl+C's inside tmux, the whole container restarts. Is that the right behavior? Alternative: `restart: no` and let users manually restart.

5. **Multi-arch images?**
   The Dockerfile uses `TARGETARCH` for ttyd binary selection. Should we publish multi-arch images (amd64 + arm64) for Apple Silicon Macs? Recommendation: yes, use `docker buildx` for multi-arch builds.

6. **Pre-built images on Docker Hub / GHCR?**
   Should we publish a pre-built image so users don't need to clone the repo and build locally? This would simplify setup to just a `docker-compose.yml` + `docker compose up`. Tradeoff: the image includes skills that may change independently, and users can't easily customize. Could be a follow-up.
