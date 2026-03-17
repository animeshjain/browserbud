export default defineContentScript({
  matches: ["*://*.youtube.com/*"],
  runAt: "document_idle",

  main() {
    // Inject the MAIN world script for YouTube player API access
    const script = document.createElement("script");
    script.src = browser.runtime.getURL("/youtube-player.js");
    document.documentElement.appendChild(script);
    script.onload = () => script.remove();

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

    // Listen for transcript data from MAIN world content script
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;

      if (event.data?.type === "BROWSERBUD_TRANSCRIPT") {
        const { videoId, text, lang, meta } = event.data;
        browser.runtime.sendMessage({
          type: "transcript",
          videoId,
          text,
          lang,
          meta,
          source: "client",
        });
      }
    });
  },
});
