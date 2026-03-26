export default defineContentScript({
  matches: ["<all_urls>"],
  excludeMatches: ["*://*.youtube.com/*"],
  runAt: "document_idle",

  main() {
    let lastContextJson = "";
    let lastSelectionText = "";
    let selectionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let titleDebounceTimer: ReturnType<typeof setTimeout> | null = null;

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
      browser.runtime.sendMessage({ type: "context", data: ctx });
    }

    function getPageContent() {
      // Try semantic elements first
      const semantic = document.querySelector("article, main, [role='main']");
      if (semantic) {
        return {
          content: semantic.textContent?.trim() || "",
          title: document.title.trim(),
          url: window.location.href,
        };
      }

      // Fallback: clone body and strip non-content elements
      const clone = document.body.cloneNode(true) as HTMLElement;
      for (const tag of ["script", "style", "nav", "header", "footer", "aside", "noscript"]) {
        for (const el of clone.querySelectorAll(tag)) {
          el.remove();
        }
      }

      return {
        content: clone.textContent?.trim() || "",
        title: document.title.trim(),
        url: window.location.href,
      };
    }

    // ─── Message handling ─────────────────────────────────────────────────────

    const CAPABILITIES = ["getContext", "getPageContent"];

    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === "getContext") {
        sendResponse(getContext());
      } else if (message.type === "getPageContent") {
        sendResponse(getPageContent());
      } else if (message.type === "getCapabilities") {
        sendResponse({ capabilities: CAPABILITIES, url: window.location.href });
      }
    });

    // ─── Initial context send ─────────────────────────────────────────────────

    sendContext();

    // Announce capabilities
    browser.runtime.sendMessage({
      type: "contentScriptReady",
      capabilities: ["getContext", "getPageContent"],
      url: window.location.href,
    }).catch(() => {}); // side panel may not be open yet

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
        sendContext();
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
