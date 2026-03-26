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

    // Cache of last known player time (populated by MAIN world responses)
    let lastPlayerTime: { currentTime: number; state: string } | null = null;

    function getContext() {
      const url = window.location.href;
      const title = document.title
        .replace(/ - YouTube$/, "")
        .trim();

      if (url.includes("/watch")) {
        if (lastPlayerTime) {
          const sec = Math.floor(lastPlayerTime.currentTime);
          const mm = String(Math.floor(sec / 60)).padStart(2, "0");
          const ss = String(sec % 60).padStart(2, "0");
          return {
            site: "youtube",
            title: `${title} (${lastPlayerTime.state} at ${mm}:${ss})`,
            url,
          };
        }
        return { site: "youtube", title, url };
      }
      return { site: "youtube", title: "browsing", url };
    }

    // Periodically ask the MAIN world for player time so context stays fresh
    function requestPlayerTime() {
      if (!window.location.href.includes("/watch")) return;
      window.postMessage({ type: "BROWSERBUD_GET_PLAYER_STATE", requestId: "__context_poll__" }, "*");
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

    function getPageContent() {
      // On watch pages, extract the video description
      const descEl = document.querySelector(
        "#description-inline-expander, ytd-text-inline-expander, ytd-expander[id='description']",
      );
      if (descEl) {
        return {
          content: descEl.textContent?.trim() || "",
          title: document.title.replace(/ - YouTube$/, "").trim(),
          url: window.location.href,
        };
      }

      // Fallback: clone body and strip non-content elements
      const clone = document.body.cloneNode(true) as HTMLElement;
      for (const tag of ["script", "style", "nav", "header", "footer", "aside", "noscript"]) {
        for (const el of clone.querySelectorAll(tag)) {
          el.remove();
        }
      }

      return {
        content: clone.textContent?.trim() || "",
        title: document.title.replace(/ - YouTube$/, "").trim(),
        url: window.location.href,
      };
    }

    const CAPABILITIES = ["getContext", "extractTranscript", "extractComments", "getPlayerState", "getPageContent"];

    // Respond to messages from the side panel / background worker
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === "getCapabilities") {
        sendResponse({ capabilities: CAPABILITIES, url: window.location.href });
      } else if (message.type === "getContext") {
        sendResponse(getContext());
      } else if (message.type === "getPageContent") {
        sendResponse(getPageContent());
      } else if (message.type === "extractTranscript") {
        // Forward to MAIN world script via postMessage
        window.postMessage(
          {
            type: "BROWSERBUD_EXTRACT_TRANSCRIPT",
            videoId: message.videoId,
            requestId: message.requestId,
          },
          "*",
        );
      } else if (message.type === "extractComments") {
        // Forward to MAIN world script via postMessage
        window.postMessage(
          {
            type: "BROWSERBUD_EXTRACT_COMMENTS",
            videoId: message.videoId,
            requestId: message.requestId,
            maxComments: message.maxComments,
            includeReplies: message.includeReplies,
            minLikesForReplies: message.minLikesForReplies,
            minRepliesForReplies: message.minRepliesForReplies,
          },
          "*",
        );
      } else if (message.type === "getPlayerState") {
        // Forward to MAIN world script via postMessage
        window.postMessage(
          {
            type: "BROWSERBUD_GET_PLAYER_STATE",
            requestId: message.requestId,
          },
          "*",
        );
      }
    });

    sendContext();

    // Poll player time every 5s so context includes approximate position
    setInterval(() => {
      requestPlayerTime();
    }, 5000);
    // Initial request after MAIN world script loads
    setTimeout(requestPlayerTime, 2000);

    // YouTube fires this custom event on SPA navigation
    document.addEventListener("yt-navigate-finish", () => {
      // Title needs a moment to update after navigation
      lastPlayerTime = null;
      setTimeout(() => {
        sendContext();
        removeCaptureButton();
        injectCaptureButton();
        requestPlayerTime();
      }, 1500);
    });

    // Initial injection
    if (window.location.href.includes("/watch")) {
      setTimeout(injectCaptureButton, 1500);
    }

    // Announce capabilities
    browser.runtime.sendMessage({
      type: "contentScriptReady",
      capabilities: ["getContext", "extractTranscript", "extractComments", "getPlayerState", "getPageContent"],
      url: window.location.href,
    }).catch(() => {}); // side panel may not be open yet

    // Listen for messages from MAIN world content script
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
      } else if (event.data?.type === "BROWSERBUD_EXTRACT_TRANSCRIPT_RESULT") {
        browser.runtime.sendMessage({
          type: "transcriptResult",
          requestId: event.data.requestId,
          success: event.data.success,
          text: event.data.text,
          lang: event.data.lang,
          meta: event.data.meta,
          error: event.data.error,
        });
      } else if (event.data?.type === "BROWSERBUD_EXTRACT_COMMENTS_RESULT") {
        browser.runtime.sendMessage({
          type: "commentsResult",
          requestId: event.data.requestId,
          success: event.data.success,
          comments: event.data.comments,
          totalCount: event.data.totalCount,
          meta: event.data.meta,
          error: event.data.error,
        });
      } else if (event.data?.type === "BROWSERBUD_PLAYER_STATE_RESULT") {
        // Update cached player time for context enrichment
        if (event.data.currentTime !== undefined) {
          lastPlayerTime = {
            currentTime: event.data.currentTime,
            state: event.data.state || "unknown",
          };
        }
        // Only forward to background if it's a real request (not our poll)
        if (event.data.requestId !== "__context_poll__") {
          const { type: _ignored, ...rest } = event.data;
          browser.runtime.sendMessage({
            type: "playerStateResult",
            ...rest,
          });
        }
      }
    });
  },
});
