# Terminal Refactor And Testing Plan

This document is the forward-looking companion to:

- [docs/terminal-interactions.md](/Users/animeshjain/Projects/browserbud/docs/terminal-interactions.md)

That guide explains how the terminal behaves today.
This document explains how to reduce complexity and how to add tests that prevent regressions.

## Why This Needs Refactoring

The current terminal interaction path works, but it is structurally fragile because important behavior is split across:

- `server/server.js`
  - the large injected `BRIDGE_SCRIPT` string
  - clipboard endpoints and debug endpoints
- `server/start.sh`
  - tmux copy-mode and mouse bindings
- `ttyd` / `xterm.js`
  - browser terminal rendering and event delivery
- `tmux`
  - scrollback, selection, paste buffer, copy-mode state

The main problems with the current shape are:

- bridge logic is embedded in a large string, which is hard to review and test
- runtime behavior depends on event ordering across browser, xterm, and tmux
- the boundary between “tmux owns selection” and “browser owns clipboard” is subtle
- regressions are easy to introduce with small local changes

## Refactor Goals

The goal is not to redesign the product. The goal is to make the existing design easier to reason about and safer to change.

We want:

1. One clear ownership model
2. Smaller and testable bridge logic
3. Fewer implicit event-order dependencies
4. Stable regression coverage for the user-visible terminal UX

## Desired Architecture

### Keep

Keep these decisions:

- `tmux` owns scrollback and selection semantics
- the proxy still injects a browser bridge into ttyd
- the extension still talks to ttyd through `postMessage`
- `start.sh` still owns tmux copy-mode bindings

These are aligned with the current architecture and do not need a rewrite.

### Change

Refactor these parts:

1. Move bridge logic out of the raw `BRIDGE_SCRIPT` string into a real source module.
2. Make the injected script a built artifact or generated string from testable code.
3. Separate bridge code into:
   - terminal transport helpers
   - selection state helpers
   - clipboard helpers
   - debug/logging helpers
4. Limit bridge event hooks to the smallest set that actually matters.
5. Add automated tests around the exact user flows that broke.

## Proposed Refactor Phases

### Phase 1: Extract Bridge Helpers

Create a source file for bridge logic, for example:

- `server/bridge/terminal_bridge.ts`

Target shape:

- pure helpers with explicit inputs/outputs
- one small bootstrap layer that wires them to `window`, `document`, and ttyd

Suggested helper boundaries:

- `sendTerminalInput(socket, text)`
- `exitSelectionMode(state, deps)`
- `sendTextToTerminal(state, deps, text)`
- `copySelectionToClipboard(state, deps)`
- `refreshSelectionCache(state, deps)`
- `isCopyShortcut(event)`

The important point is that the logic should become testable without running ttyd or Chrome.

### Phase 2: Isolate Mutable State

Right now bridge state is spread across top-level variables:

- `ttydSocket`
- `copyModeActive`
- `pointerSelecting`
- `selectionLatched`
- `cachedSelectionText`

Wrap that into one explicit state object.

Example shape:

```ts
type BridgeState = {
  ttydSocket: WebSocket | null;
  copyModeActive: boolean;
  pointerSelecting: boolean;
  selectionLatched: boolean;
  cachedSelectionText: string;
};
```

This makes state transitions much easier to test.

### Phase 3: Reduce Browser API Coupling

Introduce a small dependency object instead of calling globals directly everywhere.

Example:

```ts
type BridgeDeps = {
  getSelectionText: () => string;
  clearSelection: () => boolean;
  focusTerminal: () => void;
  readClipboardText: () => Promise<string>;
  writeClipboardText: (text: string) => Promise<void>;
  readTmuxClipboard: () => Promise<string>;
  sendToSocket: (text: string) => boolean;
  schedule: (fn: () => void, ms: number) => void;
  log: (event: string, details?: Record<string, unknown>) => void;
};
```

This is the single biggest step toward easy unit tests.

### Phase 4: Keep Runtime Wiring Thin

After extraction, the runtime bridge should mostly do:

1. initialize state
2. capture ttyd WebSocket
3. bind event listeners
4. delegate to helpers

If the runtime file still contains business logic, the extraction is incomplete.

## What Not To Refactor Right Now

Avoid these larger rewrites for now:

- replacing ttyd entirely
- replacing tmux with browser-native scrollback
- moving to a fully custom xterm frontend

Those may be valid long-term options, but they are not needed to reduce regression risk in the current codebase.

## Testing Strategy

There should be two layers of tests.

### 1. Unit Tests

These should cover the bridge logic in isolation.

Good candidates:

- `sendTextToTerminal`
  - sends text immediately when no ESC is required
  - delays text after ESC when copy-mode was active
- copy fallback ordering
  - DOM selection
  - cached selection
  - tmux clipboard fallback
- shortcut handling
  - `Cmd+C` triggers copy path
  - `Ctrl+C` without selection passes through
  - `Ctrl+C` with selection triggers copy path
- selection cache behavior
  - refresh after drag end
  - empty cache clears correctly
- paste behavior
  - paste exits copy-mode if needed
  - paste does not lose first character

### 2. End-To-End Tests

These should validate real browser + ttyd + tmux behavior.

Use Playwright.

The minimum smoke suite should cover:

1. Open BrowserBud terminal UI
2. Scroll terminal history
3. Drag-select visible text
4. Type a printable key and verify selection exits
5. Trigger right-click and verify BrowserBud custom menu appears
6. Use custom-menu copy and verify clipboard contents
7. Trigger `Cmd+C` / `Ctrl+C` and verify clipboard contents
8. Trigger `Cmd+V` / `Ctrl+V` and verify text reaches terminal
9. Trigger extension-driven input and verify the first character is not dropped

If only one end-to-end test is added initially, it should cover:

- selection after scrollback
- `Cmd+C`
- `Cmd+V`
- typing exits selection

That single test would have caught most of the bugs from this round.

## Practical Test Harness Plan

### Short Term

Use Node’s built-in test runner or Vitest for unit tests.

Recommended first step:

1. extract bridge helpers into a module
2. add a tiny test harness with mocked dependencies
3. assert helper behavior directly

### Medium Term

Add Playwright and one local-browser smoke test.

The test runner does not need to boot the full extension immediately.
It can start by targeting:

- the proxied ttyd page at `http://localhost:8989/`

That avoids extension-specific complexity while still testing the fragile bridge/tmux path.

### Long Term

If terminal behavior remains a high-change area, add a proper dev test command that:

1. boots BrowserBud
2. waits for ttyd
3. runs Playwright smoke tests
4. tears everything down

## Recommended Initial Work Items

If we do this incrementally, the highest-value sequence is:

1. Extract bridge logic into a real module
2. Add unit tests for:
   - `sendTextToTerminal`
   - copy fallback ordering
   - shortcut gating
3. Add one Playwright smoke test for:
   - scrollback selection
   - `Cmd+C`
   - `Cmd+V`
   - typing exits selection
4. Keep `/api/bridge-log` behind a debug flag or remove it once tests are reliable

## Definition Of Done

This area is in a good state when:

- terminal bridge logic is no longer maintained primarily as a large inline string
- core selection/clipboard behavior is unit-tested
- at least one Playwright smoke test protects the fragile terminal UX path
- manual regression testing becomes a confirmation step, not the main defense

## Suggested Future Commands

Once implemented, the repo should ideally have commands like:

```bash
npm run test:bridge
npm run test:terminal-e2e
```

Or a combined command:

```bash
npm run test:terminal
```

At the moment, those do not exist. This document is the plan for adding them.
