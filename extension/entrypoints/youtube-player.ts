// MAIN world content script — extracts YouTube transcripts via XHR interception.
// When triggered, toggles CC on to force YouTube's player to fetch captions
// (with its internal POT token), intercepts the XHR response, and parses JSON3.
// Communicates with the ISOLATED world content script via window.postMessage.

export default defineContentScript({
  matches: ["*://*.youtube.com/*"],
  world: "MAIN",
  runAt: "document_idle",

  main() {
    // ─── Helpers ──────────────────────────────────────────────────────────

    function getVideoId(): string | null {
      return new URLSearchParams(location.search).get("v");
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

    function getPlayer(): HTMLElement | null {
      return document.getElementById("movie_player");
    }

    function getVideoMeta(): Record<string, string> {
      const player = getPlayer() as any;
      const playerRes = player?.getPlayerResponse?.();
      const videoDetails = playerRes?.videoDetails;
      const videoId = getVideoId() || "";
      return {
        title:
          videoDetails?.title ||
          document.title.replace(/ - YouTube$/, "").trim(),
        channel: videoDetails?.author || "",
        duration: videoDetails?.lengthSeconds
          ? formatDuration(parseInt(videoDetails.lengthSeconds))
          : "",
        videoId,
        url: location.href,
      };
    }

    function isCCActive(): boolean {
      const ccBtn = document.querySelector(".ytp-subtitles-button");
      return ccBtn?.getAttribute("aria-pressed") === "true";
    }

    function toggleCC(): void {
      const ccBtn = document.querySelector(
        ".ytp-subtitles-button",
      ) as HTMLButtonElement | null;
      if (ccBtn) ccBtn.click();
    }

    // ─── JSON3 Parsing ──────────────────────────────────────────────────

    function parseJson3(json3: any): { startMs: number; text: string }[] {
      const segments: { startMs: number; text: string }[] = [];
      for (const event of json3?.events || []) {
        if (!event.segs) continue;
        const text = event.segs
          .map((s: any) => s.utf8 || "")
          .join("")
          .trim();
        if (text && text !== "\n") {
          segments.push({ startMs: event.tStartMs || 0, text });
        }
      }
      return segments;
    }

    function formatSegments(
      segments: { startMs: number; text: string }[],
    ): string {
      return segments
        .map((s) => {
          const totalSec = Math.floor(s.startMs / 1000);
          const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
          const ss = String(totalSec % 60).padStart(2, "0");
          return `[${mm}:${ss}] ${s.text}`;
        })
        .join("\n");
    }

    // ─── XHR Interception ───────────────────────────────────────────────

    interface PendingExtraction {
      requestId: string;
      videoId: string;
      wasCCActive: boolean;
      timeout: ReturnType<typeof setTimeout>;
    }

    let pendingExtraction: PendingExtraction | null = null;

    const OriginalOpen = XMLHttpRequest.prototype.open;
    const OriginalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      ...args: any[]
    ) {
      (this as any)._browserbud_url = url.toString();
      return OriginalOpen.apply(this, [method, url, ...args] as any);
    };

    XMLHttpRequest.prototype.send = function (...args: any[]) {
      const url = (this as any)._browserbud_url || "";
      if (url.includes("/api/timedtext") && pendingExtraction) {
        const extraction = pendingExtraction;
        this.addEventListener("load", function () {
          if (
            !extraction ||
            extraction.requestId !== pendingExtraction?.requestId
          )
            return;
          if (this.status !== 200 || this.responseText.length === 0) return;

          try {
            const json3 = JSON.parse(this.responseText);
            const segments = parseJson3(json3);
            const text = formatSegments(segments);
            const meta = getVideoMeta();

            clearTimeout(extraction.timeout);
            pendingExtraction = null;

            // Restore CC state
            if (!extraction.wasCCActive) {
              setTimeout(() => toggleCC(), 200);
            }

            console.log(
              `[BrowserBud] Extracted ${segments.length} segments for ${extraction.videoId}`,
            );

            window.postMessage(
              {
                type: "BROWSERBUD_EXTRACT_TRANSCRIPT_RESULT",
                requestId: extraction.requestId,
                success: true,
                text,
                lang: "en",
                meta,
              },
              "*",
            );
          } catch (err) {
            console.warn("[BrowserBud] Failed to parse timedtext:", err);
          }
        });
      }
      return OriginalSend.apply(this, args as any);
    };

    // ─── Extraction Trigger ─────────────────────────────────────────────

    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      if (event.data?.type !== "BROWSERBUD_EXTRACT_TRANSCRIPT") return;

      const { videoId, requestId } = event.data;

      // Verify we're on the right video
      const currentVideoId = getVideoId();
      if (currentVideoId !== videoId) {
        window.postMessage(
          {
            type: "BROWSERBUD_EXTRACT_TRANSCRIPT_RESULT",
            requestId,
            success: false,
            error: `Wrong video: on ${currentVideoId}, requested ${videoId}`,
          },
          "*",
        );
        return;
      }

      // Check if player and CC button exist
      const ccBtn = document.querySelector(".ytp-subtitles-button");
      if (!ccBtn) {
        window.postMessage(
          {
            type: "BROWSERBUD_EXTRACT_TRANSCRIPT_RESULT",
            requestId,
            success: false,
            error: "No CC button found (video may not have captions)",
          },
          "*",
        );
        return;
      }

      const wasCCActive = isCCActive();

      const timeout = setTimeout(() => {
        if (pendingExtraction?.requestId === requestId) {
          pendingExtraction = null;
          // Restore CC state
          if (!wasCCActive && isCCActive()) toggleCC();
          window.postMessage(
            {
              type: "BROWSERBUD_EXTRACT_TRANSCRIPT_RESULT",
              requestId,
              success: false,
              error: "Timed out waiting for timedtext XHR",
            },
            "*",
          );
        }
      }, 10000);

      pendingExtraction = { requestId, videoId, wasCCActive, timeout };

      // Load captions module and toggle CC to trigger the XHR
      const player = getPlayer() as any;
      if (player?.loadModule) {
        player.loadModule("captions");
      }

      if (wasCCActive) {
        // Turn off first, then back on to force a fresh XHR
        toggleCC();
        setTimeout(() => toggleCC(), 500);
      } else {
        setTimeout(() => toggleCC(), 300);
      }
    });
  },
});
