# Terminal Interaction Guide

This document explains how BrowserBud handles terminal scrollback, selection, copy, paste, and typed input inside the sidepanel ttyd iframe.

For the forward-looking cleanup and automated testing roadmap, see:

- [docs/terminal-refactor-and-testing-plan.md](/Users/animeshjain/Projects/browserbud/docs/terminal-refactor-and-testing-plan.md)

It exists because this area crosses four different systems:

1. Chrome/browser event handling
2. ttyd/xterm.js terminal rendering
3. tmux copy-mode and paste buffer
4. Claude Code running inside tmux

Small changes in one layer can easily regress another.

## Ownership Model

The current architecture intentionally splits responsibility like this:

- `tmux` owns scrollback and selection semantics.
- The injected BrowserBud bridge in `sprite/server.js` owns:
  - `postMessage` input from the extension
  - custom right-click menu
  - browser clipboard integration
  - translating paste/programmatic input into terminal input
- `start.sh` owns tmux key bindings and copy-mode behavior.

This is the key rule:

- Do not try to make both browser-native DOM selection and tmux copy-mode be the source of truth.

tmux is the source of truth for terminal selection.

## Files Involved

- `sprite/server.js`
  - injects `BRIDGE_SCRIPT` into ttyd HTML
  - serves `/api/clipboard`
  - serves `/api/bridge-log` for bridge debugging
- `sprite/start.sh`
  - configures tmux mouse behavior
  - configures copy-mode bindings
  - configures `escape-time`
- `extension/entrypoints/sidepanel/main.ts`
  - sends `browserbud:type-text` messages into the iframe

## Current Behavior

### Scrollback and Selection

- Mouse wheel up enters tmux copy-mode.
- Mouse drag selection stays visible after release via `copy-selection-no-clear`.
- Left-drag after scrolling up should start a selection, not snap back to the live bottom.

### Typing While Selected

- Normal typing in tmux copy-mode exits selection and forwards the key to Claude Code input.
- This is implemented in `sprite/start.sh` with tmux copy-mode key bindings.
- The bridge no longer tries to own “type exits selection” for normal keyboard typing.

### Programmatic Input and Paste

- Programmatic input from the extension, browser paste events, and custom-menu paste all use the bridge helper `sendTextToTerminal(text)`.
- `sendTextToTerminal(text)`:
  1. exits selection/copy-mode if needed
  2. sends `ESC` to tmux if copy-mode was active
  3. waits briefly before sending text so tmux does not interpret `ESC + first char` as `Alt+key`

### Copy

- Right-click `Copy` reads tmux’s paste buffer through `/api/clipboard`.
- `Cmd+C` / `Ctrl+C` uses bridge-side logic:
  - try browser selection text
  - then cached tmux selection text
  - then tmux paste buffer fallback

## Why `escape-time` Matters

tmux treats `ESC` specially and waits to decide whether it is a standalone escape or the start of a longer escape sequence.

Default `tmux escape-time` is too high here. If the bridge sends:

1. `ESC`
2. pasted text immediately after

tmux may consume the first pasted character as part of an `Alt+key` sequence.

Current mitigation:

- `sprite/start.sh` sets `escape-time 10`
- the bridge waits `50ms` after sending `ESC` before sending pasted/programmatic text

## Why `Cmd+C` Was Broken

The main failure mode was:

- tmux handled the selection internally
- browser DOM selection was empty
- the bridge shortcut path checked “selection active” too early or relied on empty DOM state
- so shortcut copy ran, but had no text source

The current implementation works by keeping multiple fallback sources:

1. browser DOM selection text
2. cached tmux selection text
3. `/api/clipboard` tmux paste buffer

## Debugging

### Runtime logs

The bridge can post structured debug events to:

- `POST /api/bridge-log`

These appear in `server.js` logs as `bridge event`.

Useful events:

- `copy-shortcut-keydown`
- `copy-shortcut-pass-through`
- `copy-shortcut-exec-result`
- `copy-event`
- `selection-cache-refresh`

### Clipboard endpoint

- `GET /api/clipboard`

Returns the tmux paste buffer, with soft-wrap unwrapping applied based on current pane width.

This is the fastest way to answer:

- did tmux actually populate the selection buffer?

### What to inspect first

If selection/copy/paste breaks:

1. Verify the bridge is injected:
   - `curl http://localhost:8989/browserbud-bridge.js`
2. Verify the root HTML includes the bridge:
   - `curl http://localhost:8989/`
3. Check tmux selection buffer:
   - `curl http://localhost:8989/api/clipboard`
4. Reproduce once and inspect `bridge event` logs

## Regression Checklist

After touching `sprite/server.js` or `sprite/start.sh`, test all of these:

1. Scroll up and drag-select text.
2. After scrollback selection, type `j`.
3. After scrollback selection, type `/`.
4. Right-click in the terminal and confirm BrowserBud custom menu appears.
5. Use custom-menu `Copy`.
6. Use custom-menu `Paste`.
7. Press `Cmd+V` or `Ctrl+V`.
8. Press `Cmd+C` or `Ctrl+C` with a selection.
9. Confirm `Ctrl+C` without a selection still reaches the terminal app on non-macOS.
10. Use extension-driven terminal input and confirm no first-character loss.

## Do Not Reintroduce

Avoid these patterns unless there is a strong reason:

- broad document/window keyboard ownership for all typing
- mixing tmux-owned selection with browser-owned selection as equal peers
- immediate `ESC` + text sends after copy-mode exit
- assuming browser DOM selection exists when tmux mouse mode is enabled

## Automated Test Strategy

Yes, tests can be added, but the current string-injected bridge architecture makes good automated tests harder than they should be.

The best path is:

1. Extract bridge logic from the big `BRIDGE_SCRIPT` string into a small source module.
2. Build the injected script from that module.
3. Add two layers of tests:
   - unit tests for pure bridge helpers
   - end-to-end browser tests for real ttyd/tmux behavior

### Good unit-test candidates

These can be tested with Node’s built-in test runner or Vitest:

- `sendTextToTerminal` timing behavior after `ESC`
- copy-source fallback ordering:
  - DOM selection
  - cached selection
  - `/api/clipboard`
- copy shortcut gating:
  - `Cmd+C`
  - `Ctrl+C` with selection
  - `Ctrl+C` without selection
- selection-cache refresh timing behavior

### Good end-to-end test candidates

Use Playwright against a running local BrowserBud stack:

1. Open sidepanel page or proxied ttyd page.
2. Scroll terminal history.
3. Drag-select text.
4. Trigger `Cmd+C` / `Ctrl+C`.
5. Read clipboard from Playwright/browser context.
6. Trigger `Cmd+V` / `Ctrl+V`.
7. Assert pasted text reaches the terminal.
8. Right-click and assert custom menu DOM appears.

### Minimum viable automation

If we want fast protection without a large refactor, the minimum useful step is:

- extract just the bridge helper functions into a testable module
- keep the ttyd integration thin
- add one Playwright smoke test for:
  - selection
  - `Cmd+C`
  - `Cmd+V`
  - typed input exits selection

That would catch most of the regressions we hit here.
