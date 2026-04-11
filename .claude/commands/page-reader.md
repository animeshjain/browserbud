# Page Reader

Use the page reader CLI to extract and read the text content of the active browser tab. This works on any webpage (except YouTube, which has its own `/yt-research` skill).

When the user is on a non-YouTube page and asks about the page content, use this skill to fetch the text.

## Commands

### Extract page content
```bash
npm run --prefix skills/page-reader cli -- read [--max-chars 50000] [--force] [--url "<url>"]
```
Requests the page content from the browser extension, converts it to Markdown, and caches it to `cache/web/{domain}/{slug}/content.md`. If the page is already cached, prints the cache path and skips extraction (use `--force` to re-fetch).

Options:
- `--max-chars <n>` — Maximum characters to extract (default: 50000)
- `--force` — Re-fetch even if cached
- `--url <url>` — Extract a specific URL (default: current tab from `context/current.json`)

### Show cached page content
```bash
npm run --prefix skills/page-reader cli -- show [--url "<url>"]
```
Prints the cached content for a URL. If `--url` is omitted, uses the current tab URL from `context/current.json`.

### List cached pages
```bash
npm run --prefix skills/page-reader cli -- list
```
Lists all cached web pages with their domains, titles, URLs, and sizes.

## Caching

Page content is cached at `cache/web/{domain}/{slug}/`. Each cached page has:
- `content.md` — page content with metadata header (title, URL, cache timestamp)
- `meta.json` — structured metadata (url, title, domain, cachedAt, contentChars)

Cache is permanent — pages are not re-fetched unless `--force` is passed. The cache key is derived from the canonicalized URL (stripped of tracking params, www prefix, fragments, and trailing slashes), so the same page always maps to the same cache directory regardless of how the URL was formatted.

## Workflow

1. Check `context/current.json` to see what page the user is on
2. Run `read` to extract the page content from the browser
3. Read the cache path printed by the CLI (e.g., `cache/web/example.com/some-page_a1b2c3d4/content.md`)
4. Answer the user's question grounded in the actual page content

## Summarize Workflow

When invoked with "Summarize this page: <url>" (typically from the Summarize button), the page content has already been cached by the server. Follow this flow:

1. Run `read --url "<url>"` — this confirms the cache exists and promotes the page to `notes/web/` for persistent storage
2. Read the `content.md` file from the cache path printed by the CLI
3. Produce a concise, well-structured summary of the page content

The `read` command automatically promotes cached pages to `notes/web/{domain}/{slug}/` (copies `content.md` and `meta.json`), similar to how yt-research promotes transcripts to `notes/youtube/`.

## When to use

- User asks "what does this page say", "summarize this page", "what is this about"
- User asks a question that requires reading the page content
- User is on a non-YouTube webpage and asks about something on the page
- User says "read this", "look at this page", "what am I looking at"
- User clicked the Summarize button (invoked with "Summarize this page: <url>")

If the user has text selected (check `context/current.json` for a `selection` field), prefer using the selection text directly — you don't need to fetch the full page.

The `$ARGUMENTS` from the user should guide how to analyze the extracted content.
