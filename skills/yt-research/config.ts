import { config } from "dotenv";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load root .env first (has all config), then skill .env as fallback for standalone dev
config({ path: join(__dirname, "..", "..", ".env") });
config({ path: join(__dirname, ".env") });

export const SUPADATA_API_KEY = process.env.SUPADATA_API_KEY || "";
export const SCRAPECREATORS_API_KEY = process.env.SCRAPECREATORS_API_KEY || "";
const DATA_DIR = process.env.BROWSERBUD_DATA_DIR;
export const OUTPUT_DIR = DATA_DIR ? join(DATA_DIR, "cache") : join(__dirname, "output");
export const VIDEOS_DIR = DATA_DIR ? join(DATA_DIR, "cache", "youtube") : join(__dirname, "output", "videos");

// Supadata request timeout
export const REQUEST_TIMEOUT_MS = 65_000;

// Minimum words-per-minute threshold for "suspiciously short" detection
// Normal speech is 120-180 WPM; set conservatively low
export const MIN_WPM = 30;

// Server URL for client-side transcript extraction via the browser extension
export const BROWSERBUD_SERVER_URL =
  process.env.BROWSERBUD_SERVER_URL || "http://localhost:8080";
