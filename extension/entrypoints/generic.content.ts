import { extractPageContent } from "../lib/extract-page";

export default defineContentScript({
  matches: ["<all_urls>"],
  excludeMatches: ["*://*.youtube.com/*"],
  runAt: "document_idle",

  main() {
    let lastContextJson = "";
    let lastSelectionText = "";
    let selectionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let titleDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    // ─── Orphan-safe messaging ────────────────────────────────────────────────
    // After an extension reload, this content script is orphaned and any
    // browser.runtime.* call throws "Extension context invalidated" — and in
    // Chrome it throws *synchronously*, so .catch() alone won't help. Wrap every
    // send in try/catch and latch `isOrphaned` so subsequent event handlers
    // (selectionchange, mouseup, visibilitychange, title MutationObserver) no-op.
    let isOrphaned = false;

    function safeSendMessage(msg: any): Promise<any> {
      if (isOrphaned) return Promise.resolve();
      try {
        return Promise.resolve(browser.runtime.sendMessage(msg)).catch((err: any) => {
          if (String(err?.message).includes("Extension context invalidated")) {
            isOrphaned = true;
          }
        });
      } catch (err: any) {
        if (String(err?.message).includes("Extension context invalidated")) {
          isOrphaned = true;
        }
        return Promise.resolve();
      }
    }

    function getContext() {
      const url = window.location.href;
      const site = new URL(url).hostname.replace(/^www\./, "");
      const title = document.title.trim();

      const ctx: Record<string, any> = { site, title, url };

      const sel = window.getSelection();
      const selText = sel ? sel.toString().trim() : "";
      if (selText) {
        const lineCount = selText.split("\n").length;
        ctx.selection = { text: selText, lineCount };
      }

      return ctx;
    }

    function sendContext() {
      const ctx = getContext();
      const json = JSON.stringify(ctx);
      if (json === lastContextJson) return;
      lastContextJson = json;
      safeSendMessage({ type: "context", data: ctx });
    }

    function getPageContent() {
      return extractPageContent();
    }

    // ─── Message handling ─────────────────────────────────────────────────────

    const CAPABILITIES = ["getContext", "getPageContent"];

    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === "getContext") {
        sendResponse(getContext());
        return true;
      } else if (message.type === "getPageContent") {
        sendResponse(getPageContent());
        return true;
      } else if (message.type === "getCapabilities") {
        sendResponse({ capabilities: CAPABILITIES, url: window.location.href });
        return true;
      }
    });

    // ─── Initial context send ─────────────────────────────────────────────────

    sendContext();

    // Announce capabilities
    safeSendMessage({
      type: "contentScriptReady",
      capabilities: ["getContext", "getPageContent"],
      url: window.location.href,
    });

    // ─── Selection tracking ───────────────────────────────────────────────────

    document.addEventListener("selectionchange", () => {
      if (selectionDebounceTimer) clearTimeout(selectionDebounceTimer);
      selectionDebounceTimer = setTimeout(() => {
        const sel = window.getSelection();
        const selText = sel ? sel.toString().trim() : "";
        // In Chrome, clicking in the side panel fires selectionchange with empty selection.
        // Only clear selection if the page still has focus (user deselected on this page).
        if (!selText && !document.hasFocus()) return;
        if (selText === lastSelectionText) return;
        lastSelectionText = selText;
        sendContext();
      }, 300);
    });

    // Backup: mouseup reliably captures selection right when the user finishes selecting
    document.addEventListener("mouseup", () => {
      setTimeout(() => {
        const sel = window.getSelection();
        const selText = sel ? sel.toString().trim() : "";
        if (selText && selText !== lastSelectionText) {
          lastSelectionText = selText;
          sendContext();
        }
      }, 50);
    });

    // ─── SPA navigation detection ─────────────────────────────────────────────

    window.addEventListener("popstate", () => sendContext());
    window.addEventListener("hashchange", () => sendContext());

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        // Always re-push context on tab switch — another tab's context may have
        // been sent to the server in between, so bypass the dedup check.
        const ctx = getContext();
        lastContextJson = JSON.stringify(ctx);
        safeSendMessage({ type: "context", data: ctx });
      }
    });

    // Watch for title changes (many SPAs update title without navigation events)
    const titleEl = document.querySelector("title");
    if (titleEl) {
      new MutationObserver(() => {
        if (titleDebounceTimer) clearTimeout(titleDebounceTimer);
        titleDebounceTimer = setTimeout(sendContext, 500);
      }).observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
  },
});
