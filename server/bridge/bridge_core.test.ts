/// <reference types="vitest" />
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  type BridgeState,
  type BridgeDeps,
  createInitialState,
  sendTerminalInput,
  terminalSelectionActive,
  exitSelectionMode,
  sendTextToTerminal,
  copySelectionToClipboard,
  refreshSelectionCache,
  isCopyShortcut,
  handleMouseUp,
  handleCopyShortcut,
  handleCopyEvent,
} from "./bridge_core";

// ─── Test helpers ───────────────────────────────────────────────────────────

function makeMockSocket(readyState = 1) {
  return { readyState, send: vi.fn() } as unknown as WebSocket;
}

function makeMockDeps(overrides?: Partial<BridgeDeps>): BridgeDeps {
  return {
    getSelectionText: vi.fn(() => ""),
    hasNonEmptySelection: vi.fn(() => false),
    clearSelection: vi.fn(),
    focusTerminal: vi.fn(),
    writeClipboard: vi.fn(() => Promise.resolve()),
    readClipboard: vi.fn(() => Promise.resolve("")),
    fetchTmuxBuffer: vi.fn(() => Promise.resolve("")),
    schedule: vi.fn((fn) => fn()), // immediate by default
    log: vi.fn(),
    execCopy: vi.fn(() => false),
    ...overrides,
  };
}

function makeKeyEvent(overrides?: Record<string, unknown>) {
  return {
    key: "c",
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...overrides,
  };
}

// ─── isCopyShortcut ─────────────────────────────────────────────────────────

describe("isCopyShortcut", () => {
  it("matches Cmd+C", () => {
    expect(isCopyShortcut(makeKeyEvent({ metaKey: true }))).toBe(true);
  });

  it("matches Ctrl+C", () => {
    expect(isCopyShortcut(makeKeyEvent({ ctrlKey: true }))).toBe(true);
  });

  it("matches uppercase C", () => {
    expect(isCopyShortcut(makeKeyEvent({ key: "C", metaKey: true }))).toBe(
      true,
    );
  });

  it("rejects Alt+C", () => {
    expect(
      isCopyShortcut(makeKeyEvent({ altKey: true, metaKey: true })),
    ).toBe(false);
  });

  it("rejects Shift+C", () => {
    expect(
      isCopyShortcut(makeKeyEvent({ shiftKey: true, metaKey: true })),
    ).toBe(false);
  });

  it("rejects Meta+Ctrl+C", () => {
    expect(
      isCopyShortcut(makeKeyEvent({ metaKey: true, ctrlKey: true })),
    ).toBe(false);
  });

  it("rejects wrong key", () => {
    expect(isCopyShortcut(makeKeyEvent({ key: "v", metaKey: true }))).toBe(
      false,
    );
  });

  it("rejects plain c without modifier", () => {
    expect(isCopyShortcut(makeKeyEvent())).toBe(false);
  });
});

// ─── sendTerminalInput ──────────────────────────────────────────────────────

describe("sendTerminalInput", () => {
  let state: BridgeState;

  beforeEach(() => {
    state = createInitialState();
  });

  it("sends '0' + text when socket is open", () => {
    state.ttydSocket = makeMockSocket();
    expect(sendTerminalInput(state, "hello")).toBe(true);
    expect((state.ttydSocket as any).send).toHaveBeenCalledWith("0hello");
  });

  it("returns false when socket is null", () => {
    expect(sendTerminalInput(state, "hello")).toBe(false);
  });

  it("returns false when socket is closed", () => {
    state.ttydSocket = makeMockSocket(3); // CLOSED
    expect(sendTerminalInput(state, "hello")).toBe(false);
  });

  it("returns false when text is empty", () => {
    state.ttydSocket = makeMockSocket();
    expect(sendTerminalInput(state, "")).toBe(false);
  });
});

// ─── terminalSelectionActive ────────────────────────────────────────────────

