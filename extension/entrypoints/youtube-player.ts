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

    // ─── Comment Extraction via InnerTube API ────────────────────────────

    interface CommentData {
      id: string;
      author: string;
      channelId: string;
      isVerified: boolean;
      isCreator: boolean;
      text: string;
      publishedTime: string;
      likes: string;
      replyCount: string;
      isHearted: boolean;
      isPinned: boolean;
      replies?: CommentData[];
    }

    async function fetchInnerTube(
      payload: Record<string, any>,
    ): Promise<any> {
      const clientVersion =
        (window as any).ytcfg?.get?.("INNERTUBE_CLIENT_VERSION") ||
        "2.20250101.00.00";
      const apiKey =
        (window as any).ytcfg?.get?.("INNERTUBE_API_KEY") || "";

      const url = `/youtubei/v1/next${apiKey ? "?key=" + apiKey : ""}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: {
            client: { clientName: "WEB", clientVersion },
          },
          ...payload,
        }),
      });
      if (!resp.ok) throw new Error(`InnerTube ${resp.status}`);
      return resp.json();
    }

    function parseCommentsFromMutations(mutations: any[]): CommentData[] {
      const comments: CommentData[] = [];
      // Build a set of pinned comment keys from the rendering tree
      // (we'll enrich this from the thread data later)
      for (const m of mutations) {
        const p = m?.payload?.commentEntityPayload;
        if (!p) continue;
        comments.push({
          id: p.properties?.commentId || "",
          author: p.author?.displayName || "",
          channelId: p.author?.channelId || "",
          isVerified: !!p.author?.isVerified,
          isCreator: !!p.author?.isCreator,
          text: p.properties?.content?.content || "",
          publishedTime: p.properties?.publishedTime || "",
          likes: p.toolbar?.likeCountNotliked || "0",
          replyCount: p.toolbar?.replyCount || "0",
          isHearted: !!p.toolbar?.heartActiveTooltip,
          isPinned: false, // enriched from thread data below
        });
      }
      return comments;
    }

    function extractThreadData(items: any[]): {
      pinnedIds: Set<string>;
      replyTokens: Map<string, string>;
    } {
      const pinnedIds = new Set<string>();
      const replyTokens = new Map<string, string>();

      for (const item of items) {
        const thread = item?.commentThreadRenderer;
        if (!thread) continue;

        const vm = thread.commentViewModel?.commentViewModel;
        const commentId = vm?.commentId || "";

        if (vm?.pinnedText) pinnedIds.add(commentId);

        const replyContents =
          thread.replies?.commentRepliesRenderer?.contents;
        if (replyContents) {
          const contItem = replyContents.find(
            (c: any) => c.continuationItemRenderer,
          );
          const token =
            contItem?.continuationItemRenderer?.continuationEndpoint
              ?.continuationCommand?.token;
          if (token) replyTokens.set(commentId, token);
        }
      }
      return { pinnedIds, replyTokens };
    }

    async function extractComments(opts: {
      videoId: string;
      maxComments: number;
      includeReplies: boolean;
      minLikesForReplies: number;
      minRepliesForReplies: number;
    }): Promise<{
      comments: CommentData[];
      totalCount: string;
    }> {
      // Step 1: Get fresh initial data with comments continuation token
      const initialData = await fetchInnerTube({ videoId: opts.videoId });

      const contents =
        initialData?.contents?.twoColumnWatchNextResults?.results?.results
          ?.contents;
      if (!contents) throw new Error("No contents in /next response");

      let commentsToken: string | null = null;
      for (const item of contents) {
        const section = item?.itemSectionRenderer;
        if (section?.targetId === "comments-section") {
          commentsToken =
            section.contents?.[0]?.continuationItemRenderer
              ?.continuationEndpoint?.continuationCommand?.token || null;
          break;
        }
      }
      if (!commentsToken) throw new Error("No comments section found");

      // Step 2: Fetch comment pages
      const allComments: CommentData[] = [];
      const allReplyTokens = new Map<string, string>();
      const allPinnedIds = new Set<string>();
      let totalCount = "";
      let token: string | null = commentsToken;
      let pageNum = 0;

      while (token && allComments.length < opts.maxComments) {
        const page = await fetchInnerTube({ continuation: token });
        const mutations =
          page?.frameworkUpdates?.entityBatchUpdate?.mutations || [];
        const pageComments = parseCommentsFromMutations(mutations);

        // Get thread rendering data (pinned status, reply tokens)
        const endpoints = page?.onResponseReceivedEndpoints || [];
        let threadItems: any[] = [];
        for (const ep of endpoints) {
          const items =
            ep.reloadContinuationItemsCommand?.continuationItems ||
            ep.appendContinuationItemsAction?.continuationItems ||
            [];
          threadItems = threadItems.concat(items);
        }

        const { pinnedIds, replyTokens } = extractThreadData(threadItems);
        for (const id of pinnedIds) allPinnedIds.add(id);
        for (const [id, t] of replyTokens) allReplyTokens.set(id, t);

        // Extract total count from header (first page only)
        if (pageNum === 0) {
          const header =
            threadItems.find((i: any) => i.commentsHeaderRenderer)
              ?.commentsHeaderRenderer;
          if (header) {
            totalCount =
              header.countText?.runs?.map((r: any) => r.text).join("") || "";
          }
        }

        allComments.push(...pageComments);

        // Find next page token
        const nextContItem = threadItems.find(
          (i: any) => i.continuationItemRenderer,
        );
        token =
          nextContItem?.continuationItemRenderer?.continuationEndpoint
            ?.continuationCommand?.token || null;
        pageNum++;
      }

      // Trim to maxComments
      if (allComments.length > opts.maxComments) {
        allComments.length = opts.maxComments;
      }

      // Enrich pinned status
      for (const c of allComments) {
        if (allPinnedIds.has(c.id)) c.isPinned = true;
      }

      // Step 3: Fetch replies for qualifying comments
      if (opts.includeReplies) {
        for (const comment of allComments) {
          const replyToken = allReplyTokens.get(comment.id);
          if (!replyToken) continue;

          // Check if this comment qualifies for reply fetching
          const likeNum = parseMetricString(comment.likes);
          const replyNum = parseMetricString(comment.replyCount);
          if (
            likeNum < opts.minLikesForReplies &&
            replyNum < opts.minRepliesForReplies
          ) {
            continue;
          }

          try {
            const replyPage = await fetchInnerTube({
              continuation: replyToken,
            });
            const replyMutations =
              replyPage?.frameworkUpdates?.entityBatchUpdate?.mutations ||
              [];
            comment.replies = parseCommentsFromMutations(replyMutations);
          } catch (err) {
            console.warn(
              `[BrowserBud] Failed to fetch replies for ${comment.id}:`,
              err,
            );
          }
        }
      }

      return { comments: allComments, totalCount };
    }

    function parseMetricString(s: string): number {
      if (!s || s === "0") return 0;
      const cleaned = s.replace(/,/g, "").trim();
      const match = cleaned.match(/^([\d.]+)\s*([KMB])?$/i);
      if (!match) return 0;
      const num = parseFloat(match[1]);
      const suffix = (match[2] || "").toUpperCase();
      if (suffix === "K") return num * 1000;
      if (suffix === "M") return num * 1000000;
      if (suffix === "B") return num * 1000000000;
      return num;
    }

    // ─── Player State ─────────────────────────────────────────────────

    function getPlayerState(): Record<string, any> | null {
      const player = getPlayer() as any;
      if (!player || !player.getCurrentTime) return null;

      const currentTime: number = player.getCurrentTime() || 0;
      const duration: number = player.getDuration() || 0;
      const state: number = player.getPlayerState(); // -1=unstarted, 0=ended, 1=playing, 2=paused, 3=buffering, 5=cued
      const playbackRate: number = player.getPlaybackRate() || 1;
      const videoData = player.getVideoData?.() || {};

      const stateNames: Record<number, string> = {
        [-1]: "unstarted",
        0: "ended",
        1: "playing",
        2: "paused",
        3: "buffering",
        5: "cued",
      };

      const totalSec = Math.floor(currentTime);
      const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
      const ss = String(totalSec % 60).padStart(2, "0");

      return {
        videoId: videoData.video_id || getVideoId() || "",
        title: videoData.title || document.title.replace(/ - YouTube$/, "").trim(),
        channel: videoData.author || "",
        currentTime,
        currentTimeFormatted: `${mm}:${ss}`,
        duration,
        state: stateNames[state] || `unknown(${state})`,
        playbackRate,
      };
    }

    // ─── Extraction Trigger ─────────────────────────────────────────────

    window.addEventListener("message", (event) => {
      if (event.source !== window) return;

      // ─── Player State ─────────────────────────────────────────────────
      if (event.data?.type === "BROWSERBUD_GET_PLAYER_STATE") {
        const { requestId } = event.data;
        const state = getPlayerState();
        window.postMessage(
          {
            type: "BROWSERBUD_PLAYER_STATE_RESULT",
            requestId,
            success: !!state,
            ...(state || { error: "Player not found or not ready" }),
          },
          "*",
        );
        return;
      }

      // ─── Comment Extraction ───────────────────────────────────────────
      if (event.data?.type === "BROWSERBUD_EXTRACT_COMMENTS") {
        const {
          videoId,
          requestId,
          maxComments = 40,
          includeReplies = true,
          minLikesForReplies = 100,
          minRepliesForReplies = 5,
        } = event.data;

        const currentVideoId = getVideoId();
        if (currentVideoId !== videoId) {
          window.postMessage(
            {
              type: "BROWSERBUD_EXTRACT_COMMENTS_RESULT",
              requestId,
              success: false,
              error: `Wrong video: on ${currentVideoId}, requested ${videoId}`,
            },
            "*",
          );
          return;
        }

        extractComments({
          videoId,
          maxComments,
          includeReplies,
          minLikesForReplies,
          minRepliesForReplies,
        })
          .then((result) => {
            console.log(
              `[BrowserBud] Extracted ${result.comments.length} comments for ${videoId}`,
            );
            window.postMessage(
              {
                type: "BROWSERBUD_EXTRACT_COMMENTS_RESULT",
                requestId,
                success: true,
                comments: result.comments,
                totalCount: result.totalCount,
                meta: getVideoMeta(),
              },
              "*",
            );
          })
          .catch((err) => {
            console.error("[BrowserBud] Comment extraction failed:", err);
            window.postMessage(
              {
                type: "BROWSERBUD_EXTRACT_COMMENTS_RESULT",
                requestId,
                success: false,
                error: err instanceof Error ? err.message : String(err),
              },
              "*",
            );
          });

        return;
      }

      // ─── Transcript Extraction ────────────────────────────────────────
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
