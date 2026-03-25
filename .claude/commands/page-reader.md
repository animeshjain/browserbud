# Page Reader

Use the page reader CLI to extract and read the text content of the active browser tab. This works on any webpage (except YouTube, which has its own `/yt-research` skill).

When the user is on a non-YouTube page and asks about the page content, use this skill to fetch the text.

## Commands

### Extract page content
```bash
npm run --prefix skills/page-reader cli -- read [--max-chars 50000]
```
Requests the page content from the browser extension, saves it to `context/page-content.txt`, and reports the size. The extension extracts text from `<article>`, `<main>`, or the body (stripping nav, header, footer, scripts, etc.).

### Show cached page content
```bash
npm run --prefix skills/page-reader cli -- show
```
Prints the last extracted page content from `context/page-content.txt`.

## Workflow

1. Check `context/current.json` to see what page the user is on
2. Run `read` to extract the page content from the browser
3. Read the output or run `show` to see the full text
4. Answer the user's question grounded in the actual page content

## When to use

- User asks "what does this page say", "summarize this page", "what is this about"
- User asks a question that requires reading the page content
- User is on a non-YouTube webpage and asks about something on the page
- User says "read this", "look at this page", "what am I looking at"

If the user has text selected (check `context/current.json` for a `selection` field), prefer using the selection text directly — you don't need to fetch the full page.

The `$ARGUMENTS` from the user should guide how to analyze the extracted content.