describe("terminalSelectionActive", () => {
  let state: BridgeState;
  let deps: BridgeDeps;

  beforeEach(() => {
    state = createInitialState();
    deps = makeMockDeps();
  });

  it("returns false when all flags are false and no DOM selection", () => {
    expect(terminalSelectionActive(state, deps)).toBe(false);
  });

  it("returns true when selectionLatched is true", () => {
    state.selectionLatched = true;
    expect(terminalSelectionActive(state, deps)).toBe(true);
  });

  it("returns true when copyModeActive is true", () => {
    state.copyModeActive = true;
    expect(terminalSelectionActive(state, deps)).toBe(true);
  });

  it("returns true when DOM selection exists", () => {
    deps = makeMockDeps({ hasNonEmptySelection: vi.fn(() => true) });
    expect(terminalSelectionActive(state, deps)).toBe(true);
  });
});

// ─── exitSelectionMode ──────────────────────────────────────────────────────

describe("exitSelectionMode", () => {
  let state: BridgeState;
  let deps: BridgeDeps;

  beforeEach(() => {
    state = createInitialState();
    state.ttydSocket = makeMockSocket();
    deps = makeMockDeps();
  });

  it("sends ESC when copyModeActive and selection exists", () => {
    state.copyModeActive = true;
    const result = exitSelectionMode(state, deps);
    expect(result).toBe(true);
    expect((state.ttydSocket as any).send).toHaveBeenCalledWith("0\u001b");
    expect(state.copyModeActive).toBe(false);
    expect(state.selectionLatched).toBe(false);
  });

  it("does not send ESC when selectionLatched but not copyModeActive", () => {
    state.selectionLatched = true;
    const result = exitSelectionMode(state, deps);
    expect(result).toBe(false);
    expect((state.ttydSocket as any).send).not.toHaveBeenCalled();
    expect(state.selectionLatched).toBe(false);
  });

  it("returns false when no selection active", () => {
    const result = exitSelectionMode(state, deps);
    expect(result).toBe(false);
  });

  it("always calls clearSelection and focusTerminal", () => {
    exitSelectionMode(state, deps);
    expect(deps.clearSelection).toHaveBeenCalled();
    expect(deps.focusTerminal).toHaveBeenCalled();
  });
});

// ─── sendTextToTerminal ─────────────────────────────────────────────────────

