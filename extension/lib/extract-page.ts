/**
 * Shared page content extraction via DOM pruning.
 *
 * Clones the best root element, strips non-content noise (scripts, styles,
 * classes, hidden elements, empty wrappers), flattens link internals, and
 * returns a lightweight HTML string suitable for server-side Markdown
 * conversion.
 */

const REMOVE_TAGS = [
  "script", "style", "noscript", "svg", "link", "meta", "iframe",
];

/** Attributes worth keeping — everything else is stripped. */
const KEEP_ATTRS = new Set([
  "href", "src", "alt", "role", "data-testid", "aria-label", "dir", "lang",
]);

/**
 * Prune a cloned DOM subtree for clean HTML serialization.
 * Mutates the element in place.
 */
function pruneDOM(root: Element): void {
  // 1. Remove non-content tags
  for (const tag of REMOVE_TAGS) {
    root.querySelectorAll(tag).forEach((el) => el.remove());
  }

  // 2. Remove hidden elements
  root.querySelectorAll('[aria-hidden="true"], [hidden]').forEach((el) => el.remove());

  // 3. Strip attributes that are meaningless without CSS
  for (const el of root.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      if (!KEEP_ATTRS.has(attr.name)) {
        el.removeAttribute(attr.name);
      }
    }
  }

  // 4. Flatten <a> tags: replace nested div/span wrappers with plain text
  for (const a of root.querySelectorAll("a")) {
    const text = a.textContent?.trim();
    if (text) {
      while (a.firstChild) a.removeChild(a.firstChild);
      a.appendChild(document.createTextNode(text));
    }
  }

  // 5. Remove empty elements (no text, no media children)
  (function removeEmpties(el: Element) {
    for (const child of [...el.children]) {
      removeEmpties(child);
    }
    if (
      !el.textContent?.trim() &&
      !el.querySelector("img, video, audio") &&
      el !== root
    ) {
      el.remove();
    }
  })(root);
}

export function extractPageContent(): {
  html: string;
  title: string;
  url: string;
} {
  // Start from the main content area — pruning handles the noise
  const root =
    document.querySelector("main") ||
    document.querySelector("[role='main']") ||
    document.body;

  const clone = root.cloneNode(true) as Element;
  pruneDOM(clone);

  return {
    html: clone.innerHTML,
    title: document.title.trim(),
    url: window.location.href,
  };
}
