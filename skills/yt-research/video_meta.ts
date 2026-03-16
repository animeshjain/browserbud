/**
 * Video metadata fetching via Supadata.
 *
 * Falls back to noembed.com (free, no API key) if Supadata metadata fails.
 */

import { Supadata } from "@supadata/js";
import { SUPADATA_API_KEY, REQUEST_TIMEOUT_MS } from "./config.js";
import type { VideoMeta } from "./types.js";

interface NoembedResponse {
  title?: string;
  author_name?: string;
  author_url?: string;
  thumbnail_url?: string;
  provider_name?: string;
  error?: string;
}

export async function fetchVideoMeta(videoId: string): Promise<VideoMeta> {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Try Supadata first for richer metadata
  if (SUPADATA_API_KEY) {
    try {
      const client = new Supadata({ apiKey: SUPADATA_API_KEY });
      const video = await (client.youtube as any).video({ id: videoId });

      if (video) {
        // Channel can be a string or { id, name } object
        const channel =
          typeof video.channel === "object" && video.channel?.name
            ? video.channel.name
            : video.channelTitle || video.channel || "";

        return {
          videoId,
          title: video.title || "",
          channel: String(channel),
          description: video.description || "",
          duration: formatDuration(video.duration || video.lengthSeconds || 0),
          publishedAt: video.publishedAt || "",
          url: videoUrl,
          thumbnailUrl: video.thumbnail || video.thumbnailUrl || "",
        };
      }
    } catch (err) {
      console.log(
        `  Supadata metadata failed, falling back to noembed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Fallback: noembed.com (free, no key needed)
  const noembedUrl = `https://noembed.com/embed?url=${encodeURIComponent(videoUrl)}`;
  const response = await fetch(noembedUrl, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`noembed API error: ${response.status}`);
  }

  const data = (await response.json()) as NoembedResponse;

  if (data.error) {
    throw new Error(`noembed error: ${data.error}`);
  }

  return {
    videoId,
    title: data.title || "",
    channel: data.author_name || "",
    description: "",
    duration: "",
    publishedAt: "",
    url: videoUrl,
    thumbnailUrl: data.thumbnail_url || "",
  };
}

function formatDuration(input: number | string): string {
  if (typeof input === "string") {
    // ISO 8601 duration like PT12M34S
    const match = input.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (match) {
      const h = parseInt(match[1] || "0");
      const m = parseInt(match[2] || "0");
      const s = parseInt(match[3] || "0");
      if (h > 0) return `${h}h ${m}m`;
      return `${m}m ${s}s`;
    }
    return input;
  }

  // Seconds
  if (input <= 0) return "";
  const h = Math.floor(input / 3600);
  const m = Math.floor((input % 3600) / 60);
  const s = input % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}