describe("sendTextToTerminal", () => {
  let state: BridgeState;

  beforeEach(() => {
    state = createInitialState();
    state.ttydSocket = makeMockSocket();
  });

  it("sends text immediately when not in copy mode", () => {
    const deps = makeMockDeps();
    sendTextToTerminal(state, deps, "hello");
    expect((state.ttydSocket as any).send).toHaveBeenCalledWith("0hello");
    expect(deps.schedule).not.toHaveBeenCalled();
  });

  it("delays text after ESC when copy-mode was active", () => {
    state.copyModeActive = true;
    let scheduledFn: (() => void) | null = null;
    const deps = makeMockDeps({
      schedule: vi.fn((fn) => {
        scheduledFn = fn;
      }),
    });

    sendTextToTerminal(state, deps, "hello");

    // ESC should have been sent
    expect((state.ttydSocket as any).send).toHaveBeenCalledWith("0\u001b");
    // Text should NOT have been sent yet
    expect((state.ttydSocket as any).send).not.toHaveBeenCalledWith("0hello");
    // schedule called with 50ms
    expect(deps.schedule).toHaveBeenCalledWith(expect.any(Function), 50);

    // Fire the scheduled callback
    scheduledFn!();
    expect((state.ttydSocket as any).send).toHaveBeenCalledWith("0hello");
  });

  it("sends text immediately when selectionLatched but not copyModeActive", () => {
    state.selectionLatched = true;
    const deps = makeMockDeps();
    sendTextToTerminal(state, deps, "hello");
    // No ESC sent
    expect((state.ttydSocket as any).send).not.toHaveBeenCalledWith(
      "0\u001b",
    );
    expect((state.ttydSocket as any).send).toHaveBeenCalledWith("0hello");
    expect(deps.schedule).not.toHaveBeenCalled();
  });

  it("does nothing for empty text", () => {
    const deps = makeMockDeps();
    sendTextToTerminal(state, deps, "");
    expect((state.ttydSocket as any).send).not.toHaveBeenCalled();
  });

  it("sends body immediately and schedules trailing \\r as separate Enter", () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const deps = makeMockDeps({
      schedule: vi.fn((fn, ms) => {
        scheduled.push({ fn, ms });
      }),
    });

    sendTextToTerminal(state, deps, "/clear\r");

    // Body sent synchronously without the trailing \r
    expect((state.ttydSocket as any).send).toHaveBeenCalledWith("0/clear");
    expect((state.ttydSocket as any).send).not.toHaveBeenCalledWith("0\r");

    // Enter scheduled separately with the submit gap
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(80);

    scheduled[0].fn();
    expect((state.ttydSocket as any).send).toHaveBeenCalledWith("0\r");
  });

  it("handles ESC + body + \\r: schedules body after ESC delay and \\r after that", () => {
    state.copyModeActive = true;
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const deps = makeMockDeps({
      schedule: vi.fn((fn, ms) => {
        scheduled.push({ fn, ms });
      }),
    });

    sendTextToTerminal(state, deps, "hello\r");

    // ESC sent synchronously, body/submit both deferred
    expect((state.ttydSocket as any).send).toHaveBeenCalledWith("0\u001b");
    expect((state.ttydSocket as any).send).not.toHaveBeenCalledWith("0hello");
    expect((state.ttydSocket as any).send).not.toHaveBeenCalledWith("0\r");

    expect(scheduled).toHaveLength(2);
    expect(scheduled[0].ms).toBe(50); // body after ESC
    expect(scheduled[1].ms).toBe(130); // submit after body gap

    scheduled[0].fn();
    expect((state.ttydSocket as any).send).toHaveBeenCalledWith("0hello");
    scheduled[1].fn();
    expect((state.ttydSocket as any).send).toHaveBeenCalledWith("0\r");
  });

  it("schedules bare \\r as the submit keypress with no body send", () => {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const deps = makeMockDeps({
      schedule: vi.fn((fn, ms) => {
        scheduled.push({ fn, ms });
      }),
    });

    sendTextToTerminal(state, deps, "\r");

    // No synchronous send — body is empty
    expect((state.ttydSocket as any).send).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(80);

    scheduled[0].fn();
    expect((state.ttydSocket as any).send).toHaveBeenCalledWith("0\r");
  });
});

// ─── copySelectionToClipboard (fallback ordering) ───────────────────────────

describe("copySelectionToClipboard", () => {
  let state: BridgeState;

  beforeEach(() => {
    state = createInitialState();
    state.ttydSocket = makeMockSocket();
  });

  it("uses DOM selection text first", async () => {
    const deps = makeMockDeps({
      getSelectionText: vi.fn(() => "from-dom"),
    });
    await copySelectionToClipboard(state, deps);
    expect(deps.writeClipboard).toHaveBeenCalledWith("from-dom");
    expect(deps.fetchTmuxBuffer).not.toHaveBeenCalled();
    expect(state.cachedSelectionText).toBe("from-dom");
  });

  it("uses cached text when DOM selection is empty", async () => {
    state.cachedSelectionText = "from-cache";
    const deps = makeMockDeps();
    await copySelectionToClipboard(state, deps);
    expect(deps.writeClipboard).toHaveBeenCalledWith("from-cache");
    expect(deps.fetchTmuxBuffer).not.toHaveBeenCalled();
  });

  it("falls back to tmux buffer when both are empty", async () => {
    const deps = makeMockDeps({
      fetchTmuxBuffer: vi.fn(() => Promise.resolve("from-tmux")),
    });
    await copySelectionToClipboard(state, deps);
    expect(deps.fetchTmuxBuffer).toHaveBeenCalled();
    expect(deps.writeClipboard).toHaveBeenCalledWith("from-tmux");
  });

  it("does not write clipboard when tmux buffer is also empty", async () => {
    const deps = makeMockDeps();
    await copySelectionToClipboard(state, deps);
    expect(deps.fetchTmuxBuffer).toHaveBeenCalled();
    expect(deps.writeClipboard).not.toHaveBeenCalled();
  });

  it("handles tmux fetch error gracefully", async () => {
    const deps = makeMockDeps({
      fetchTmuxBuffer: vi.fn(() => Promise.reject(new Error("fail"))),
    });
    // Should not throw
    await copySelectionToClipboard(state, deps);
  });
});

