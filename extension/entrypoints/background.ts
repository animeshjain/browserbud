const SPRITE_URL = "https://aj-sprite-lgk.sprites.app";

export default defineBackground(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  // Forward context from content scripts to the sprite
  browser.runtime.onMessage.addListener((message) => {
    if (message.type === "context") {
      fetch(`${SPRITE_URL}/api/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message.data),
      }).catch((err) => console.error("BrowserBud: failed to send context", err));
    }
  });
});
