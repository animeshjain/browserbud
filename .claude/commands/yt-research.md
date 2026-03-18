# YouTube Research

Use the YouTube research CLI to fetch transcripts, get video metadata, check the current playback position, and analyze video content.

When the user is on a YouTube page (check `context/current.json` for the current URL), automatically fetch the transcript if needed before answering questions about the video.

**IMPORTANT: You can see where the user is in the video.** The `context` command queries the browser for the exact current playback time and returns the transcript around that position. Use it whenever the user refers to a specific moment rather than the whole video.

## Commands

### Get transcript around current playback position
```bash
npm run --prefix skills/yt-research cli -- context "<url-or-video-id>" [--window 90]
```
Queries the browser extension for the video's **current playback time** (works whether paused or playing), then returns the transcript lines centered on that position. The `>>>` marker shows the current position. Fetches the transcript automatically if not cached.

**Use this when the user says:**
- "what are they talking about" / "what's being discussed"
- "explain this" / "explain this part" / "break this down"
- "what did they just say" / "I missed that"
- "at this point" / "right now" / "where I am" / "where I paused"
- "I don't understand this" / "can you clarify"
- Any reference to "this", "here", "now" in the context of video content

**Do NOT** read the full transcript and guess the position — always use `context` first to get the exact timestamp.

Options:
- `--window <seconds>` — time window around current position (default: 90). Use 60 for focused, 120-180 for broader context.

### Fetch a video transcript
```bash
npm run --prefix skills/yt-research cli -- transcript "<url-or-video-id>" [--force]
```
Downloads the full transcript and caches it to `cache/youtube/{videoId}/`. Uses client-side extraction with Supadata/ScrapeCreators fallback. Use this for whole-video questions (summarize, analyze, etc.).

### Fetch video comments
```bash
npm run --prefix skills/yt-research cli -- comments "<url-or-video-id>" [--max 40] [--min-likes 100] [--min-replies 5] [--no-replies] [--force]
```
Fetches comments via the browser extension using YouTube's InnerTube API. Caches to `cache/youtube/{videoId}/comments.md` and `comments.json`. Options:
- `--max <n>` — max comments to fetch (default: 40, fetches ~20 per page)
- `--min-likes <n>` — only fetch replies for comments with at least this many likes (default: 100)
- `--min-replies <n>` — only fetch replies for comments with at least this many replies (default: 5)
- `--no-replies` — skip fetching replies entirely
- `--force` — re-fetch even if cached

### Get video metadata
```bash
npm run --prefix skills/yt-research cli -- info "<url-or-video-id>"
```

### Fetch multiple transcripts
```bash
npm run --prefix skills/yt-research cli -- batch "<url1>" "<url2>" "<url3>" [--force]
```

### List cached videos
```bash
npm run --prefix skills/yt-research cli -- list
```

## Workflow

### Deciding which command to use

| User intent | Command |
|---|---|
| Refers to "this part", "right now", "where I am", current moment | `context` |
| Asks to summarize, analyze, or question the whole video | `transcript` (then read cached file) |
| Asks about audience reaction, opinions, discussion | `comments` |
| Asks for video details (title, channel, duration) | `info` |

### Answering questions about the whole video

1. Check `context/current.json` for the current page URL — extract the video ID.
2. Use `transcript` to fetch the video transcript. It's cached automatically.
3. Read the cached `cache/youtube/{videoId}/transcript.md` — it includes metadata headers and the full transcript text.
4. Answer the user's question using the transcript content. Ground your answers in actual quotes and language from the transcript.

### Answering questions about the current position ("explain this")

1. Get the video ID from `context/current.json`
2. Run `context <video-id>` to get the transcript around the current playback position
3. Read the output — the `>>>` marker shows exactly where the user is in the video
4. If there are multiple topics in the window, ask the user to confirm which concept or part they want explained
5. Explain using the actual transcript text, grounding your explanation in what was said

### When to fetch comments

Use `comments` when the user asks about:
- What people think, audience reaction, sentiment, reception
- Popular opinions, controversial takes, discussion
- Community response, viewer feedback
- Specific questions about what commenters said

Default behavior: fetch 2 pages (~40 comments), include replies for comments with 100+ likes or 5+ replies. Adjust `--max`, `--min-likes`, `--min-replies` based on the question — e.g., increase `--max` for sentiment analysis, lower `--min-likes` for niche discussions.

## Caching

Transcripts and comments are cached at `cache/youtube/{videoId}/`. Once fetched, they won't be re-fetched unless `--force` is passed. Each cached video may have:
- `transcript.md` — formatted with metadata header
- `transcript.txt` — raw text only
- `meta.json` — video metadata (title, channel, duration, etc.)
- `comments.md` — formatted comments with metadata
- `comments.json` — structured comment data (author, text, likes, replies, etc.)

**Note:** The browser extension automatically extracts transcripts client-side when the user navigates to a YouTube video. These are pre-cached via `/api/transcript`, so in most cases the transcript will already be available when you run the CLI. The CLI only needs to fetch from APIs as a fallback.

## Notes

- Transcript provider chain: browser extension (client-side) → Supadata → ScrapeCreators fallback. The browser extension proactively caches transcripts, so the API fallback is rarely needed.
- Supports all YouTube URL formats: watch, youtu.be, shorts, embed, live, or bare video IDs.
- The `$ARGUMENTS` from the user should guide what videos to fetch and how to analyze them.