// ─── refreshSelectionCache ──────────────────────────────────────────────────

describe("refreshSelectionCache", () => {
  let state: BridgeState;

  beforeEach(() => {
    state = createInitialState();
  });

  it("updates cachedSelectionText on success", async () => {
    const deps = makeMockDeps({
      fetchTmuxBuffer: vi.fn(() => Promise.resolve("selected text")),
    });
    const result = await refreshSelectionCache(state, deps);
    expect(result).toBe("selected text");
    expect(state.cachedSelectionText).toBe("selected text");
    expect(deps.log).toHaveBeenCalledWith("selection-cache-refresh", {
      cachedSelectionLen: 13,
    });
  });

  it("replaces old cached text with new selection", async () => {
    state.cachedSelectionText = "old text";
    const deps = makeMockDeps({
      fetchTmuxBuffer: vi.fn(() => Promise.resolve("new text")),
    });
    await refreshSelectionCache(state, deps);
    expect(state.cachedSelectionText).toBe("new text");
  });

  it("clears cache on error", async () => {
    state.cachedSelectionText = "had something";
    const deps = makeMockDeps({
      fetchTmuxBuffer: vi.fn(() => Promise.reject(new Error("fail"))),
    });
    const result = await refreshSelectionCache(state, deps);
    expect(result).toBe("");
    expect(state.cachedSelectionText).toBe("");
  });

  it("sets cache to empty string when tmux buffer is empty", async () => {
    const deps = makeMockDeps({
      fetchTmuxBuffer: vi.fn(() => Promise.resolve("")),
    });
    const result = await refreshSelectionCache(state, deps);
    expect(result).toBe("");
    expect(state.cachedSelectionText).toBe("");
  });
});

// ─── handleCopyShortcut (gating logic) ──────────────────────────────────────

