// MAIN world content script — extracts transcript data from YouTube's player API.
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

    interface CaptionTrack {
      baseUrl: string;
      languageCode: string;
      name?: { simpleText?: string };
      kind?: string;
    }

    interface TranscriptSegment {
      start: number;
      duration: number;
      text: string;
    }

    function parseJson3(json: any): TranscriptSegment[] {
      const events = json?.events;
      if (!Array.isArray(events)) return [];
      const segments: TranscriptSegment[] = [];
      for (const ev of events) {
        if (!ev.segs) continue;
        const text = ev.segs.map((s: any) => s.utf8 || "").join("").trim();
        if (!text) continue;
        segments.push({
          start: (ev.tStartMs || 0) / 1000,
          duration: (ev.dDurationMs || 0) / 1000,
          text,
        });
      }
      return segments;
    }

    function parseXml(xmlText: string): TranscriptSegment[] {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, "text/xml");
      const texts = doc.querySelectorAll("text");
      const segments: TranscriptSegment[] = [];
      for (const el of texts) {
        const text = (el.textContent || "").trim();
        if (!text) continue;
        segments.push({
          start: parseFloat(el.getAttribute("start") || "0"),
          duration: parseFloat(el.getAttribute("dur") || "0"),
          text,
        });
      }
      return segments;
    }

    function formatTimestamp(seconds: number): string {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      if (h > 0) {
        return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      }
      return `${m}:${String(s).padStart(2, "0")}`;
    }

    function segmentsToText(segments: TranscriptSegment[]): string {
      return segments
        .map((seg) => `[${formatTimestamp(seg.start)}] ${seg.text}`)
        .join("\n");
    }

    function decodeHtmlEntities(text: string): string {
      const el = document.createElement("textarea");
      el.innerHTML = text;
      return el.value;
    }

    function xhrFetch(url: string): Promise<string> {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.withCredentials = true;
        xhr.onload = () => resolve(xhr.responseText);
        xhr.onerror = () => reject(new Error(`XHR failed: ${xhr.status}`));
        xhr.send();
      });
    }

    async function extractTranscript() {
      const videoId = getVideoId();
      if (!videoId || SENT_IDS.has(videoId)) return;

      const player = document.querySelector("#movie_player") as any;
      if (!player?.getPlayerResponse) {
        console.log("[BrowserBud] No player or getPlayerResponse for", videoId);
        return;
      }

      const playerRes = player.getPlayerResponse();
      if (!playerRes) {
        console.log("[BrowserBud] getPlayerResponse() returned null for", videoId);
        return;
      }

      const captions = playerRes?.captions;
      const tracks: CaptionTrack[] | undefined =
        captions?.playerCaptionsTracklistRenderer?.captionTracks;
      console.log("[BrowserBud] Caption tracks for", videoId, ":", JSON.stringify(tracks?.map((t: CaptionTrack) => ({ lang: t.languageCode, kind: t.kind, url: t.baseUrl?.slice(0, 80) })) || null));

      if (!tracks?.length) {
        console.log("[BrowserBud] No caption tracks found for", videoId);
        window.postMessage(
          { type: "BROWSERBUD_TRANSCRIPT_FAILED", videoId },
          "*",
        );
        return;
      }

      // Prefer non-auto-generated English, then any English, then first track
      const englishTrack = tracks.find(
        (t) => t.languageCode === "en" && t.kind !== "asr",
      );
      const autoEnglish = tracks.find(
        (t) => t.languageCode === "en" && t.kind === "asr",
      );
      const track = englishTrack || autoEnglish || tracks[0];
      const lang = track.languageCode;
      console.log("[BrowserBud] Selected track:", lang, track.kind || "manual");

      // Extract metadata from player response
      const videoDetails = playerRes?.videoDetails;
      const meta = {
        title: videoDetails?.title || "",
        channel: videoDetails?.author || "",
        duration: videoDetails?.lengthSeconds
          ? formatTimestamp(parseInt(videoDetails.lengthSeconds))
          : "",
        videoId,
        url: location.href,
      };

      // Try fetching transcript via XHR (fetch returns empty on YouTube)
      for (const fmt of ["json3", ""]) {
        const url = fmt ? `${track.baseUrl}&fmt=${fmt}` : track.baseUrl;
        try {
          const text = await xhrFetch(url);
          const fmtLabel = fmt || "xml";
          console.log(`[BrowserBud] XHR fmt=${fmtLabel}: ${text.length} bytes`);
          if (!text || text.length < 10) continue;

          let segments: TranscriptSegment[];
          if (fmt === "json3") {
            const json = JSON.parse(text);
            segments = parseJson3(json);
          } else {
            segments = parseXml(text);
          }

          console.log(`[BrowserBud] Parsed ${segments.length} segments from fmt=${fmtLabel}`);
          if (segments.length === 0) continue;

          // Decode HTML entities in segment text
          for (const seg of segments) {
            seg.text = decodeHtmlEntities(seg.text);
          }

          const transcriptText = segmentsToText(segments);
          SENT_IDS.add(videoId);
          console.log(
            `[BrowserBud] Extracted transcript for ${videoId}: ${segments.length} segments, ${transcriptText.length} chars`,
          );

          window.postMessage(
            {
              type: "BROWSERBUD_TRANSCRIPT",
              videoId,
              text: transcriptText,
              lang,
              meta,
            },
            "*",
          );
          return;
        } catch (err) {
          console.warn(`[BrowserBud] Failed to fetch transcript (fmt=${fmt}):`, err);
        }
      }

      // All formats failed
      console.log("[BrowserBud] All transcript formats failed for", videoId);
      window.postMessage(
        { type: "BROWSERBUD_TRANSCRIPT_FAILED", videoId },
        "*",
      );
    }

    // Trigger on page load and SPA navigation
    extractTranscript();
    document.addEventListener("yt-navigate-finish", () => {
      setTimeout(extractTranscript, 2000);
    });
  },
});
