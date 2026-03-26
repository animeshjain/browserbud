import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";

if (!process.env.BROWSERBUD_PORT) {
  throw new Error("BROWSERBUD_PORT environment variable is not set");
}
const SERVER_URL = `http://localhost:${process.env.BROWSERBUD_PORT}`;
const DATA_DIR = process.env.BROWSERBUD_DATA_DIR || join(process.env.HOME || "~", "browse");
const CONTEXT_DIR = join(DATA_DIR, "context");

// --- Core operations ---

async function readCommand(maxChars: number): Promise<void> {
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

  const data = await res.json() as {
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
  const url = data.url || "";

  // Truncate if needed
  const truncated = content.length > maxChars;
  const text = truncated ? content.slice(0, maxChars) : content;

  // Save to context directory
  const outPath = join(CONTEXT_DIR, "page-content.txt");
  mkdirSync(CONTEXT_DIR, { recursive: true });

  const output = `# ${title}\nURL: ${url}\n\n${text}${truncated ? `\n\n[Truncated at ${maxChars} chars — ${content.length} total]` : ""}`;
  writeFileSync(outPath, output);

  console.log(`Title: ${title}`);
  console.log(`URL:   ${url}`);
  console.log(`Size:  ${content.length} chars${truncated ? ` (truncated to ${maxChars})` : ""}`);
  console.log(`\nSaved to: ${outPath}`);
}

async function showCommand(): Promise<void> {
  const filePath = join(CONTEXT_DIR, "page-content.txt");
  if (!existsSync(filePath)) {
    console.error("No page content cached. Run `read` first.");
    process.exit(1);
  }
  console.log(readFileSync(filePath, "utf-8"));
}

// --- CLI ---

function printUsage(): void {
  console.log(`Usage: npm run --prefix skills/page-reader cli -- <command> [options]

Commands:
  read [--max-chars <n>]   Extract content from the active browser tab
  show                     Display the last extracted page content

Read options:
  --max-chars <n>          Maximum characters to extract (default: 50000)

Examples:
  npm run --prefix skills/page-reader cli -- read
  npm run --prefix skills/page-reader cli -- read --max-chars 20000
  npm run --prefix skills/page-reader cli -- show
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
        await readCommand(maxChars);
        break;
      }

      case "show": {
        await showCommand();
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
