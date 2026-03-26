import TurndownService from "turndown";

/**
 * Shared page content extraction using Turndown (HTML → Markdown).
 * Used by both the YouTube and generic content scripts.
 */

const STRIP_TAGS: TurndownService.TagName[] = [
  "script", "style", "nav", "header", "footer", "aside", "noscript", "iframe",
];

function makeTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  td.remove(STRIP_TAGS);

  return td;
}

export function extractPageContent(): { content: string; title: string; url: string } {
  const td = makeTurndown();

  // Pick the best root element
  const root =
    document.querySelector("article") ||
    document.querySelector("main") ||
    document.querySelector("[role='main']") ||
    document.body;

  const markdown = td.turndown(root);

  return {
    content: markdown,
    title: document.title.trim(),
    url: window.location.href,
  };
}
