// Terminal bridge — injected into ttyd's HTML page by the proxy.
// Captures the ttyd WebSocket and provides clipboard integration,
// custom context menu, and programmatic terminal input via postMessage.
//
// All testable logic lives in bridge_core.ts. This file creates the
// real state/deps and wires browser event listeners.

import {
  type BridgeDeps,
  createInitialState,
  sendTextToTerminal,
  handleMouseUp,
  handleCopyShortcut,
  handleCopyEvent,
  pasteClipboardToTerminal,
} from "./bridge_core";

// ─── State & deps ───────────────────────────────────────────────────────────

const state = createInitialState();
const NativeWebSocket = window.WebSocket;

function logBridge(event: string, details?: Record<string, unknown>): void {
  try {
    fetch("/api/bridge-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event,
        details: details || {},
        ts: new Date().toISOString(),
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // intentionally swallowed
  }
}

const deps: BridgeDeps = {
  getSelectionText: () => {
    const sel = window.getSelection?.();
    return sel ? sel.toString() : "";
  },
  hasNonEmptySelection: () => {
    const sel = window.getSelection?.();
    return Boolean(sel && sel.rangeCount > 0 && !sel.isCollapsed);
  },
  clearSelection: () => {
    const sel = window.getSelection?.();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) sel.removeAllRanges();
  },
  focusTerminal: () => {
    const el = document.querySelector(
      ".xterm-helper-textarea",
    ) as HTMLElement | null;
    el?.focus();
  },
  writeClipboard: (text) => navigator.clipboard.writeText(text),
  readClipboard: () => navigator.clipboard.readText(),
  fetchTmuxBuffer: () =>
    fetch("/api/clipboard")
      .then((r) => r.json())
      .then((d) => d.text || ""),
  schedule: (fn, ms) => setTimeout(fn, ms),
  log: logBridge,
  execCopy: () => {
    try {
      return typeof document.execCommand === "function"
        ? document.execCommand("copy")
        : false;
    } catch {
      return false;
    }
  },
};

// ─── WebSocket capture ──────────────────────────────────────────────────────

class BrowserBudWebSocket extends NativeWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    if (url.toString().includes("/ws")) {
      state.ttydSocket = this;
      console.log("[BrowserBud] Captured ttyd WebSocket");
      this.addEventListener("close", () => {
        if (state.ttydSocket === this) state.ttydSocket = null;
      });
    }
  }
}
(window as any).WebSocket = BrowserBudWebSocket;

// ─── Event listeners ────────────────────────────────────────────────────────

// postMessage bridge: type text into the terminal
window.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "browserbud:type-text") return;
  if (!state.ttydSocket || state.ttydSocket.readyState !== 1) {
    console.warn("[BrowserBud] No active ttyd WebSocket");
    return;
  }
  const text = event.data.text || "";
  if (!text) return;

  sendTextToTerminal(state, deps, text);
  console.log("[BrowserBud] Typed into terminal:", text);
});

document.addEventListener(
  "wheel",
  (e) => {
    if (e.deltaY < 0) {
      state.copyModeActive = true;
    }
  },
  { capture: true, passive: true },
);

document.addEventListener(
  "mousedown",
  (e) => {
    if (e.button !== 0) return;
    state.pointerSelecting = true;
    if (state.copyModeActive) {
      state.selectionLatched = false;
    }
  },
  true,
);

document.addEventListener("mouseup", () => handleMouseUp(state, deps), true);

window.addEventListener(
  "keydown",
  (e) => handleCopyShortcut(state, deps, e),
  true,
);

window.addEventListener(
  "copy",
  (e) => handleCopyEvent(state, deps, e),
  true,
);

window.addEventListener(
  "paste",
  (e) => {
    const text =
      e.clipboardData &&
      (e.clipboardData.getData("text/plain") ||
        e.clipboardData.getData("text"));
    if (!text) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    sendTextToTerminal(state, deps, text);
  },
  true,
);

// ─── Clipboard & Context Menu ───────────────────────────────────────────────

// Block right-click mousedown from reaching xterm.js so it never forwards
// the event to ttyd/tmux (prevents tmux's built-in context menu).
document.addEventListener(
  "mousedown",
  (e) => {
    if (e.button === 2) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  },
  true,
);

// Custom context menu
let _menu: HTMLDivElement | null = null;

function hideMenu(): void {
  if (_menu && _menu.parentNode) _menu.parentNode.removeChild(_menu);
  _menu = null;
}

function mkItem(
  label: string,
  fn: () => void,
  disabled?: boolean,
): HTMLDivElement {
  const el = document.createElement("div");
  el.textContent = label;
  el.style.cssText =
    "padding:6px 16px;cursor:" +
    (disabled ? "default" : "pointer") +
    ";color:" +
    (disabled ? "#555" : "#e0e0e0") +
    ";white-space:nowrap";
  if (!disabled) {
    el.addEventListener("mouseenter", () => {
      el.style.background = "#3d3d3d";
    });
    el.addEventListener("mouseleave", () => {
      el.style.background = "none";
    });
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      hideMenu();
      fn();
    });
  }
  return el;
}

function showMenu(x: number, y: number): void {
  hideMenu();
  _menu = document.createElement("div");
  _menu.style.cssText =
    "position:fixed;z-index:99999;background:#252526;border:1px solid #454545;border-radius:4px;padding:4px 0;font:13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;color:#e0e0e0;min-width:140px;box-shadow:0 4px 12px rgba(0,0,0,0.5)";
  _menu.style.left = x + "px";
  _menu.style.top = y + "px";

  _menu.appendChild(
    mkItem("Copy", () => {
      // Read from tmux paste buffer (populated by copy-pipe on drag select)
      deps
        .fetchTmuxBuffer()
        .then((text) => {
          if (text) {
            deps.writeClipboard(text).catch((err) => {
              console.warn("[BrowserBud] Clipboard write failed:", err);
            });
          }
        })
        .catch((err) => {
          console.warn("[BrowserBud] Copy failed:", err);
        });
    }),
  );

  _menu.appendChild(
    mkItem("Paste", () => {
      pasteClipboardToTerminal(state, deps);
    }),
  );

  document.body.appendChild(_menu);
  // Keep on-screen
  const rect = _menu.getBoundingClientRect();
  if (rect.right > window.innerWidth)
    _menu.style.left =
      Math.max(0, window.innerWidth - rect.width - 4) + "px";
  if (rect.bottom > window.innerHeight)
    _menu.style.top =
      Math.max(0, window.innerHeight - rect.height - 4) + "px";
}

window.addEventListener(
  "contextmenu",
  (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    showMenu(e.clientX, e.clientY);
  },
  true,
);
document.addEventListener("click", () => hideMenu());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideMenu();
});
