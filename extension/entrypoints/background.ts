const SPRITE_URL = "https://aj-sprite-lgk.sprites.app";

function sendContext(data: Record<string, string>) {
  fetch(`${SPRITE_URL}/api/context`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }).catch((err) => console.error("BrowserBud: failed to send context", err));
}

export default defineBackground(() => {
  // Disable the panel globally by default — it will only show on tabs
  // where the user explicitly clicks the icon
  chrome.sidePanel.setOptions({ enabled: false });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  // When the user clicks the action icon, enable the panel for that tab
  chrome.action.onClicked.addListener(async (tab) => {
    if (tab.id == null) return;
    await chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: "sidepanel/index.html",
      enabled: true,
    });
    chrome.sidePanel.open({ tabId: tab.id });
  });

  // Forward context from content scripts to the sprite
  browser.runtime.onMessage.addListener((message) => {
    if (message.type === "context") {
      sendContext(message.data);
    }
  });

  // When the user switches tabs, ask the content script for context
  // or clear context if the tab has no content script
  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
      const response = await browser.tabs.sendMessage(tabId, { type: "getContext" });
      if (response) {
        sendContext(response);
      }
    } catch {
      // No content script on this tab — clear context
      sendContext({});
    }
  });
});
