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
  timedText: string | null; // "[MM:SS] line" format, null if timestamps unavailable
  lang: string | null;
  source: "client" | "supadata" | "scrapecreators";
}

export interface CachedVideo {
  videoId: string;
  title: string;
  channel: string;
  cachedAt: string;
  transcriptChars: number;
}

export interface Comment {
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
  replies?: Comment[];
}

export interface CommentsResult {
  comments: Comment[];
  totalCount: string;
  videoId: string;
  fetchedAt: string;
}
