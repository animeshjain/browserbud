/**
 * Extract a YouTube video ID from various URL formats.
 *
 * Supports:
 *   https://www.youtube.com/watch?v=VIDEO_ID
 *   https://youtu.be/VIDEO_ID
 *   https://youtube.com/shorts/VIDEO_ID
 *   https://www.youtube.com/embed/VIDEO_ID
 *   https://www.youtube.com/live/VIDEO_ID
 *   bare VIDEO_ID (11-char alphanumeric)
 */
export function extractVideoId(input: string): string {
  input = input.trim();

  // youtu.be short links
  const shortMatch = input.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (shortMatch) return shortMatch[1];

  // youtube.com/watch?v=
  const watchMatch = input.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (watchMatch) return watchMatch[1];

  // youtube.com/shorts/ or /embed/ or /live/
  const pathMatch = input.match(/youtube\.com\/(?:shorts|embed|live)\/([a-zA-Z0-9_-]{11})/);
  if (pathMatch) return pathMatch[1];

  // Bare video ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;

  throw new Error(
    `Cannot extract video ID from: "${input}". Pass a YouTube URL or 11-character video ID.`,
  );
}
