import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import {
  isPageCached,
  loadCachedPage,
  savePage,
  pageDir,
  listCachedPages,
} from "./cache.js";

if (!process.env.BROWSERBUD_PORT) {
  throw new Error("BROWSERBUD_PORT environment variable is not set");
}
const SERVER_URL = `http://localhost:${process.env.BROWSERBUD_PORT}`;
const DATA_DIR =
  process.env.BROWSERBUD_DATA_DIR ||
  join(process.env.HOME || "~", "browse");

// --- Helpers ---

function currentContextUrl(): string | undefined {
  const contextPath = join(DATA_DIR, "context", "current.json");
  if (!existsSync(contextPath)) return undefined;
  try {
    const ctx = JSON.parse(readFileSync(contextPath, "utf-8"));
    return ctx.url || undefined;
  } catch {
    return undefined;
  }
}

// --- Core operations ---

async function readCommand(
  maxChars: number,
  force: boolean,
  targetUrl?: string,
): Promise<void> {
  const knownUrl = targetUrl || currentContextUrl();

  // Check cache (unless --force)
  if (!force && knownUrl && isPageCached(knownUrl)) {
    const dir = pageDir(knownUrl);
    console.log(`Already cached: ${dir}/content.md`);
    console.log(`Use --force to re-fetch.`);
    return;
  }

  console.log("Requesting page content from browser...");

  const res = await fetch(`${SERVER_URL}/api/extract-page-content`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Server error (${res.status}): ${body}`);
    process.exit(1);
  }

  const data = (await res.json()) as {
    ok: boolean;
    content?: string;
    title?: string;
    url?: string;
    error?: string;
  };

  if (!data.ok) {
    console.error(`Extraction failed: ${data.error || "unknown error"}`);
    process.exit(1);
  }

  const content = data.content || "";
  const title = data.title || "";
  const url = data.url || knownUrl || "";

  // Truncate if needed
  const truncated = content.length > maxChars;
  const text = truncated ? content.slice(0, maxChars) : content;
  const truncationNote = truncated
    ? `\n\n[Truncated at ${maxChars} chars — ${content.length} total]`
    : "";

  // Save to cache
  const cacheDir = savePage(url, title, text + truncationNote);

  console.log(`Title: ${title}`);
  console.log(`URL:   ${url}`);
  console.log(
    `Size:  ${content.length} chars${truncated ? ` (truncated to ${maxChars})` : ""}`,
  );
  console.log(`\nSaved to: ${cacheDir}/`);
}

async function showCommand(targetUrl?: string): Promise<void> {
  const url = targetUrl || currentContextUrl();

  if (!url) {
    console.error(
      "No URL specified and no current context. Usage: show [--url <url>]",
    );
    process.exit(1);
  }

  const cached = loadCachedPage(url);
  if (!cached) {
    console.error(`No cached content for ${url}. Run \`read\` first.`);
    process.exit(1);
  }

  console.log(cached.content);
}

function listCommand(): void {
  const pages = listCachedPages();

  if (pages.length === 0) {
    console.log("No cached pages.");
    return;
  }

  console.log(`Cached pages (${pages.length}):\n`);
  for (const p of pages) {
    const title =
      p.title.length > 60 ? p.title.slice(0, 57) + "..." : p.title;
    console.log(`  ${p.domain}/${p.slug}/`);
    console.log(`    ${title}`);
    console.log(`    ${p.url}  (${p.contentChars} chars, ${p.cachedAt})`);
    console.log();
  }
}

// --- CLI ---

function printUsage(): void {
  console.log(`Usage: npm run --prefix skills/page-reader cli -- <command> [options]

Commands:
  read [options]             Extract content from the active browser tab
  show [--url <url>]         Display cached page content
  list                       List all cached pages

Read options:
  --max-chars <n>            Maximum characters to extract (default: 50000)
  --force                    Re-fetch even if cached
  --url <url>                Read a specific URL (default: current tab)

Examples:
  npm run --prefix skills/page-reader cli -- read
  npm run --prefix skills/page-reader cli -- read --force
  npm run --prefix skills/page-reader cli -- read --url "https://example.com/page"
  npm run --prefix skills/page-reader cli -- show
  npm run --prefix skills/page-reader cli -- list
`);
}

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

// --- Entry point ---

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("page-reader/index.ts");

if (isMain) {
  const [subcommand, ...rest] = process.argv.slice(2);
  const { flags } = parseArgs(rest);

  (async () => {
    switch (subcommand) {
      case "read": {
        const maxChars = parseInt(flags["max-chars"] || "50000", 10);
        const force = flags.force === "true";
        const url = flags.url;
        await readCommand(maxChars, force, url);
        break;
      }

      case "show": {
        await showCommand(flags.url);
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
