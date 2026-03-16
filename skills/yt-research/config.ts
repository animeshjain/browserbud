import { config } from "dotenv";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from skill directory
config({ path: join(__dirname, ".env") });

export const SUPADATA_API_KEY = process.env.SUPADATA_API_KEY || "";
export const SCRAPECREATORS_API_KEY = process.env.SCRAPECREATORS_API_KEY || "";
export const OUTPUT_DIR = join(__dirname, "output");
export const VIDEOS_DIR = join(OUTPUT_DIR, "videos");

// Supadata request timeout
export const REQUEST_TIMEOUT_MS = 65_000;

// Minimum words-per-minute threshold for "suspiciously short" detection
// Normal speech is 120-180 WPM; set conservatively low
export const MIN_WPM = 30;
