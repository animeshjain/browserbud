// MAIN world content script — extracts transcript from YouTube's UI.
// Clicks the "Show transcript" button and parses the rendered DOM segments.
// Communicates with the ISOLATED world content script via window.postMessage.

export default defineContentScript({
  matches: ["*://*.youtube.com/*"],
  world: "MAIN",
  runAt: "document_idle",

  main() {
    const SENT_IDS = new Set<string>();

    function getVideoId(): string | null {
      return new URLSearchParams(location.search).get("v");
    }

    function getTranscriptSegments(): { timestamp: string; text: string }[] {
      const segments = document.querySelectorAll(
        "ytd-transcript-segment-renderer",
      );
      return Array.from(segments).map((seg) => ({
        timestamp:
          seg.querySelector(".segment-timestamp")?.textContent?.trim() || "",
        text: seg.querySelector(".segment-text")?.textContent?.trim() || "",
      }));
    }

    function findTranscriptButton(): HTMLButtonElement | null {
      const buttons = document.querySelectorAll(
        "button, yt-button-shape button, ytd-button-renderer button",
      );
      for (const btn of buttons) {
        const text =
          btn.textContent || btn.getAttribute("aria-label") || "";
        if (
          text.toLowerCase().includes("transcript") &&
          !text.toLowerCase().includes("disable")
        ) {
          return btn as HTMLButtonElement;
        }
      }
      return null;
    }

    function formatSegments(
      segments: { timestamp: string; text: string }[],
    ): string {
      return segments
        .filter((s) => s.text)
        .map((s) => (s.timestamp ? `[${s.timestamp}] ${s.text}` : s.text))
        .join("\n");
    }

    async function extractTranscript() {
      const videoId = getVideoId();
      if (!videoId || SENT_IDS.has(videoId)) return;

      // Check if transcript segments are already visible in the DOM
      let segments = getTranscriptSegments();

      if (segments.length === 0) {
        // Find and click the "Show transcript" button
        const btn = findTranscriptButton();
        if (!btn) {
          console.log(
            "[BrowserBud] No transcript button found for",
            videoId,
          );
          window.postMessage(
            { type: "BROWSERBUD_TRANSCRIPT_FAILED", videoId },
            "*",
          );
          return;
        }

        console.log("[BrowserBud] Clicking transcript button for", videoId);
        btn.click();

        // Wait for the transcript panel to render
        await new Promise((resolve) => setTimeout(resolve, 1500));

        segments = getTranscriptSegments();
      }

      if (segments.length === 0) {
        console.log(
          "[BrowserBud] No transcript segments found after clicking for",
          videoId,
        );
        window.postMessage(
          { type: "BROWSERBUD_TRANSCRIPT_FAILED", videoId },
          "*",
        );
        return;
      }

      const transcriptText = formatSegments(segments);
      SENT_IDS.add(videoId);

      // Get metadata from the page
      const player = document.querySelector("#movie_player") as any;
      const playerRes = player?.getPlayerResponse?.();
      const videoDetails = playerRes?.videoDetails;

      const meta = {
        title: videoDetails?.title || document.title.replace(/ - YouTube$/, "").trim(),
        channel: videoDetails?.author || "",
        duration: videoDetails?.lengthSeconds
          ? formatDuration(parseInt(videoDetails.lengthSeconds))
          : "",
        videoId,
        url: location.href,
      };

      console.log(
        `[BrowserBud] Extracted transcript for ${videoId}: ${segments.length} segments, ${transcriptText.length} chars`,
      );

      window.postMessage(
        {
          type: "BROWSERBUD_TRANSCRIPT",
          videoId,
          text: transcriptText,
          lang: "en",
          meta,
        },
        "*",
      );
    }

    function formatDuration(totalSeconds: number): string {
      const h = Math.floor(totalSeconds / 3600);
      const m = Math.floor((totalSeconds % 3600) / 60);
      const s = Math.floor(totalSeconds % 60);
      if (h > 0) {
        return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      }
      return `${m}:${String(s).padStart(2, "0")}`;
    }

    // Trigger on page load and SPA navigation
    extractTranscript();
    document.addEventListener("yt-navigate-finish", () => {
      setTimeout(extractTranscript, 2000);
    });
  },
});
