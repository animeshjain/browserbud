const SPRITE_URL = "https://aj-sprite-lgk.sprites.app";

const isChrome = !!globalThis.chrome?.sidePanel;

function sendContext(data: Record<string, string>) {
  fetch(`${SPRITE_URL}/api/context`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }).catch((err) => console.error("BrowserBud: failed to send context", err));
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

  // Forward context from content scripts to the sprite
  browser.runtime.onMessage.addListener((message) => {
    if (message.type === "context") {
      sendContext(message.data);
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
