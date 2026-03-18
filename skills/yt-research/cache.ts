import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { VIDEOS_DIR } from "./config.js";
import type { VideoMeta, CachedVideo, CommentsResult } from "./types.js";

export function videoDir(videoId: string): string {
  return join(VIDEOS_DIR, videoId);
}

export function isTranscriptCached(videoId: string): boolean {
  return existsSync(join(videoDir(videoId), "transcript.md"));
}

export function loadCachedTranscript(videoId: string): string {
  return readFileSync(join(videoDir(videoId), "transcript.txt"), "utf-8");
}

export function loadCachedMeta(videoId: string): VideoMeta | null {
  const metaPath = join(videoDir(videoId), "meta.json");
  if (!existsSync(metaPath)) return null;
  return JSON.parse(readFileSync(metaPath, "utf-8")) as VideoMeta;
}

export function saveTranscript(
  videoId: string,
  transcriptMd: string,
  transcriptTxt: string,
  meta: VideoMeta,
  timedText?: string | null,
): void {
  const dir = videoDir(videoId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "transcript.md"), transcriptMd);
  writeFileSync(join(dir, "transcript.txt"), transcriptTxt);
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  if (timedText) {
    writeFileSync(join(dir, "transcript_timed.txt"), timedText);
  }
}

export function isTimedTranscriptCached(videoId: string): boolean {
  return existsSync(join(videoDir(videoId), "transcript_timed.txt"));
}

export function loadCachedTimedTranscript(videoId: string): string | null {
  const p = join(videoDir(videoId), "transcript_timed.txt");
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf-8");
}

export function isCommentsCached(videoId: string): boolean {
  return existsSync(join(videoDir(videoId), "comments.md"));
}

export function loadCachedComments(videoId: string): CommentsResult | null {
  const commentsPath = join(videoDir(videoId), "comments.json");
  if (!existsSync(commentsPath)) return null;
  return JSON.parse(readFileSync(commentsPath, "utf-8")) as CommentsResult;
}

export function listCachedVideos(): CachedVideo[] {
  if (!existsSync(VIDEOS_DIR)) return [];

  const entries = readdirSync(VIDEOS_DIR, { withFileTypes: true });
  const videos: CachedVideo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = join(VIDEOS_DIR, entry.name, "meta.json");
    const txtPath = join(VIDEOS_DIR, entry.name, "transcript.txt");
    if (!existsSync(metaPath)) continue;

    try {
      const meta = JSON.parse(
        readFileSync(metaPath, "utf-8"),
      ) as VideoMeta;
      const txtSize = existsSync(txtPath)
        ? readFileSync(txtPath, "utf-8").length
        : 0;

      videos.push({
        videoId: entry.name,
        title: meta.title,
        channel: meta.channel,
        cachedAt: meta.publishedAt || "",
        transcriptChars: txtSize,
      });
    } catch {
      // Skip corrupted entries
    }
  }

  return videos;
}
