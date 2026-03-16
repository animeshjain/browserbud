import type { VideoMeta } from "./types.js";

export function formatTranscriptMarkdown(
  meta: VideoMeta,
  transcriptText: string,
  source: string,
): string {
  const lines: string[] = [];

  lines.push(`# ${meta.title}`);
  lines.push("");
  lines.push(`- **Channel:** ${meta.channel}`);
  if (meta.publishedAt) lines.push(`- **Published:** ${meta.publishedAt}`);
  if (meta.duration) lines.push(`- **Duration:** ${meta.duration}`);
  lines.push(`- **URL:** ${meta.url}`);
  lines.push(`- **Transcript source:** ${source}`);
  lines.push(`- **Cached:** ${new Date().toISOString()}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Transcript");
  lines.push("");
  lines.push(transcriptText);
  lines.push("");

  return lines.join("\n");
}

export function formatVideoInfo(meta: VideoMeta): string {
  const lines: string[] = [];

  lines.push(`Title:     ${meta.title}`);
  lines.push(`Channel:   ${meta.channel}`);
  if (meta.publishedAt) lines.push(`Published: ${meta.publishedAt}`);
  if (meta.duration) lines.push(`Duration:  ${meta.duration}`);
  lines.push(`URL:       ${meta.url}`);
  if (meta.description) {
    lines.push("");
    lines.push("Description:");
    lines.push(
      meta.description.length > 500
        ? meta.description.slice(0, 500) + "..."
        : meta.description,
    );
  }

  return lines.join("\n");
}
