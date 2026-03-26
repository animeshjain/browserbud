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

// ─── OAuth URL detection ─────────────────────────────────────────────────

// Buffer terminal output to detect long URLs that span multiple lines.
// ttyd sends output in small chunks; a single URL may arrive across
// several WebSocket messages. We accumulate text, scan for URLs, and
// post them to the parent frame (extension side panel).
let outputBuffer = "";
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const URL_FLUSH_DELAY = 300; // ms — wait for all chunks of a wrapped line

const AUTH_URL_RE = /https:\/\/(?:claude\.com|claude\.ai|accounts\.anthropic\.com|console\.anthropic\.com)\S+/g;

function scanForAuthUrls(text: string): void {
  const matches = text.match(AUTH_URL_RE);
  if (!matches) return;
  for (const raw of matches) {
    // Strip trailing punctuation/ANSI artifacts that aren't part of the URL
    const url = raw.replace(/[\s\x00-\x1f]+/g, "").replace(/[)>\]]+$/, "");
    if (url.length < 30) continue; // too short to be a real auth URL
    console.log("[BrowserBud] Detected auth URL:", url);
    window.parent.postMessage(
      { type: "browserbud:auth-url", url },
      "*",
    );
  }
}

function processOutputBytes(data: Uint8Array): void {
  // ttyd binary protocol: first byte is command type
  // 0x30 = '0' = CMD_OUTPUT (terminal output data)
  if (data.length < 2 || data[0] !== 0x30) return;

  // Decode the payload (skip command byte)
  const text = new TextDecoder().decode(data.subarray(1));

  // Strip ANSI escape sequences and control characters so URLs that
  // wrap across terminal lines become continuous in the buffer.
  const clean = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
                     .replace(/\x1b\][^\x07]*\x07/g, "")
                     .replace(/[\x00-\x1f]/g, "");
  outputBuffer += clean;

  // Debounce: wait for all chunks of a wrapped URL to arrive
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    scanForAuthUrls(outputBuffer);
    // Keep only the tail in case a URL straddles the flush boundary
    outputBuffer = outputBuffer.length > 500
      ? outputBuffer.slice(-500)
      : "";
  }, URL_FLUSH_DELAY);
}

function onTerminalOutput(data: any): void {
  if (data instanceof ArrayBuffer) {
    processOutputBytes(new Uint8Array(data));
  } else if (data instanceof Blob) {
    // Some browsers deliver WebSocket binary as Blob by default
    data.arrayBuffer().then((buf: ArrayBuffer) => {
      processOutputBytes(new Uint8Array(buf));
    });
  }
}

class BrowserBudWebSocket extends NativeWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    if (url.toString().includes("/ws")) {
      state.ttydSocket = this;
      console.log("[BrowserBud] Captured ttyd WebSocket");
      // Listen for terminal output to detect auth URLs
      this.addEventListener("message", (event: MessageEvent) => {
        onTerminalOutput(event.data);
      });
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
