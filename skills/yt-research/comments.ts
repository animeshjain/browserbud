/**
 * Comment fetching via client-side extraction from browser extension.
 *
 * Uses the InnerTube API (youtubei/v1/next) from the MAIN world content
 * script running on the YouTube page. No auth or API keys needed — the
 * extension makes same-origin fetch calls to YouTube's internal API.
 *
 * The flow:
 *   skill CLI → POST /api/extract-comments → server.js
 *   → WebSocket → background.ts → content.ts → youtube-player.ts
 *   → InnerTube API fetch → parse mutations → return comments
 */

import { BROWSERBUD_SERVER_URL } from "./config.js";
import type { CommentsResult } from "./types.js";

export interface FetchCommentsOptions {
  maxComments?: number;
  includeReplies?: boolean;
  minLikesForReplies?: number;
  minRepliesForReplies?: number;
}

export async function fetchComments(
  videoId: string,
  opts: FetchCommentsOptions = {},
): Promise<CommentsResult> {
  const response = await fetch(`${BROWSERBUD_SERVER_URL}/api/extract-comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      videoId,
      maxComments: opts.maxComments ?? 40,
      includeReplies: opts.includeReplies ?? true,
      minLikesForReplies: opts.minLikesForReplies ?? 100,
      minRepliesForReplies: opts.minRepliesForReplies ?? 5,
    }),
    signal: AbortSignal.timeout(65000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Comment extraction failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const data = await response.json() as {
    ok: boolean;
    comments?: any[];
    totalCount?: string;
    error?: string;
  };

  if (!data.ok) {
    throw new Error(data.error || "Comment extraction returned not-ok");
  }

  return {
    comments: data.comments || [],
    totalCount: data.totalCount || "",
    videoId,
    fetchedAt: new Date().toISOString(),
  };
}
