/**
 * Transcript fetching with Supadata primary + ScrapeCreators fallback.
 *
 * Fallback triggers when Supadata returns empty or suspiciously short text.
 */

import { Supadata } from "@supadata/js";
import {
  SUPADATA_API_KEY,
  SCRAPECREATORS_API_KEY,
  REQUEST_TIMEOUT_MS,
  MIN_WPM,
  BROWSERBUD_SERVER_URL,
} from "./config.js";
import type { TranscriptResult } from "./types.js";

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function isSuspiciouslyShort(
  text: string,
  durationSeconds: number | null,
): boolean {
  if (!durationSeconds || durationSeconds <= 0) return false;
  const wordCount = countWords(text);
  const expectedMin = (durationSeconds / 60) * MIN_WPM;
  return wordCount < expectedMin;
}

// --- Client-side extraction via browser extension ---

async function fetchFromClient(videoId: string): Promise<TranscriptResult> {
  const response = await fetch(`${BROWSERBUD_SERVER_URL}/api/extract-transcript`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId }),
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Client extraction failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    ok: boolean;
    text?: string;
    lang?: string;
    error?: string;
  };
  if (!data.ok) {
    throw new Error(data.error || "Client extraction returned not-ok");
  }

  return {
    text: data.text || "",
    lang: data.lang || null,
    source: "client",
  };
}

// --- Supadata ---

async function fetchFromSupadata(videoId: string): Promise<TranscriptResult> {
  if (!SUPADATA_API_KEY) {
    throw new Error("SUPADATA_API_KEY not set");
  }

  const client = new Supadata({ apiKey: SUPADATA_API_KEY });

  const result = await withTimeout(
    client.transcript({
      url: `https://www.youtube.com/watch?v=${videoId}`,
      text: true,
    }),
    REQUEST_TIMEOUT_MS,
    `Supadata request timed out after ${REQUEST_TIMEOUT_MS / 1000}s for ${videoId}`,
  );

  // Handle async job polling (videos >20 min trigger async generation)
  let transcript: { content: string | Array<{ text: string }> };

  if ("jobId" in result) {
    const jobId = (result as { jobId: string }).jobId;
    console.log(`  Async job started: ${jobId}, polling...`);
    const delayMs = 2500;
    const maxAttempts = Math.ceil((300 * 1000) / delayMs); // 5 min max

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const jobResult = await client.transcript.getJobStatus(jobId);
      if (jobResult.status === "completed" && jobResult.result) {
        transcript = jobResult.result;
        break;
      }
      if (jobResult.status === "failed") {
        throw new Error(
          `Supadata job failed: ${jobResult.error?.message || "unknown"}`,
        );
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
    if (!transcript!) {
      throw new Error(`Supadata job timed out for ${videoId}`);
    }
  } else {
    transcript = result;
  }

  const text =
    typeof transcript.content === "string"
      ? transcript.content
      : transcript.content.map((c) => c.text).join(" ").trim();

  return { text, lang: null, source: "supadata" };
}

// --- ScrapeCreators ---

interface ScrapeCreatorsResponse {
  videoId: string;
  transcript: Array<{ text: string; startMs: string; endMs: string }>;
  transcript_only_text: string;
  language?: string;
}

async function fetchFromScrapeCreators(
  videoId: string,
): Promise<TranscriptResult> {
  if (!SCRAPECREATORS_API_KEY) {
    throw new Error("SCRAPECREATORS_API_KEY not set");
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const url = `https://api.scrapecreators.com/v1/youtube/video/transcript?url=${encodeURIComponent(videoUrl)}`;

  const response = await fetch(url, {
    headers: { "x-api-key": SCRAPECREATORS_API_KEY },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `ScrapeCreators API error: ${response.status} ${response.statusText} — ${body.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as ScrapeCreatorsResponse;

  return {
    text: data.transcript_only_text || "",
    lang: data.language || null,
    source: "scrapecreators",
  };
}

// --- Chain: Supadata → ScrapeCreators fallback ---

export async function fetchTranscript(
  videoId: string,
  durationSeconds: number | null = null,
): Promise<TranscriptResult> {
  const providers: Array<{
    name: string;
    fn: () => Promise<TranscriptResult>;
  }> = [
    { name: "client", fn: () => fetchFromClient(videoId) },
    { name: "supadata", fn: () => fetchFromSupadata(videoId) },
  ];

  if (SCRAPECREATORS_API_KEY) {
    providers.push({
      name: "scrapecreators",
      fn: () => fetchFromScrapeCreators(videoId),
    });
  }

  const errors: string[] = [];
  let suspiciousFallback: TranscriptResult | null = null;

  for (const provider of providers) {
    try {
      console.log(`  Trying ${provider.name}...`);
      const result = await provider.fn();
      const text = result.text.trim();

      if (text.length === 0) {
        const msg = `${provider.name} returned empty transcript`;
        console.log(`  ${msg}`);
        errors.push(msg);
        continue;
      }

      if (isSuspiciouslyShort(text, durationSeconds)) {
        const wordCount = countWords(text);
        const expectedMin = Math.round(
          (durationSeconds! / 60) * MIN_WPM,
        );
        const msg = `${provider.name} returned suspiciously short transcript: ${wordCount} words (expected >= ${expectedMin})`;
        console.log(`  ${msg}`);
        errors.push(msg);
        if (!suspiciousFallback) suspiciousFallback = result;
        continue;
      }

      if (provider !== providers[0]) {
        console.log(`  Fallback success via ${provider.name}`);
      }
      return result;
    } catch (err) {
      const msg = `${provider.name}: ${err instanceof Error ? err.message : String(err)}`;
      console.log(`  ${msg}`);
      errors.push(msg);
    }
  }

  // Use suspicious result as last resort
  if (suspiciousFallback) {
    console.log(`  Using suspicious fallback (better than nothing)`);
    return suspiciousFallback;
  }

  throw new Error(
    `All transcript providers failed for ${videoId}: ${errors.join(" | ")}`,
  );
}
