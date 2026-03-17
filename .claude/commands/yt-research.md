# YouTube Research

Use the YouTube research CLI to fetch transcripts, get video metadata, and analyze video content.

When the user is on a YouTube page (check `context/current.json` for the current URL), automatically fetch the transcript if needed before answering questions about the video.

## Commands

### Fetch a video transcript
```bash
npm run --prefix skills/yt-research cli -- transcript "<url-or-video-id>" [--force]
```
Downloads the transcript and caches it to `cache/youtube/{videoId}/`. Uses Supadata with ScrapeCreators fallback.

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

1. Check `context/current.json` for the current page URL — if it's a YouTube video, extract the video ID.
2. Use `transcript` to fetch the video transcript. It's cached automatically.
3. Read the cached `cache/youtube/{videoId}/transcript.md` — it includes metadata headers and the full transcript text.
4. Answer the user's question using the transcript content. Ground your answers in actual quotes and language from the transcript.

## Caching

Transcripts are cached at `cache/youtube/{videoId}/`. Once fetched, a transcript won't be re-fetched unless `--force` is passed. Each cached video has:
- `transcript.md` — formatted with metadata header
- `transcript.txt` — raw text only
- `meta.json` — video metadata (title, channel, duration, etc.)

**Note:** The browser extension automatically extracts transcripts client-side when the user navigates to a YouTube video. These are pre-cached via `/api/transcript`, so in most cases the transcript will already be available when you run the CLI. The CLI only needs to fetch from APIs as a fallback.

## Notes

- Transcript provider chain: browser extension (client-side) → Supadata → ScrapeCreators fallback. The browser extension proactively caches transcripts, so the API fallback is rarely needed.
- Supports all YouTube URL formats: watch, youtu.be, shorts, embed, live, or bare video IDs.
- The `$ARGUMENTS` from the user should guide what videos to fetch and how to analyze them.
