// Background worker — Chrome MV3 service worker / Firefox MV2 persistent page.
//
// CHROME MV3 PITFALLS (these have caused repeated regressions):
//
// 1. Service worker lifetime: Chrome kills the worker as soon as all event
//    callbacks return. Any async work (fetch, storage) must be returned as a
//    Promise from the listener so Chrome knows to keep the worker alive.
//    → Always `return asyncFn()` from onMessage listeners, never fire-and-forget.
//
// 2. Content script orphaning: Reloading the extension in chrome://extensions
//    orphans content scripts on existing tabs — tabs.sendMessage() will throw.
//    → Always handle sendMessage failure and fall back to browser.tabs.get()
//    for basic context (URL, title). Never assume a content script is reachable.
//
// 3. API compat: Use browser.* (WXT), never chrome.* directly (except for
//    Chrome-only APIs like chrome.sidePanel behind browser checks).

import { storage } from "wxt/utils/storage";

const SERVER_URL_KEY = "local:serverUrl";
const DEFAULT_SERVER_URL = "http://localhost:8989";

const isChrome = !!globalThis.chrome?.sidePanel;

async function getServerUrl(): Promise<string> {
  const url = await storage.getItem<string>(SERVER_URL_KEY);
  return url || DEFAULT_SERVER_URL;
}

async function sendContext(data: Record<string, string>) {
  const serverUrl = await getServerUrl();
  try {
    await fetch(`${serverUrl}/api/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  } catch (err) {
    console.error("BrowserBud: failed to send context", err);
  }
}

async function sendTranscript(data: {
  videoId: string;
  text: string;
  lang: string;
  meta: Record<string, string>;
  source: string;
}) {
  const serverUrl = await getServerUrl();
  try {
    const res = await fetch(`${serverUrl}/api/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const result = await res.json();
    if (result.ok) {
      console.log(`BrowserBud: transcript cached for ${data.videoId}`);
    }
  } catch (err) {
    console.error("BrowserBud: failed to send transcript", err);
  }
}

async function sendFrame(videoId: string, timestamp: number, image: string) {
  const serverUrl = await getServerUrl();
  const res = await fetch(`${serverUrl}/api/frame`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, timestamp, image }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/frame failed (${res.status}): ${text}`);
  }
  const result = await res.json();
  if (!result.ok || !result.path) {
    throw new Error(`POST /api/frame unexpected response: ${JSON.stringify(result)}`);
  }
  console.log(`BrowserBud: frame saved to ${result.path}`);
  // Type the file reference into Claude Code's terminal input
  browser.runtime.sendMessage({
    type: "typeInTerminal",
    text: `@${result.path} `,
  });
}

export default defineBackground(() => {
  if (isChrome) {
    // Chrome: clicking the action icon toggles the side panel per-tab.
    // Chrome's sidePanel API already handles per-tab visibility natively.
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } else {
    // Firefox MV2: browserAction (not action) + sidebarAction
    browser.browserAction.onClicked.addListener(() => {
      browser.sidebarAction.toggle();
    });
  }

  // Forward context, transcript, and frame data from content scripts to the server.
  // Returning the promise keeps Chrome's MV3 service worker alive until the
  // fetch completes (Firefox background pages don't need this but it's harmless).
  browser.runtime.onMessage.addListener((message) => {
    if (message.type === "context") {
      return sendContext(message.data);
    } else if (message.type === "transcript") {
      return sendTranscript({
        videoId: message.videoId,
        text: message.text,
        lang: message.lang,
        meta: message.meta,
        source: message.source,
      });
    } else if (message.type === "captureFrame") {
      return sendFrame(message.videoId, message.timestamp, message.image);
    }
  });

  // Shared helper: query the active tab's content script for context.
  // Falls back to tab metadata when the content script isn't reachable
  // (e.g. after extension reload in Chrome MV3, or on restricted pages).
  async function refreshContextForTab(tabId: number) {
    try {
      const response = await browser.tabs.sendMessage(tabId, {
        type: "getContext",
      });
      if (response) {
        await sendContext(response);
        return;
      }
    } catch {
      // Content script not reachable — fall through to tab metadata
    }

    // Fallback: construct basic context from tab metadata
    try {
      const tab = await browser.tabs.get(tabId);
      if (tab.url && !/^(chrome|about|edge|brave):/.test(tab.url)) {
        const site = new URL(tab.url).hostname.replace(/^www\./, "");
        await sendContext({ site, title: tab.title || site, url: tab.url });
      } else {
        await sendContext({});
      }
    } catch {
      await sendContext({});
    }
  }

  // When the user switches tabs, update context
  browser.tabs.onActivated.addListener(async ({ tabId }) => {
    await refreshContextForTab(tabId);
  });

  // When a browser window gains focus, update context for its active tab
  // (handles switching between browser windows or returning from another app)
  browser.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === browser.windows.WINDOW_ID_NONE) return;
    const [tab] = await browser.tabs.query({ active: true, windowId });
    if (tab?.id) {
      await refreshContextForTab(tab.id);
    }
  });

});
