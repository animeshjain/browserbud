export interface VideoMeta {
  videoId: string;
  title: string;
  channel: string;
  description: string;
  duration: string;
  publishedAt: string;
  url: string;
  thumbnailUrl: string;
}

export interface TranscriptResult {
  text: string;
  lang: string | null;
  source: "supadata" | "scrapecreators";
}

export interface CachedVideo {
  videoId: string;
  title: string;
  channel: string;
  cachedAt: string;
  transcriptChars: number;
}
