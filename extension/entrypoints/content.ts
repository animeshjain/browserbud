export default defineContentScript({
  matches: ["*://*.youtube.com/*"],
  runAt: "document_idle",

  main() {
    // Inject the MAIN world script for YouTube player API access
    const script = document.createElement("script");
    script.src = browser.runtime.getURL("/youtube-player.js");
    document.documentElement.appendChild(script);
    script.onload = () => script.remove();

    function getVideoId(): string | null {
      return new URLSearchParams(window.location.search).get("v");
    }

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

    // ─── Frame Capture ────────────────────────────────────────────────────

    function captureFrame() {
      console.log("[BrowserBud] captureFrame called");
      const video = document.querySelector("video");
      if (!video) {
        console.warn("[BrowserBud] No video element found");
        return;
      }
      const videoId = getVideoId();
      if (!videoId) {
        console.warn("[BrowserBud] No videoId found");
        return;
      }

      console.log("[BrowserBud] Capturing frame:", videoId, "at", video.currentTime);
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.drawImage(video, 0, 0);

      let imageData: string;
      try {
        imageData = canvas.toDataURL("image/jpeg", 0.85);
      } catch (e) {
        console.error("[BrowserBud] Canvas tainted (CORS), cannot capture frame");
        return;
      }

      console.log("[BrowserBud] Frame captured, size:", imageData.length);
      const timestamp = video.currentTime;
      browser.runtime.sendMessage({
        type: "captureFrame",
        videoId,
        timestamp,
        image: imageData,
      });
    }

    // ─── Capture Button ───────────────────────────────────────────────────

    let captureBtn: HTMLButtonElement | null = null;

    function injectCaptureButton() {
      if (captureBtn) return;
      if (!window.location.href.includes("/watch")) return;

      console.log("[BrowserBud] Injecting capture button");

      captureBtn = document.createElement("button");
      captureBtn.id = "browserbud-capture";
      captureBtn.title = "Capture frame for BrowserBud";
      captureBtn.textContent = "\u{1F4F7}"; // camera emoji
      captureBtn.style.cssText = `
        position: absolute;
        top: 10px;
        right: 10px;
        z-index: 99999;
        width: 36px;
        height: 36px;
        border: none;
        border-radius: 50%;
        background: rgba(0,0,0,0.7);
        color: white;
        font-size: 18px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 1;
        pointer-events: auto;
      `;

      // Use capture phase to beat YouTube's event handling
      captureBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        console.log("[BrowserBud] Capture button clicked");
        captureFrame();
        // Brief visual feedback
        if (captureBtn) {
          captureBtn.style.background = "rgba(88,101,242,0.8)";
          setTimeout(() => {
            if (captureBtn) captureBtn.style.background = "rgba(0,0,0,0.7)";
          }, 300);
        }
      }, true);

      // Attach to the video player container
      const player = document.querySelector("#movie_player");
      if (player) {
        (player as HTMLElement).style.position = "relative";
        player.appendChild(captureBtn);
        console.log("[BrowserBud] Capture button attached to #movie_player");
      } else {
        console.warn("[BrowserBud] #movie_player not found");
      }
    }

    function removeCaptureButton() {
      if (captureBtn) {
        captureBtn.remove();
        captureBtn = null;
      }
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
      setTimeout(() => {
        sendContext();
        removeCaptureButton();
        injectCaptureButton();
      }, 1500);
    });

    // Initial injection
    if (window.location.href.includes("/watch")) {
      setTimeout(injectCaptureButton, 1500);
    }

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
