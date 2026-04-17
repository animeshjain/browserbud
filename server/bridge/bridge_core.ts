// Bridge core — testable logic extracted from terminal_bridge.ts.
// All functions take explicit state and dependency objects so they
// can be unit-tested without a browser environment.

// ─── Types ──────────────────────────────────────────────────────────────────

export type BridgeState = {
  ttydSocket: WebSocket | null;
  copyModeActive: boolean;
  pointerSelecting: boolean;
  selectionLatched: boolean;
  cachedSelectionText: string;
};

export type BridgeDeps = {
  getSelectionText: () => string;
  hasNonEmptySelection: () => boolean;
  clearSelection: () => void;
  focusTerminal: () => void;
  writeClipboard: (text: string) => Promise<void>;
  readClipboard: () => Promise<string>;
  fetchTmuxBuffer: () => Promise<string>;
  schedule: (fn: () => void, ms: number) => void;
  log: (event: string, details?: Record<string, unknown>) => void;
  execCopy: () => boolean;
};

// WebSocket.OPEN = 1 — use literal to avoid depending on the global.
const WS_OPEN = 1;

// ─── Factories ──────────────────────────────────────────────────────────────

export function createInitialState(): BridgeState {
  return {
    ttydSocket: null,
    copyModeActive: false,
    pointerSelecting: false,
    selectionLatched: false,
    cachedSelectionText: "",
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function sendTerminalInput(
  state: BridgeState,
  text: string,
): boolean {
  if (!state.ttydSocket || state.ttydSocket.readyState !== WS_OPEN || !text)
    return false;
  state.ttydSocket.send("0" + text);
  return true;
}

export function terminalSelectionActive(
  state: BridgeState,
  deps: BridgeDeps,
): boolean {
  return Boolean(
    state.selectionLatched ||
      state.copyModeActive ||
      deps.hasNonEmptySelection(),
  );
}

export function exitSelectionMode(
  state: BridgeState,
  deps: BridgeDeps,
): boolean {
  const hadSelection = terminalSelectionActive(state, deps);
  deps.clearSelection();
  deps.focusTerminal();
  if (!hadSelection) return false;
  let sentEsc = false;
  if (state.copyModeActive) {
    sendTerminalInput(state, "\u001b");
    sentEsc = true;
  }
  state.copyModeActive = false;
  state.selectionLatched = false;
  return sentEsc;
}

// Delay after ESC so tmux doesn't interpret ESC + first char as Alt+key.
const POST_ESC_DELAY_MS = 50;
// Gap between the body and a trailing \r. Claude Code's input treats a
// single burst (body + \r) as a paste and keeps the newline inline; a
// separate \r after the paste window closes lands as Enter/submit.
const SUBMIT_GAP_MS = 80;

// Exit selection/copy mode and send text to terminal. If the text ends
// with \r, the Enter is sent as a separate delayed keypress so it
// submits instead of getting absorbed as a literal newline.
export function sendTextToTerminal(
  state: BridgeState,
  deps: BridgeDeps,
  text: string,
): void {
  if (!text) return;

  let body = text;
  let submit = "";
  if (body.endsWith("\r")) {
    submit = "\r";
    body = body.slice(0, -1);
  }

  const sentEsc = exitSelectionMode(state, deps);
  const bodyDelay = sentEsc ? POST_ESC_DELAY_MS : 0;

  const sendBody = () => {
    if (body) sendTerminalInput(state, body);
  };

  if (bodyDelay === 0) {
    sendBody();
  } else {
    deps.schedule(sendBody, bodyDelay);
  }

  if (submit) {
    deps.schedule(
      () => sendTerminalInput(state, submit),
      bodyDelay + SUBMIT_GAP_MS,
    );
  }
}

export function pasteClipboardToTerminal(
  state: BridgeState,
  deps: BridgeDeps,
): void {
  deps
    .readClipboard()
    .then((text) => {
      if (!text) return;
      sendTextToTerminal(state, deps, text);
    })
    .catch((err) => {
      console.warn("[BrowserBud] Paste failed:", err);
    });
}

export function copySelectionToClipboard(
  state: BridgeState,
  deps: BridgeDeps,
): Promise<void> | undefined {
  const selectedText = deps.getSelectionText();
  const textToCopy = selectedText || state.cachedSelectionText;
  if (textToCopy) {
    state.cachedSelectionText = textToCopy;
    return deps.writeClipboard(textToCopy).catch((err) => {
      console.warn("[BrowserBud] Clipboard write failed:", err);
    });
  }

  // Fallback to tmux paste buffer when the browser selection is empty.
  return deps
    .fetchTmuxBuffer()
    .then((text) => {
      if (!text) return;
      return deps.writeClipboard(text);
    })
    .catch((err) => {
      console.warn("[BrowserBud] Copy failed:", err);
    });
}

export function refreshSelectionCache(
  state: BridgeState,
  deps: BridgeDeps,
): Promise<string> {
  return deps
    .fetchTmuxBuffer()
    .then((text) => {
      state.cachedSelectionText = text;
      deps.log("selection-cache-refresh", {
        cachedSelectionLen: text.length,
      });
      return text;
    })
    .catch(() => {
      state.cachedSelectionText = "";
      return "";
    });
}

// Called on mouseup after a pointer drag. Decides whether to latch
// the selection and refresh the cache, or clear the cache.
// This is the decision point that was under-specified when tmux owns
// the selection but the browser DOM selection is empty.
export function handleMouseUp(
  state: BridgeState,
  deps: BridgeDeps,
): void {
  if (!state.pointerSelecting) return;
  state.pointerSelecting = false;
  state.selectionLatched = terminalSelectionActive(state, deps);
  if (state.selectionLatched) {
    // tmux updates the paste buffer just after drag end; wait a tick so we
    // read the populated selection instead of the previous buffer contents.
    deps.schedule(() => refreshSelectionCache(state, deps), 25);
  } else {
    state.cachedSelectionText = "";
  }
}

export function isCopyShortcut(e: {
  key: string;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  if ((e.key || "").toLowerCase() !== "c") return false;
  if (e.altKey || e.shiftKey) return false;
  return (e.metaKey || e.ctrlKey) && !(e.metaKey && e.ctrlKey);
}

// Returns true if the shortcut was handled (caller should preventDefault).
// Returns false if it should pass through to the terminal (e.g. Ctrl+C for SIGINT).
export function handleCopyShortcut(
  state: BridgeState,
  deps: BridgeDeps,
  e: {
    key: string;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    preventDefault: () => void;
    stopImmediatePropagation: () => void;
  },
): boolean {
  if (!isCopyShortcut(e)) return false;

  deps.log("copy-shortcut-keydown", {
    metaKey: !!e.metaKey,
    ctrlKey: !!e.ctrlKey,
    selectionActive: terminalSelectionActive(state, deps),
    cachedSelectionLen: state.cachedSelectionText.length,
  });

  // Ctrl+C without selection: pass through to xterm for SIGINT
  if (e.ctrlKey && !e.metaKey && !terminalSelectionActive(state, deps)) {
    deps.log("copy-shortcut-pass-through", {
      reason: "ctrl-c-without-selection",
    });
    return false;
  }

  e.preventDefault();
  e.stopImmediatePropagation();

  if (!state.cachedSelectionText) {
    copySelectionToClipboard(state, deps);
    deps.log("copy-shortcut-fallback-write", { reason: "empty-cache" });
    return true;
  }

  let execResult = false;
  try {
    execResult = deps.execCopy();
  } catch (err: any) {
    deps.log("copy-shortcut-exec-error", {
      message: String((err && err.message) || err),
    });
  }
  deps.log("copy-shortcut-exec-result", { ok: execResult });
  if (!execResult) {
    copySelectionToClipboard(state, deps);
  }
  return true;
}

export function handleCopyEvent(
  state: BridgeState,
  deps: BridgeDeps,
  e: {
    preventDefault: () => void;
    stopImmediatePropagation: () => void;
    clipboardData: { setData: (type: string, data: string) => void } | null;
  },
): void {
  e.preventDefault();
  e.stopImmediatePropagation();
  const selectedText = deps.getSelectionText();
  const textToCopy = selectedText || state.cachedSelectionText;
  deps.log("copy-event", {
    selectedTextLen: selectedText.length,
    cachedSelectionLen: state.cachedSelectionText.length,
    hasClipboardData: !!e.clipboardData,
  });
  if (textToCopy && e.clipboardData) {
    e.clipboardData.setData("text/plain", textToCopy);
    state.cachedSelectionText = textToCopy;
    return;
  }
  copySelectionToClipboard(state, deps);
}
