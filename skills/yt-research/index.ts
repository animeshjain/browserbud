import { extractVideoId } from "./url_parser.js";
import { fetchTranscript } from "./transcript.js";
import { fetchVideoMeta } from "./video_meta.js";
import { fetchComments } from "./comments.js";
import { formatTranscriptMarkdown, formatVideoInfo } from "./formatter.js";
import {
  isTranscriptCached,
  isCommentsCached,
  saveTranscript,
  listCachedVideos,
  videoDir,
} from "./cache.js";

function parseDurationToSeconds(duration: string): number | null {
  if (!duration) return null;
  const hMatch = duration.match(/(\d+)h/);
  const mMatch = duration.match(/(\d+)m/);
  const sMatch = duration.match(/(\d+)s/);
  const h = hMatch ? parseInt(hMatch[1]) : 0;
  const m = mMatch ? parseInt(mMatch[1]) : 0;
  const s = sMatch ? parseInt(sMatch[1]) : 0;
  const total = h * 3600 + m * 60 + s;
  return total > 0 ? total : null;
}

// --- Core operations ---

async function transcriptCommand(
  input: string,
  force: boolean,
): Promise<void> {
  const videoId = extractVideoId(input);
  console.log(`Video ID: ${videoId}`);

  if (!force && isTranscriptCached(videoId)) {
    const dir = videoDir(videoId);
    console.log(`Already cached: ${dir}/transcript.md`);
    console.log(`Use --force to re-fetch.`);
    return;
  }

  console.log("Fetching metadata...");
  const meta = await fetchVideoMeta(videoId);
  console.log(`  "${meta.title}" by ${meta.channel}`);

  console.log("Fetching transcript...");
  const durationSeconds = parseDurationToSeconds(meta.duration);
  const result = await fetchTranscript(videoId, durationSeconds);
  console.log(`  Got ${result.text.length} chars via ${result.source}`);

  const md = formatTranscriptMarkdown(meta, result.text, result.source);
  saveTranscript(videoId, md, result.text, meta);

  const dir = videoDir(videoId);
  console.log(`\nSaved to: ${dir}/`);
  console.log(`  transcript.md  — formatted with metadata`);
  console.log(`  transcript.txt — raw text`);
  console.log(`  meta.json      — video metadata`);
}

async function commentsCommand(
  input: string,
  force: boolean,
  maxComments: number,
  includeReplies: boolean,
  minLikesForReplies: number,
  minRepliesForReplies: number,
): Promise<void> {
  const videoId = extractVideoId(input);
  console.log(`Video ID: ${videoId}`);

  if (!force && isCommentsCached(videoId)) {
    const dir = videoDir(videoId);
    console.log(`Already cached: ${dir}/comments.md`);
    console.log(`Use --force to re-fetch.`);
    return;
  }

  console.log(
    `Fetching comments (max ${maxComments}, replies: ${includeReplies})...`,
  );
  const result = await fetchComments(videoId, {
    maxComments,
    includeReplies,
    minLikesForReplies,
    minRepliesForReplies,
  });

  console.log(
    `  Got ${result.comments.length} comments (${result.totalCount} total on video)`,
  );

  const dir = videoDir(videoId);
  console.log(`\nSaved to: ${dir}/`);
  console.log(`  comments.md   — formatted for reading`);
  console.log(`  comments.json — structured data`);
}

async function infoCommand(input: string): Promise<void> {
  const videoId = extractVideoId(input);
  console.log("Fetching metadata...\n");
  const meta = await fetchVideoMeta(videoId);
  console.log(formatVideoInfo(meta));
}

