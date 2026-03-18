# Client-Side Comment Extraction

How the `yt-research` skill extracts YouTube comments directly from the browser extension using YouTube's InnerTube API.

## Why client-side?

YouTube has no free public API for comments (the official Data API v3 requires an API key and has a 10,000 unit/day quota). Since our extension runs on youtube.com, we can make same-origin `fetch()` calls to YouTube's internal InnerTube API (`/youtubei/v1/next`) — no auth, no API key, no Proof of Origin Token needed.

Unlike transcripts (which require XHR interception to capture the POT token), comments are freely available via the InnerTube API from any same-origin context. This makes the implementation simpler — direct `fetch()` calls rather than monkey-patching XHR.

## How it works

The MAIN world script (`youtube-player.ts`) makes direct `fetch()` calls to `/youtubei/v1/next` when triggered. The process has two phases:

1. **Get continuation token** — POST to `/next` with the `videoId` to get fresh page data (avoids stale `ytInitialData` from SPA navigation). The comments section continuation token is in `contents.twoColumnWatchNextResults.results.results.contents[N].itemSectionRenderer` where `targetId === "comments-section"`.

2. **Fetch comment pages** — POST to `/next` with the continuation token to get batches of ~20 comments each. Each response contains comment data in `frameworkUpdates.entityBatchUpdate.mutations` and a next-page continuation token for pagination.

## Request flow

```
yt-research CLI
  |  fetchComments(videoId, opts)
  |  POST /api/extract-comments { videoId, maxComments, includeReplies, ... }
  v
server.js
  |  Holds HTTP response open (60s timeout)
  |  Sends { type: "extract-comments", videoId, requestId, ... } via /ws/extension
  v
background.ts
  |  Finds YouTube tab where URL contains v={videoId}
  |  browser.tabs.sendMessage(tabId, { type: "extractComments", ... })
  v
content.ts (ISOLATED world)
  |  window.postMessage({ type: "BROWSERBUD_EXTRACT_COMMENTS", ... })
  v
youtube-player.ts (MAIN world)
  |  Phase 1: fetch(/youtubei/v1/next, { videoId }) -> get comments continuation token
  |  Phase 2: fetch(/youtubei/v1/next, { continuation }) -> get comments (loop for pages)
  |  Phase 3: fetch(/youtubei/v1/next, { continuation }) -> get replies (per qualifying comment)
  |  window.postMessage({ type: "BROWSERBUD_EXTRACT_COMMENTS_RESULT", ... })
  v
content.ts -> browser.runtime.sendMessage({ type: "commentsResult", ... })
  v
background.ts -> extensionSocket.send({ type: "extract-comments-result", ... })
  v
server.js -> resolves pending request -> caches comments.json + comments.md -> HTTP 200 to CLI
  v
yt-research CLI receives { ok: true, comments: [...], totalCount, meta }
```

## InnerTube API details

### Endpoint

```
POST https://www.youtube.com/youtubei/v1/next?key={INNERTUBE_API_KEY}
```

The API key is read from `ytcfg.get("INNERTUBE_API_KEY")` on the page. It's a public key, not user-specific: `AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8`.

### Request body

**Step 1 — Get initial data (with videoId):**

```json
{
  "context": {
    "client": {
      "clientName": "WEB",
      "clientVersion": "2.20250317.01.00"
    }
  },
  "videoId": "GCebP1KcWMU"
}
```

**Step 2+ — Fetch comments (with continuation token):**

```json
{
  "context": {
    "client": {
      "clientName": "WEB",
      "clientVersion": "2.20250317.01.00"
    }
  },
  "continuation": "<base64_continuation_token>"
}
```

`videoId` and `continuation` are mutually exclusive — never send both.

### Authentication

None required for public videos. No cookies, no SAPISIDHASH, no POT token. Just a same-origin `fetch()` with `Content-Type: application/json`.

