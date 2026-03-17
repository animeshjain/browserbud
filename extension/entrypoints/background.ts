import { storage } from "wxt/utils/storage";

const SERVER_URL_KEY = "local:serverUrl";
const DEFAULT_SERVER_URL = "http://localhost:8080";

const isChrome = !!globalThis.chrome?.sidePanel;

async function getServerUrl(): Promise<string> {
  const url = await storage.getItem<string>(SERVER_URL_KEY);
  return url || DEFAULT_SERVER_URL;
}

async function sendContext(data: Record<string, string>) {
  const serverUrl = await getServerUrl();
  fetch(`${serverUrl}/api/context`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }).catch((err) => console.error("BrowserBud: failed to send context", err));
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

export default defineBackground(() => {
  if (isChrome) {
    // Chrome: per-tab side panel — disabled globally, enabled per tab on click
    chrome.sidePanel.setOptions({ enabled: false });
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

    chrome.action.onClicked.addListener(async (tab) => {
      if (tab.id == null) return;
      await chrome.sidePanel.setOptions({
        tabId: tab.id,
        path: "sidepanel/index.html",
        enabled: true,
      });
      chrome.sidePanel.open({ tabId: tab.id });
    });
  } else {
    // Firefox MV2: browserAction (not action) + sidebarAction
    browser.browserAction.onClicked.addListener(() => {
      browser.sidebarAction.toggle();
    });
  }

  // Forward context and transcript data from content scripts to the server
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
    }
  });

  // When the user switches tabs, ask the content script for context
  // or clear context if the tab has no content script
  browser.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
      const response = await browser.tabs.sendMessage(tabId, {
        type: "getContext",
      });
      if (response) {
        sendContext(response);
      }
    } catch {
      // No content script on this tab — clear context
      sendContext({});
    }
  });
});
