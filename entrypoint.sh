#!/usr/bin/env bash
set -e

# Claude Code lives on a persistent volume (~/.local) so auto-updates
# survive container restarts. On first run the volume is empty, so we
# install here. Subsequent starts skip straight to the server.
if ! command -v claude &>/dev/null; then
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  First-time setup: installing Claude Code (~2 min, only happens once)"
  echo ""
  echo "  BrowserBud runs inside a Docker container with its own isolated"
  echo "  filesystem, so it needs its own copy of Claude Code even if you"
  echo "  already have it on your machine. The install is saved to a"
  echo "  persistent volume so this won't happen again on restart."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  # Download installer, then run in background with a progress timer.
  # The installer's own output is buffered in Docker (no TTY), so we
  # print elapsed time to keep docker-compose logs looking alive.
  INSTALLER=$(mktemp /tmp/claude-install.XXXXXX.sh)
  curl -fsSL https://claude.ai/install.sh -o "$INSTALLER"

  bash "$INSTALLER" > /tmp/claude-install.log 2>&1 &
  INSTALL_PID=$!
  SECONDS=0
  while kill -0 "$INSTALL_PID" 2>/dev/null; do
    printf "\r  Installing... %ds elapsed" "$SECONDS"
    sleep 5
  done
  echo ""

  wait "$INSTALL_PID"
  INSTALL_EXIT=$?
  rm -f "$INSTALLER"

  if [ "$INSTALL_EXIT" -ne 0 ]; then
    echo ""
    echo "  ✗ Installation failed. Installer output:"
    cat /tmp/claude-install.log
    exit 1
  fi

  echo "  ✓ Claude Code installed (${SECONDS}s)"
  echo "  Future restarts will be instant — auto-updates are persisted."
  echo ""
fi

exec bash /opt/browserbud/server/start.sh
