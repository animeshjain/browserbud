import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const DATA_DIR =
  process.env.BROWSERBUD_DATA_DIR ||
  join(process.env.HOME || "~", "browse");
export const WEB_CACHE_DIR = join(DATA_DIR, "cache", "web");

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PageMeta {
  url: string;
  canonicalUrl: string;
  title: string;
  domain: string;
  cachedAt: string;
  contentChars: number;
}

export interface CachedPage {
  domain: string;
  slug: string;
  title: string;
  url: string;
  cachedAt: string;
  contentChars: number;
}

// ─── URL Canonicalization ───────────────────────────────────────────────────

const TRACKING_PARAMS =
  /^(utm_\w+|fbclid|gclid|ref|mc_cid|mc_eid|_ga|_gl)$/;

export function canonicalizeUrl(rawUrl: string): string {
  let normalized = rawUrl;
  if (!/^https?:\/\//i.test(normalized)) normalized = "https://" + normalized;

  const u = new URL(normalized);

  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");

  const keysToDelete: string[] = [];
  for (const key of u.searchParams.keys()) {
    if (TRACKING_PARAMS.test(key)) keysToDelete.push(key);
  }
  for (const key of keysToDelete) u.searchParams.delete(key);

  u.searchParams.sort();
  u.hash = "";

  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.slice(0, -1);
  }

  return u.toString();
}

// ─── Cache Key Derivation ───────────────────────────────────────────────────

function slugify(input: string): string {
  let slug = input
    .replace(/^\//, "")
    .replace(/\//g, "_")
    .replace(/[^a-z0-9_-]/gi, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

  if (slug.length > 80) slug = slug.slice(0, 80);
  return slug;
}

export function cacheKeyForUrl(rawUrl: string): {
  domain: string;
  dirName: string;
  canonicalUrl: string;
} {
  const canonicalUrl = canonicalizeUrl(rawUrl);
  const u = new URL(canonicalUrl);
  const domain = u.hostname;
  const slug = slugify(u.pathname + u.search);
  const hash = createHash("sha256")
    .update(canonicalUrl)
    .digest("hex")
    .slice(0, 8);
  const dirName = slug ? `${slug}_${hash}` : `_root_${hash}`;

  return { domain, dirName, canonicalUrl };
}

// ─── Cache Operations ───────────────────────────────────────────────────────

export function pageDir(rawUrl: string): string {
  const { domain, dirName } = cacheKeyForUrl(rawUrl);
  return join(WEB_CACHE_DIR, domain, dirName);
}

export function isPageCached(rawUrl: string): boolean {
  return existsSync(join(pageDir(rawUrl), "content.md"));
}

export function loadCachedPage(
  rawUrl: string,
): { content: string; meta: PageMeta } | null {
  const dir = pageDir(rawUrl);
  const contentPath = join(dir, "content.md");
  const metaPath = join(dir, "meta.json");
  if (!existsSync(contentPath)) return null;

  const content = readFileSync(contentPath, "utf-8");
  let meta: PageMeta | null = null;
  if (existsSync(metaPath)) {
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf-8")) as PageMeta;
    } catch {
      // corrupted meta — still return content
    }
  }

  return meta ? { content, meta } : null;
}

export function savePage(
  rawUrl: string,
  title: string,
  markdownContent: string,
): string {
  const { domain, dirName, canonicalUrl } = cacheKeyForUrl(rawUrl);
  const dir = join(WEB_CACHE_DIR, domain, dirName);
  mkdirSync(dir, { recursive: true });

  const header = `# ${title}\n\n- **URL:** ${rawUrl}\n- **Cached:** ${new Date().toISOString()}\n\n---\n\n`;
  writeFileSync(join(dir, "content.md"), header + markdownContent);

  const meta: PageMeta = {
    url: rawUrl,
    canonicalUrl,
    title,
    domain,
    cachedAt: new Date().toISOString(),
    contentChars: markdownContent.length,
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));

  return dir;
}

export function listCachedPages(): CachedPage[] {
  if (!existsSync(WEB_CACHE_DIR)) return [];

  const pages: CachedPage[] = [];
  const domains = readdirSync(WEB_CACHE_DIR, { withFileTypes: true });

  for (const domainEntry of domains) {
    if (!domainEntry.isDirectory()) continue;
    const domainPath = join(WEB_CACHE_DIR, domainEntry.name);
    const slugs = readdirSync(domainPath, { withFileTypes: true });

    for (const slugEntry of slugs) {
      if (!slugEntry.isDirectory()) continue;
      const metaPath = join(domainPath, slugEntry.name, "meta.json");
      if (!existsSync(metaPath)) continue;

      try {
        const meta = JSON.parse(
          readFileSync(metaPath, "utf-8"),
        ) as PageMeta;
        pages.push({
          domain: domainEntry.name,
          slug: slugEntry.name,
          title: meta.title,
          url: meta.url,
          cachedAt: meta.cachedAt,
          contentChars: meta.contentChars,
        });
      } catch {
        // Skip corrupted entries
      }
    }
  }

  return pages;
}
