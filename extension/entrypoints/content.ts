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

    // Send context on load and on navigation (YouTube is a SPA)
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

    // YouTube uses SPA navigation — watch for URL changes
    let lastUrl = location.href;
    const observer = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        // Title updates slightly after URL change
        setTimeout(sendContext, 1000);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  },
});
