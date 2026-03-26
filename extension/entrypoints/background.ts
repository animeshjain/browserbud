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
  fetch(`${serverUrl}/api/transcript`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
    .then((res) => res.json())
    .then((result) => {
      if (result.ok) {
        console.log(`BrowserBud: transcript cached for ${data.videoId}`);
      }
    })
    .catch((err) =>
      console.error("BrowserBud: failed to send transcript", err),
    );
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

  // Forward context, transcript, and frame data from content scripts to the server
  browser.runtime.onMessage.addListener((message) => {
    if (message.type === "context") {
      sendContext(message.data);
    } else if (message.type === "transcript") {
      sendTranscript({
        videoId: message.videoId,
        text: message.text,
        lang: message.lang,
        meta: message.meta,
        source: message.source,
      });
    } else if (message.type === "captureFrame") {
      sendFrame(message.videoId, message.timestamp, message.image);
    }
  });

  // Shared helper: query the active tab's content script for context
  async function refreshContextForTab(tabId: number) {
    try {
      const response = await browser.tabs.sendMessage(tabId, {
        type: "getContext",
      });
      if (response) {
        await sendContext(response);
      }
    } catch {
      // No content script on this tab — clear context
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
