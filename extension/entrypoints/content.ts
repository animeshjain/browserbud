export default defineContentScript({
  matches: ["*://*.youtube.com/*"],
  runAt: "document_idle",

  main() {
    function getContext() {
      const url = window.location.href;
      const title = document.title
        .replace(/ - YouTube$/, "")
        .trim();

      if (url.includes("/watch")) {
        return { site: "youtube", title, url };
      }
      return { site: "youtube", title: "browsing", url };
    }

    function sendContext() {
      const context = getContext();
      browser.runtime.sendMessage({ type: "context", data: context });
    }

    // Respond to getContext requests from the background worker (tab switch)
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === "getContext") {
        sendResponse(getContext());
      }
    });

    sendContext();

    // YouTube fires this custom event on SPA navigation
    document.addEventListener("yt-navigate-finish", () => {
      // Title needs a moment to update after navigation
      setTimeout(sendContext, 1500);
    });
  },
});