For member-only or age-restricted content, SAPISIDHASH authorization would be needed (see YCS-cont's implementation). Not currently implemented.

### Why `ytInitialData` can't be used

YouTube is an SPA. When the user navigates between videos, `window.ytInitialData` is only set on full page loads. SPA navigation (which fires `yt-navigate-finish`) updates the page but leaves `ytInitialData` stale — often pointing to the homepage or a previous video.

Solution: always make a fresh `/next` call with the `videoId` to get current data. This adds one extra API call but is 100% reliable.

## Response structure

The `/next` response has 4 top-level keys:

```json
{
  "responseContext": { ... },
  "trackingParams": "...",
  "onResponseReceivedEndpoints": [ ... ],
  "frameworkUpdates": { ... }
}
```

### `onResponseReceivedEndpoints` — rendering metadata

An array of 2 items on the first page:

**[0]** — Header with comment count and sort options:

```
.reloadContinuationItemsCommand.continuationItems[0].commentsHeaderRenderer
  .countText.runs  ->  [{"text": "1,572"}, {"text": " Comments"}]
  .sortMenu.sortFilterSubMenuRenderer.subMenuItems  ->  [
    { "title": "Top", "continuation": { "token": "..." } },
    { "title": "Newest", "continuation": { "token": "..." } }
  ]
```

**[1]** — Comment threads (~20 per page):

```
.reloadContinuationItemsCommand.continuationItems[]
  .commentThreadRenderer
    .commentViewModel.commentViewModel
      .commentId       -> "Ugzge340dBgB75hWBm54AaABAg"
      .commentKey       -> entity key linking to frameworkUpdates
      .pinnedText       -> "Pinned by @CreatorName" (or absent)
    .replies.commentRepliesRenderer
      .contents[0].continuationItemRenderer  -> reply continuation token
```

For page 2+, the action changes to `appendContinuationItemsAction` instead of `reloadContinuationItemsCommand`.

### `frameworkUpdates.entityBatchUpdate.mutations` — actual comment data

This is where comment text, author info, and engagement metrics live. YouTube moved to this split format in ~2024, replacing the older inline `commentRenderer` approach.

Each page returns ~101 mutations of various types:

| Payload Type | Per Page | Contains |
|---|---|---|
| `commentEntityPayload` | ~20 | Comment text, author, likes, reply count |
| `commentSurfaceEntityPayload` | ~20 | UI state (read more, tooltips) |
| `commentSharedEntityPayload` | 1 | Shared strings (button labels) |
| `engagementToolbarStateEntityPayload` | ~20 | Heart state |
| `engagementToolbarSurfaceEntityPayload` | ~20 | Toolbar rendering |
| `triStateButtonStateEntityPayload` | ~20 | Like/dislike button states |

### `commentEntityPayload` structure

```json
{
  "key": "<entity_key>",
  "properties": {
    "commentId": "Ugzge340dBgB75hWBm54AaABAg",
    "content": {
      "content": "The actual comment text here"
    },
    "publishedTime": "10 months ago",
    "replyLevel": 0
  },
  "author": {
    "channelId": "UCBR8-60-B28hp2BmDPdntcQ",
    "displayName": "@YouTube",
    "avatarThumbnailUrl": "https://yt3.ggpht.com/...",
    "isVerified": true,
    "isCurrentUser": false,
    "isCreator": false,
    "isArtist": false
  },
  "toolbar": {
    "likeCountLiked": "200K",
    "likeCountNotliked": "200K",
    "replyCount": "961",
    "likeCountA11y": "200K likes",
    "replyCountA11y": "961 replies",
    "heartActiveTooltip": "\u2764 by @CreatorName"
  }
}
```

Key fields extracted by BrowserBud:

| Field | Path | Notes |
|---|---|---|
| Comment text | `properties.content.content` | Raw text, may contain newlines |
| Author | `author.displayName` | Includes @ prefix |
| Channel ID | `author.channelId` | |
| Verified | `author.isVerified` | Blue checkmark |
| Creator | `author.isCreator` | Video uploader |
| Published time | `properties.publishedTime` | Relative string, e.g. "3 months ago" |
| Likes | `toolbar.likeCountNotliked` | Pre-formatted: "200K", "1.2K", "42" |
| Reply count | `toolbar.replyCount` | Pre-formatted string |
| Hearted | `toolbar.heartActiveTooltip` | Non-empty = creator hearted the comment |

### Linking rendering data to comment data

The `commentViewModel.commentKey` in `onResponseReceivedEndpoints` matches the `key` field in `commentEntityPayload` within `frameworkUpdates`. This link is used to correlate pinned status (from the rendering tree) with comment content (from mutations).

## Pagination

Each page of ~20 comments includes a `continuationItemRenderer` at the end of the thread items array:

```
continuationItemRenderer
  .continuationEndpoint
    .continuationCommand
      .token  ->  next page token
      .request  ->  "CONTINUATION_REQUEST_TYPE_WATCH_NEXT"
```

BrowserBud loops until either:
- `maxComments` is reached
- No `continuationItemRenderer` appears in the response (no more pages)

## Reply fetching

Each `commentThreadRenderer` with replies contains a reply continuation token at:

```
.replies.commentRepliesRenderer.contents[0]
  .continuationItemRenderer
    .continuationEndpoint
      .continuationCommand.token
```

Use the same `/next` endpoint with this token to fetch replies. Reply comments have `replyLevel: 1` in their `commentEntityPayload`.

BrowserBud fetches replies selectively based on thresholds:
- `minLikesForReplies` (default: 100) — only fetch replies for comments with this many likes
- `minRepliesForReplies` (default: 5) — only fetch replies for comments with this many replies

This avoids making dozens of extra API calls for low-engagement comments.

### Metric string parsing

Like counts and reply counts are pre-formatted display strings ("200K", "1.2K", "42"), not raw numbers. BrowserBud parses these for threshold comparison:

```
"200K" -> 200000
"1.2K" -> 1200
"42"   -> 42
"0"    -> 0
```

## Sort options

YouTube offers two sort modes, each with its own continuation token:
- **Top comments** (default) — most engagement first
- **Newest first** — chronological

Currently BrowserBud always uses the default (top comments) token from the initial response. The sort tokens differ by a single byte in the protobuf-encoded base64 string (sort field 0 vs 1).

## Components involved

| File | Role |
|------|------|
| `skills/yt-research/comments.ts` | `fetchComments()` — POSTs to server's extract endpoint |
| `sprite/server.js` | `POST /api/extract-comments` endpoint, caches `comments.json` + `comments.md` |
| `extension/entrypoints/background.ts` | WebSocket client, dispatches `extract-comments` commands to content scripts |
| `extension/entrypoints/content.ts` | Bridges messages between background and MAIN world |
| `extension/entrypoints/youtube-player.ts` | InnerTube API fetch, mutation parsing, reply fetching |

## Timeouts

| Layer | Timeout | On timeout |
|-------|---------|------------|
| youtube-player.ts (InnerTube fetches) | None (native fetch) | Promise rejection propagates |
| server.js (pending request) | 60s | Rejects with 502, cleans up pendingRequests map |
| comments.ts (HTTP fetch) | 65s | AbortSignal.timeout, throws error |

The 60s server timeout is higher than the 15s transcript timeout because comment extraction involves multiple sequential API calls (initial data + N pages + optional replies).

## Caching

Comments are cached to `cache/youtube/{videoId}/`:
- `comments.json` — structured data: `{ comments: [...], totalCount, videoId, fetchedAt }`
- `comments.md` — formatted markdown with badges (pinned, hearted, creator, verified)

The server writes both files. The skill CLI checks for `comments.md` to determine if cached.

## Comparison with transcript extraction

| Aspect | Transcripts | Comments |
|--------|------------|----------|
| Auth needed | POT token (via XHR interception) | None |
| Technique | Monkey-patch XHR, toggle CC button | Direct `fetch()` to InnerTube API |
| Side effects | Toggles captions on/off (visible to user) | None (invisible) |
| API calls | 1 (YouTube's own timedtext XHR) | 2 + N pages + M reply fetches |
| Pagination | N/A (single response) | Continuation tokens |
| Fallback providers | client -> Supadata -> ScrapeCreators | Client only (no server-side fallback) |

## Reference implementations

These open-source projects were studied during development:

| Project | Approach | Notes |
|---------|----------|-------|
| [YCS-cont](https://github.com/pc035860/YCS-cont) | InnerTube API (browser extension) | Best reference — 3-layer architecture, SAPISIDHASH auth, nested replies |
| [YouTube.js](https://github.com/LuanRT/YouTube.js) | InnerTube API (JS library) | Most popular innertube client, handles continuation token construction |
| [youtube-comment-downloader](https://github.com/egbertbouman/youtube-comment-downloader) | InnerTube API (Python) | Queue-based continuation, recursive `commentEntityPayload` search |
| [yt-comments-crawler](https://github.com/rdavydov/yt-comments-crawler) | DOM scraping | Simpler but fragile, requires scrolling, much slower |

## Testing

```bash
# Test extraction directly (user must be on a YouTube video page)
curl -X POST http://localhost:8989/api/extract-comments \
  -H "Content-Type: application/json" \
  -d '{"videoId":"GCebP1KcWMU","maxComments":20}'

# Test via the skill CLI
npm run --prefix skills/yt-research cli -- comments GCebP1KcWMU --max 20

# Test with replies for high-engagement comments
npm run --prefix skills/yt-research cli -- comments GCebP1KcWMU --max 40 --min-likes 50
```

### Dev console snippets

These can be run in the browser console on a YouTube video page to test the InnerTube API directly:

**Get comments continuation token:**

```js
(async () => {
  const videoId = new URLSearchParams(location.search).get('v');
  const clientVersion = ytcfg.get('INNERTUBE_CLIENT_VERSION');
  const apiKey = ytcfg.get('INNERTUBE_API_KEY');

  const resp = await fetch(`/youtubei/v1/next?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion } },
      videoId
    })
  });
  const data = await resp.json();
  const contents = data.contents.twoColumnWatchNextResults.results.results.contents;
  const section = contents.find(c => c.itemSectionRenderer?.targetId === 'comments-section');
  const token = section.itemSectionRenderer.contents[0]
    .continuationItemRenderer.continuationEndpoint.continuationCommand.token;
  console.log('Token:', token.substring(0, 80) + '...');
  window._commentToken = token;
})();
```

**Fetch and parse comments:**

```js
(async () => {
  const clientVersion = ytcfg.get('INNERTUBE_CLIENT_VERSION');
  const apiKey = ytcfg.get('INNERTUBE_API_KEY');
  const resp = await fetch(`/youtubei/v1/next?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion } },
      continuation: window._commentToken
    })
  });
  const json = await resp.json();
  const mutations = json.frameworkUpdates.entityBatchUpdate.mutations;
  const comments = mutations
    .filter(m => m.payload?.commentEntityPayload)
    .map(m => {
      const p = m.payload.commentEntityPayload;
      return {
        author: p.author?.displayName,
        text: p.properties?.content?.content?.substring(0, 80),
        likes: p.toolbar?.likeCountNotliked,
        replies: p.toolbar?.replyCount,
        time: p.properties?.publishedTime,
      };
    });
  console.table(comments);
})();
```

## Known limitations

- **No server-side fallback** — unlike transcripts, there's no paid API provider for comments. If the extension is not connected or the video isn't open, extraction fails.
- **Like counts are strings** — "200K", "1.2K" are display-formatted, not exact numbers. Threshold comparisons parse these approximately.
- **Sort is fixed to "top"** — newest-first sorting is possible (different continuation token) but not yet exposed.
- **No reply pagination** — only the first page of replies per comment is fetched (~20 replies). Deeply threaded discussions may be truncated.
- **Undocumented API** — YouTube can change the response structure at any time. The `frameworkUpdates.entityBatchUpdate.mutations` format replaced the older inline `commentRenderer` approach in ~2024.