async function batchCommand(
  inputs: string[],
  force: boolean,
): Promise<void> {
  console.log(`Processing ${inputs.length} video(s)...\n`);

  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (const input of inputs) {
    try {
      const videoId = extractVideoId(input);

      if (!force && isTranscriptCached(videoId)) {
        console.log(`[${videoId}] Already cached, skipping.`);
        skipped++;
        continue;
      }

      console.log(`[${videoId}] Fetching...`);
      const meta = await fetchVideoMeta(videoId);
      console.log(`  "${meta.title}"`);

      const result = await fetchTranscript(videoId);
      const md = formatTranscriptMarkdown(meta, result.text, result.source);
      saveTranscript(videoId, md, result.text, meta);
      console.log(`  Saved (${result.text.length} chars via ${result.source})`);
      success++;
    } catch (err) {
      console.error(
        `[${input}] Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      failed++;
    }
  }

  console.log(
    `\nDone: ${success} saved, ${skipped} skipped (cached), ${failed} failed`,
  );
}

function listCommand(): void {
  const videos = listCachedVideos();

  if (videos.length === 0) {
    console.log("No cached videos.");
    return;
  }

  console.log(`Cached videos (${videos.length}):\n`);
  console.log(
    "| # | Video ID    | Channel              | Title                                    | Chars  |",
  );
  console.log(
    "|---|-------------|----------------------|------------------------------------------|--------|",
  );

  for (const [i, v] of videos.entries()) {
    const title =
      v.title.length > 40 ? v.title.slice(0, 37) + "..." : v.title.padEnd(40);
    const channel =
      v.channel.length > 20
        ? v.channel.slice(0, 17) + "..."
        : v.channel.padEnd(20);
    console.log(
      `| ${String(i + 1).padStart(1)} | ${v.videoId} | ${channel} | ${title} | ${String(v.transcriptChars).padStart(6)} |`,
    );
  }
}

// --- CLI argument parser ---

function parseArgs(args: string[]): {
  positional: string[];
  flags: Record<string, string>;
} {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(args[i]);
    }
  }

  return { positional, flags };
}

function printUsage(): void {
  console.log(`Usage: npm run --prefix skills/yt-research cli -- <command> [options]

Commands:
  transcript <url|id>       Fetch and cache a video transcript
  comments <url|id>         Fetch and cache video comments
  info <url|id>             Show video metadata
  batch <url1> <url2> ...   Fetch multiple transcripts
  list                      List cached videos

Transcript options:
  --force                   Re-fetch even if cached

Comments options:
  --force                   Re-fetch even if cached
  --max <n>                 Max comments to fetch (default: 40)
  --replies                 Include replies (default: true)
  --no-replies              Skip reply fetching
  --min-likes <n>           Min likes for reply fetching (default: 100)
  --min-replies <n>         Min reply count for reply fetching (default: 5)

Batch options:
  --force                   Re-fetch all, even if cached

Examples:
  npm run --prefix skills/yt-research cli -- transcript "https://youtube.com/watch?v=abc123"
  npm run --prefix skills/yt-research cli -- comments abc123 --max 60 --min-likes 50
  npm run --prefix skills/yt-research cli -- batch url1 url2 url3
  npm run --prefix skills/yt-research cli -- list
`);
}

// --- Entry point ---

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("yt-research/index.ts");

if (isMain) {
  const [subcommand, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  const force = flags.force === "true";

  (async () => {
    switch (subcommand) {
      case "transcript": {
        const url = positional[0];
        if (!url) {
          console.error("Usage: transcript <url|id>");
          process.exit(1);
        }
        await transcriptCommand(url, force);
        break;
      }

      case "comments": {
        const commentsUrl = positional[0];
        if (!commentsUrl) {
          console.error("Usage: comments <url|id>");
          process.exit(1);
        }
        const maxComments = parseInt(flags.max || "40", 10);
        const includeReplies = flags["no-replies"] !== "true";
        const minLikesForReplies = parseInt(flags["min-likes"] || "100", 10);
        const minRepliesForReplies = parseInt(flags["min-replies"] || "5", 10);
        await commentsCommand(
          commentsUrl,
          force,
          maxComments,
          includeReplies,
          minLikesForReplies,
          minRepliesForReplies,
        );
        break;
      }

      case "info": {
        const url = positional[0];
        if (!url) {
          console.error("Usage: info <url|id>");
          process.exit(1);
        }
        await infoCommand(url);
        break;
      }

      case "batch": {
        if (positional.length === 0) {
          console.error("Usage: batch <url1> <url2> ...");
          process.exit(1);
        }
        await batchCommand(positional, force);
        break;
      }

      case "list": {
        listCommand();
        break;
      }

      default:
        printUsage();
        if (subcommand) {
          console.error(`Unknown command: ${subcommand}`);
          process.exit(1);
        }
    }
  })().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
}