describe("handleCopyShortcut", () => {
  let state: BridgeState;
  let deps: BridgeDeps;

  beforeEach(() => {
    state = createInitialState();
    state.ttydSocket = makeMockSocket();
    deps = makeMockDeps();
  });

  it("returns false for non-copy shortcut", () => {
    const e = makeKeyEvent({ key: "v", metaKey: true });
    expect(handleCopyShortcut(state, deps, e)).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("Cmd+C always proceeds even without selection", () => {
    const e = makeKeyEvent({ metaKey: true });
    const result = handleCopyShortcut(state, deps, e);
    expect(result).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopImmediatePropagation).toHaveBeenCalled();
  });

  it("Ctrl+C without selection passes through for SIGINT", () => {
    const e = makeKeyEvent({ ctrlKey: true });
    const result = handleCopyShortcut(state, deps, e);
    expect(result).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("Ctrl+C with selectionLatched triggers copy", () => {
    state.selectionLatched = true;
    const e = makeKeyEvent({ ctrlKey: true });
    const result = handleCopyShortcut(state, deps, e);
    expect(result).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("Ctrl+C with DOM selection triggers copy", () => {
    deps = makeMockDeps({ hasNonEmptySelection: vi.fn(() => true) });
    const e = makeKeyEvent({ ctrlKey: true });
    const result = handleCopyShortcut(state, deps, e);
    expect(result).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("with empty cache calls copySelectionToClipboard directly", () => {
    const e = makeKeyEvent({ metaKey: true });
    handleCopyShortcut(state, deps, e);
    // fetchTmuxBuffer is called as part of the fallback
    expect(deps.fetchTmuxBuffer).toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith("copy-shortcut-fallback-write", {
      reason: "empty-cache",
    });
  });

  it("with cached text tries execCopy first", () => {
    state.cachedSelectionText = "cached";
    deps = makeMockDeps({ execCopy: vi.fn(() => true) });
    const e = makeKeyEvent({ metaKey: true });
    handleCopyShortcut(state, deps, e);
    expect(deps.execCopy).toHaveBeenCalled();
    // execCopy succeeded — should NOT call fetchTmuxBuffer
    expect(deps.fetchTmuxBuffer).not.toHaveBeenCalled();
  });

  it("falls back to copySelectionToClipboard when execCopy fails", () => {
    state.cachedSelectionText = "cached";
    deps = makeMockDeps({ execCopy: vi.fn(() => false) });
    const e = makeKeyEvent({ metaKey: true });
    handleCopyShortcut(state, deps, e);
    expect(deps.execCopy).toHaveBeenCalled();
    // Since cachedSelectionText is set, copySelectionToClipboard will
    // use it (no tmux fetch needed)
    expect(deps.writeClipboard).toHaveBeenCalledWith("cached");
  });
});

// ─── handleCopyEvent ────────────────────────────────────────────────────────

describe("handleCopyEvent", () => {
  let state: BridgeState;
  let deps: BridgeDeps;

  beforeEach(() => {
    state = createInitialState();
    deps = makeMockDeps();
  });

  it("uses DOM selection via clipboardData when available", () => {
    deps = makeMockDeps({ getSelectionText: vi.fn(() => "selected") });
    const setData = vi.fn();
    const e = {
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
      clipboardData: { setData },
    };
    handleCopyEvent(state, deps, e);
    expect(setData).toHaveBeenCalledWith("text/plain", "selected");
    expect(state.cachedSelectionText).toBe("selected");
    // Should NOT fall through to copySelectionToClipboard
    expect(deps.writeClipboard).not.toHaveBeenCalled();
  });

  it("uses cached text when DOM selection is empty", () => {
    state.cachedSelectionText = "cached";
    const setData = vi.fn();
    const e = {
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
      clipboardData: { setData },
    };
    handleCopyEvent(state, deps, e);
    expect(setData).toHaveBeenCalledWith("text/plain", "cached");
  });

  it("falls back to copySelectionToClipboard when no text and no clipboardData", () => {
    const e = {
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
      clipboardData: null,
    };
    handleCopyEvent(state, deps, e);
    // copySelectionToClipboard is called (goes to tmux buffer)
    expect(deps.fetchTmuxBuffer).toHaveBeenCalled();
  });
});

// ─── handleMouseUp (selection-cache lifecycle) ──────────────────────────────

describe("handleMouseUp", () => {
  let state: BridgeState;

  beforeEach(() => {
    state = createInitialState();
    state.pointerSelecting = true; // simulate active drag
  });

  it("does nothing when pointerSelecting is false", () => {
    state.pointerSelecting = false;
    const deps = makeMockDeps();
    handleMouseUp(state, deps);
    expect(deps.schedule).not.toHaveBeenCalled();
    expect(state.cachedSelectionText).toBe("");
  });

  it("latches and schedules cache refresh when copyModeActive", () => {
    state.copyModeActive = true;
    const deps = makeMockDeps();
    handleMouseUp(state, deps);
    expect(state.pointerSelecting).toBe(false);
    expect(state.selectionLatched).toBe(true);
    expect(deps.schedule).toHaveBeenCalledWith(expect.any(Function), 25);
  });

  it("latches and schedules cache refresh when DOM selection exists", () => {
    const deps = makeMockDeps({
      hasNonEmptySelection: vi.fn(() => true),
    });
    handleMouseUp(state, deps);
    expect(state.selectionLatched).toBe(true);
    expect(deps.schedule).toHaveBeenCalledWith(expect.any(Function), 25);
  });

  // This is the exact scenario that caused the Cmd+C regression:
  // tmux owns the selection, browser DOM selection is empty,
  // copyModeActive is false (user didn't scroll up first).
  it("clears cache when tmux owns selection but browser has none and not in copy mode", () => {
    state.cachedSelectionText = "stale text from previous selection";
    const deps = makeMockDeps({
      hasNonEmptySelection: vi.fn(() => false),
    });
    handleMouseUp(state, deps);
    expect(state.selectionLatched).toBe(false);
    expect(state.cachedSelectionText).toBe("");
    expect(deps.schedule).not.toHaveBeenCalled();
  });

  it("scheduled refresh updates cache from tmux buffer", async () => {
    state.copyModeActive = true;
    let scheduledFn: (() => void) | null = null;
    const deps = makeMockDeps({
      fetchTmuxBuffer: vi.fn(() => Promise.resolve("tmux selection")),
      schedule: vi.fn((fn) => {
        scheduledFn = fn;
      }),
    });

    handleMouseUp(state, deps);
    expect(scheduledFn).not.toBeNull();

    // Execute the scheduled refresh
    scheduledFn!();
    // Let the promise resolve
    await vi.waitFor(() => {
      expect(state.cachedSelectionText).toBe("tmux selection");
    });
  });

  it("new selection replaces stale cached text after refresh", async () => {
    state.copyModeActive = true;
    state.cachedSelectionText = "old stale text";
    let scheduledFn: (() => void) | null = null;
    const deps = makeMockDeps({
      fetchTmuxBuffer: vi.fn(() => Promise.resolve("fresh selection")),
      schedule: vi.fn((fn) => {
        scheduledFn = fn;
      }),
    });

    handleMouseUp(state, deps);
    scheduledFn!();
    await vi.waitFor(() => {
      expect(state.cachedSelectionText).toBe("fresh selection");
    });
  });

  // Cmd+C right after mouseup but before the 25ms refresh completes.
  // The cache is empty, so handleCopyShortcut should fall through to
  // copySelectionToClipboard which fetches the tmux buffer directly.
  it("Cmd+C before cache refresh completes falls back to tmux buffer", () => {
    state.copyModeActive = true;
    state.ttydSocket = makeMockSocket();
    const deps = makeMockDeps({
      fetchTmuxBuffer: vi.fn(() => Promise.resolve("tmux text")),
      schedule: vi.fn(), // capture but don't execute — refresh hasn't run yet
    });

    handleMouseUp(state, deps);
    // Cache is still empty because refresh hasn't run
    expect(state.cachedSelectionText).toBe("");

    // Cmd+C fires before the 25ms refresh
    const e = makeKeyEvent({ metaKey: true });
    handleCopyShortcut(state, deps, e);

    // Should have gone through the fallback path
    expect(deps.fetchTmuxBuffer).toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith("copy-shortcut-fallback-write", {
      reason: "empty-cache",
    });
  });
});

// ─── Paste (first character preserved) ──────────────────────────────────────

describe("paste preserves first character", () => {
  it("sends full text immediately when not in copy mode", () => {
    const state = createInitialState();
    state.ttydSocket = makeMockSocket();
    const deps = makeMockDeps();

    sendTextToTerminal(state, deps, "abc");
    expect((state.ttydSocket as any).send).toHaveBeenCalledWith("0abc");
  });

  it("sends full text after delay when in copy mode", () => {
    const state = createInitialState();
    state.ttydSocket = makeMockSocket();
    state.copyModeActive = true;
    let scheduledFn: (() => void) | null = null;
    const deps = makeMockDeps({
      schedule: vi.fn((fn) => {
        scheduledFn = fn;
      }),
    });

    sendTextToTerminal(state, deps, "abc");

    // ESC sent first
    expect((state.ttydSocket as any).send).toHaveBeenCalledWith("0\u001b");
    // "abc" NOT sent yet — first char "a" is not lost
    expect((state.ttydSocket as any).send).not.toHaveBeenCalledWith("0abc");

    // After delay, full text including first char is sent
    scheduledFn!();
    expect((state.ttydSocket as any).send).toHaveBeenCalledWith("0abc");
  });
});
