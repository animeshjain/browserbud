FROM node:20-bookworm-slim

# ─── UTF-8 locale (needed for Claude Code's Unicode UI: logo, prompt, borders)
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# ─── System dependencies ────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl tmux jq ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ─── ttyd (static binary, multi-arch) ───────────────────────────────────────
ARG TARGETARCH
RUN TTYD_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "aarch64" || echo "x86_64") && \
    curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.${TTYD_ARCH}" \
    -o /usr/local/bin/ttyd && chmod +x /usr/local/bin/ttyd

# ─── Claude Code CLI ────────────────────────────────────────────────────────
RUN npm install -g @anthropic-ai/claude-code

# ─── Non-root user ──────────────────────────────────────────────────────────
# node:20-bookworm-slim already has user "node" (uid 1000, gid 1000).
# Reuse it to avoid UID conflicts; rename home to /home/bb for clarity.
RUN groupmod -n bb node && usermod -d /home/bb -m -l bb node
USER bb
WORKDIR /home/bb

# Pre-create .claude/ide so lock files are writable without tmpfs ownership issues
RUN mkdir -p /home/bb/.claude/ide

# ─── Dependencies (copy lock files first for layer caching) ─────────────────
COPY --chown=bb:bb server/package.json server/package-lock.json /opt/browserbud/server/
RUN cd /opt/browserbud/server && npm ci

COPY --chown=bb:bb skills/yt-research/package.json skills/yt-research/package-lock.json /opt/browserbud/skills/yt-research/
RUN cd /opt/browserbud/skills/yt-research && npm ci

COPY --chown=bb:bb skills/page-reader/package.json skills/page-reader/package-lock.json /opt/browserbud/skills/page-reader/
RUN cd /opt/browserbud/skills/page-reader && npm ci

# ─── Application source ─────────────────────────────────────────────────────
COPY --chown=bb:bb server/ /opt/browserbud/server/
COPY --chown=bb:bb skills/ /opt/browserbud/skills/
COPY --chown=bb:bb .claude/ /opt/browserbud/.claude/

# ─── Pre-build terminal bridge ──────────────────────────────────────────────
RUN cd /opt/browserbud/server && npm run build:bridge

# ─── Entrypoint ─────────────────────────────────────────────────────────────
COPY --chown=bb:bb entrypoint.sh /opt/browserbud/entrypoint.sh

EXPOSE 8989
ENTRYPOINT ["/opt/browserbud/entrypoint.sh"]
